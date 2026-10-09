/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Solves for target 2D position and optional bias using Gauss-Newton.
 *
 * <p>
 * Performs non-linear least squares optimization over ranging circles from
 * known positions, supporting optional range bias estimation.
 * </p>
 *
 * @param {!Array<!Object>} points Array of base points with x, y, range, and
 *     optional weight.
 * @param {?Object=} initGuess Optional initial coordinate and bias guess.
 * @return {?{x: number, y: number, bias: number, err: number, count: number}}
 *     Estimated target solution, or null if optimization fails.
 */
window.solveGaussNewton = function solveGaussNewton(points, initGuess) {
  const validPoints = points.filter(p => p.range > 0 && !isNaN(p.range));
  if (validPoints.length < 3) return null; // Need at least 3 contributing circles for a fix
  
  const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
  const solveBias = (rangeBiasMode === 'auto');
  
  let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
  if (isNaN(scaleRange) || scaleRange <= 0) {
    scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
  }

  if (solveBias && validPoints.length < 3) return null; 

  console.log("solveGaussNewton points:", validPoints.map(p => ({step: p.step, range: p.range, weight: p.weight})), "solveBias:", solveBias);

  let Tx = 0, Ty = 0, Tb = 0;
  if (initGuess && typeof initGuess.x === 'number' && !isNaN(initGuess.x) && typeof initGuess.y === 'number' && !isNaN(initGuess.y)) {
    Tx = initGuess.x;
    Ty = initGuess.y;
    Tb = typeof initGuess.bias === 'number' && !isNaN(initGuess.bias) ? initGuess.bias : 0.0;
  } else {
    const initMode = window.ngInitMode || 'first';
    if (initMode === 'first') {
      Tx = validPoints[0].x + 0.1;
      Ty = validPoints[0].y + 0.1;
    } else if (initMode === 'centroid') {
      let sumX = 0, sumY = 0;
      points.forEach(p => {
        sumX += p.x;
        sumY += p.y;
      });
      Tx = sumX / points.length + 0.1;
      Ty = sumY / points.length + 0.1;
    } else if (initMode === 'last') {
      Tx = validPoints[validPoints.length - 1].x + 0.1;
      Ty = validPoints[validPoints.length - 1].y + 0.1;
    } else if (initMode === 'lls') {
      let M11 = 0, M12 = 0, M22 = 0;
      let v1 = 0, v2 = 0;
      const p0 = validPoints[0];
      const x0 = p0.x, y0 = p0.y, r0 = p0.range;

      for (let i = 1; i < validPoints.length; i++) {
        const pi = validPoints[i];
        const xi = pi.x, yi = pi.y, ri = pi.range;

        const A0 = 2 * (x0 - xi);
        const A1 = 2 * (y0 - yi);
        const b = (ri * ri - r0 * r0) - (xi * xi - x0 * x0) - (yi * yi - y0 * y0);

        const w = pi.weight !== undefined ? pi.weight : 1.0;
        M11 += w * A0 * A0;
        M12 += w * A0 * A1;
        M22 += w * A1 * A1;

        v1 += w * A0 * b;
        v2 += w * A1 * b;
      }

      const det = M11 * M22 - M12 * M12;
      if (Math.abs(det) < 1e-9) {
        Tx = x0 + 0.1;
        Ty = y0 + 0.1;
      } else {
        Tx = (v1 * M22 - v2 * M12) / det;
        Ty = (M11 * v2 - M12 * v1) / det;
      }
    }
  }

  if (solveBias) {
    // PASS 1: 3-State NG solver for (Tx, Ty, Tb)
    const maxIter3 = 30;
    for (let iter = 0; iter < maxIter3; iter++) {
      let A11 = 0, A12 = 0, A13 = 0;
      let A22 = 0, A23 = 0, A33 = 0;
      let b1 = 0, b2 = 0, b3 = 0;

      validPoints.forEach(p => {
        let dx = Tx - p.x;
        let dy = Ty - p.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-6) dist = 1e-6;

        const residual = dist + Tb - p.range;
        const J1 = dx / dist;
        const J2 = dy / dist;
        const J3 = 1.0;

        const w = p.weight !== undefined ? p.weight : 1.0;
        A11 += J1 * w * J1;
        A12 += J1 * w * J2;
        A13 += J1 * w * J3;
        
        A22 += J2 * w * J2;
        A23 += J2 * w * J3;
        
        A33 += J3 * w * J3;

        b1 += -J1 * w * residual;
        b2 += -J2 * w * residual;
        b3 += -J3 * w * residual;
      });

      const lambda = 1e-4;
      A11 += lambda;
      A22 += lambda;
      A33 += lambda;

      // 3x3 Determinant
      const det = A11 * (A22 * A33 - A23 * A23) - A12 * (A12 * A33 - A23 * A13) + A13 * (A12 * A23 - A22 * A13);
      if (isNaN(det) || !isFinite(det) || Math.abs(det) < 1e-12) break;

      // 3x3 Adjugate cofactors
      const C11 = A22 * A33 - A23 * A23;
      const C12 = A13 * A23 - A12 * A33;
      const C13 = A12 * A23 - A22 * A13;
      
      const C22 = A11 * A33 - A13 * A13;
      const C23 = A12 * A13 - A11 * A23;
      
      const C33 = A11 * A22 - A12 * A12;

      const deltaTx = (C11 * b1 + C12 * b2 + C13 * b3) / det;
      const deltaTy = (C12 * b1 + C22 * b2 + C23 * b3) / det;
      const deltaTb = (C13 * b1 + C23 * b2 + C33 * b3) / det;

      if (isNaN(deltaTx) || isNaN(deltaTy) || isNaN(deltaTb) || !isFinite(deltaTx) || !isFinite(deltaTy) || !isFinite(deltaTb)) break;

      Tx += deltaTx;
      Ty += deltaTy;
      Tb += deltaTb;

      if (Math.sqrt(deltaTx * deltaTx + deltaTy * deltaTy + deltaTb * deltaTb) < 1e-5) {
        break;
      }
    }

    if (isNaN(Tx) || isNaN(Ty) || isNaN(Tb) || !isFinite(Tx) || !isFinite(Ty) || !isFinite(Tb)) return null;

    // PASS 2 & 3: Remove converged bias and run 2-State NG for position.
    const solvedBias = Tb;
    const biasAdjustedPoints = validPoints.map(p => ({
      ...p,
      range: p.range - solvedBias
    }));

    const maxIter2 = 30;
    for (let iter = 0; iter < maxIter2; iter++) {
      let A11 = 0, A12 = 0, A22 = 0;
      let b1 = 0, b2 = 0;

      biasAdjustedPoints.forEach(p => {
        let dx = Tx - p.x;
        let dy = Ty - p.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-6) dist = 1e-6;

        const residual = dist - p.range;
        const J1 = dx / dist;
        const J2 = dy / dist;

        const w = p.weight !== undefined ? p.weight : 1.0;
        A11 += J1 * w * J1;
        A12 += J1 * w * J2;
        A22 += J2 * w * J2;

        b1 += -J1 * w * residual;
        b2 += -J2 * w * residual;
      });

      const lambda = 1e-4;
      A11 += lambda;
      A22 += lambda;

      const det = A11 * A22 - A12 * A12;
      if (isNaN(det) || !isFinite(det) || Math.abs(det) < 1e-12) break;

      const deltaTx = (b1 * A22 - b2 * A12) / det;
      const deltaTy = (A11 * b2 - A12 * b1) / det;

      if (isNaN(deltaTx) || isNaN(deltaTy) || !isFinite(deltaTx) || !isFinite(deltaTy)) break;

      Tx += deltaTx;
      Ty += deltaTy;

      if (Math.sqrt(deltaTx * deltaTx + deltaTy * deltaTy) < 1e-5) {
        break;
      }
    }

    if (isNaN(Tx) || isNaN(Ty) || !isFinite(Tx) || !isFinite(Ty)) return null;

    let sumSqErr = 0;
    biasAdjustedPoints.forEach(p => {
      let dx = Tx - p.x;
      let dy = Ty - p.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      let err = dist - p.range;
      sumSqErr += err * err;
    });

    const rms = Math.sqrt(sumSqErr / biasAdjustedPoints.length);
    if (isNaN(rms) || !isFinite(rms)) return null;

    console.log("solveGaussNewton 3-State -> 2-State Pass Finished. Bias:", solvedBias, "Tx:", Tx, "Ty:", Ty, "RMS:", rms);
    return { x: Tx, y: Ty, bias: solvedBias / scaleRange, err: rms, count: biasAdjustedPoints.length };

  } else {
    // Standalone 2-State NG Pass
    const maxIter = 30;
    for (let iter = 0; iter < maxIter; iter++) {
      let A11 = 0, A12 = 0, A22 = 0;
      let b1 = 0, b2 = 0;

      validPoints.forEach(p => {
        let dx = Tx - p.x;
        let dy = Ty - p.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-6) dist = 1e-6;

        const residual = dist - p.range;
        const J1 = dx / dist;
        const J2 = dy / dist;

        const w = p.weight !== undefined ? p.weight : 1.0;
        A11 += J1 * w * J1;
        A12 += J1 * w * J2;
        A22 += J2 * w * J2;

        b1 += -J1 * w * residual;
        b2 += -J2 * w * residual;
      });

      const lambda = 1e-4;
      A11 += lambda;
      A22 += lambda;

      const det = A11 * A22 - A12 * A12;
      if (isNaN(det) || !isFinite(det) || Math.abs(det) < 1e-12) break;

      const deltaTx = (b1 * A22 - b2 * A12) / det;
      const deltaTy = (A11 * b2 - A12 * b1) / det;

      if (isNaN(deltaTx) || isNaN(deltaTy) || !isFinite(deltaTx) || !isFinite(deltaTy)) break;

      Tx += deltaTx;
      Ty += deltaTy;

      if (Math.sqrt(deltaTx * deltaTx + deltaTy * deltaTy) < 1e-5) {
        break;
      }
    }

    if (isNaN(Tx) || isNaN(Ty) || !isFinite(Tx) || !isFinite(Ty)) return null;

    let sumSqErr = 0;
    validPoints.forEach(p => {
      let dx = Tx - p.x;
      let dy = Ty - p.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      let err = dist - p.range;
      sumSqErr += err * err;
    });

    const rms = Math.sqrt(sumSqErr / validPoints.length);
    if (isNaN(rms) || !isFinite(rms)) return null;

    return { x: Tx, y: Ty, bias: 0.0, err: rms, count: validPoints.length };
  }
};
