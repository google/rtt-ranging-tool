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
 * Prunes data points by dividing them into 4 chronological buckets.
 *
 * <p>
 * Keeps the best-fitting fraction in each bucket based on range residuals.
 * </p>
 *
 * @param {!Array<!Object>} validPoints Array of points with coordinates and
 *     ranges.
 * @param {!Object} T Current target estimate with x, y, and optional bias.
 * @param {number} keepRatio Fraction of points to keep in each bucket (0 to 1).
 * @return {!Array<!Object>} Filtered array of kept points.
 */
function pruneChronologicalBuckets(validPoints, T, keepRatio) {
  if (!T || isNaN(T.x) || isNaN(T.y)) return [];
  const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
  let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
  if (isNaN(scaleRange) || scaleRange <= 0) {
    scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
  }
  const bias = (rangeBiasMode === 'auto' && T && typeof T.bias === 'number' && !isNaN(T.bias)) ? T.bias * scaleRange : 0.0;
  const pointsWithResiduals = validPoints.map(p => {
    const dx = T.x - p.x;
    const dy = T.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let residual = Math.abs(dist + bias - p.range);
    if (isNaN(residual) || !isFinite(residual)) residual = Infinity;
    return { ...p, residual };
  }).filter(p => isFinite(p.residual));

  const N = pointsWithResiduals.length;
  const b1_end = Math.floor(N / 4);
  const b2_end = Math.floor(N / 2);
  const b3_end = Math.floor(3 * N / 4);

  const buckets = [
    pointsWithResiduals.slice(0, b1_end),
    pointsWithResiduals.slice(b1_end, b2_end),
    pointsWithResiduals.slice(b2_end, b3_end),
    pointsWithResiduals.slice(b3_end, N)
  ];

  const keptPoints = [];
  buckets.forEach(bucket => {
    if (bucket.length === 0) return;
    const sortedBucket = [...bucket].sort((a, b) => a.residual - b.residual);
    const K = Math.floor(bucket.length * keepRatio);
    const countToKeep = Math.max(K, keepRatio > 0 ? 1 : 0);
    for (let i = 0; i < countToKeep && i < sortedBucket.length; i++) {
      if (sortedBucket[i] && isFinite(sortedBucket[i].residual)) {
         keptPoints.push(sortedBucket[i]);
      }
    }
  });

  return keptPoints;
}

/**
 * Solves for target position using 4-stage cascaded Gauss-Newton optimization.
 *
 * <p>
 * Prunes outliers using chronological bucket residuals across stages.
 * </p>
 *
 * @param {!Array<!Object>} basePointsWithCoords Array of points with
 *     coordinates and ranges.
 * @return {?{target: !Object, keptPoints: !Array<!Object>}} Optimization result
 *     or null.
 */
function solveCascadedNG(basePointsWithCoords) {
  const validPoints = basePointsWithCoords.filter(p => p.range > 0 && !isNaN(p.range));
  if (validPoints.length < 4) return null;

  const res1 = window.solveGaussNewton(validPoints);
  if (!res1 || isNaN(res1.x) || isNaN(res1.y) || isNaN(res1.err)) return null;

  const kept2 = pruneChronologicalBuckets(validPoints, res1, 0.90);
  if (kept2.length < 3) return null;
  const res2 = window.solveGaussNewton(kept2, res1);
  if (!res2 || isNaN(res2.x) || isNaN(res2.y) || isNaN(res2.err)) return null;

  const kept3 = pruneChronologicalBuckets(validPoints, res2, 0.80);
  if (kept3.length < 3) return null;
  const res3 = window.solveGaussNewton(kept3, res2);
  if (!res3 || isNaN(res3.x) || isNaN(res3.y) || isNaN(res3.err)) return null;

  const kept4 = pruneChronologicalBuckets(validPoints, res3, 0.75);
  if (kept4.length < 3) return null;
  const res4 = window.solveGaussNewton(kept4, res3);
  if (!res4 || isNaN(res4.x) || isNaN(res4.y) || isNaN(res4.err) || res4.err <= 0) return null;

  return {
    target: res4,
    keptPoints: kept4
  };
}

/**
 * Calibrates step length L using gradient descent on target residuals.
 *
 * <p>
 * Optimizes step length against spatial RANSAC and Gauss-Newton residuals.
 * </p>
 *
 * @param {!Array<!Object>} S_base Array of base points with unitX, unitY, and
 *     range.
 * @param {number} initialL Initial step length estimate in meters.
 * @param {number} pd Finite difference delta for step length gradient.
 * @param {number} gamma Learning rate for gradient descent.
 * @param {number} maxIter Maximum number of gradient descent iterations.
 * @param {number} tol Convergence tolerance for step length update.
 * @param {boolean} useRansac Whether to use cascaded RANSAC pruning.
 * @param {boolean} useStepCalib Whether to calibrate step length or keep
 *     initialL.
 * @return {{L: number, target: ?Object, keptSteps: !Array<number>,
 *     rms: number}} Calibration result.
 */
function calibrateStepLengthSpatialRansac(S_base, initialL, pd, gamma, maxIter, tol, useRansac, useStepCalib) {
  let L = initialL;
  let finalTarget = null;
  let finalKeptSteps = [];
  let finalRms = Infinity;

  const solveFn = useRansac ? solveCascadedNG : (pts) => {
    const res = window.solveGaussNewton(pts);
    if (!res || isNaN(res.x) || isNaN(res.y) || isNaN(res.err)) return null;
    return { target: res, keptPoints: pts };
  };

  const MIN_POINTS_FOR_GD = useRansac ? 12 : 4; 

  if (S_base.length < MIN_POINTS_FOR_GD || !useStepCalib) {
    const S_final = S_base.map(p => ({ ...p, x: L * p.unitX, y: L * p.unitY }));
    const cascade_final = solveFn(S_final);
    if (cascade_final && cascade_final.target) {
      finalTarget = cascade_final.target;
      finalKeptSteps = cascade_final.keptPoints.map(p => p.step);
      finalRms = cascade_final.target.err;
    }
    return {
      L: L,
      target: finalTarget,
      keptSteps: finalKeptSteps,
      rms: finalRms
    };
  }

  const minL = Math.max(0.45, initialL - 0.15);
  const maxL = Math.min(0.95, initialL + 0.15);

  for (let iter = 0; iter < maxIter; iter++) {
    const L_plus = Math.max(minL, Math.min(maxL, L + pd));
    const S_plus = S_base.map(p => ({ ...p, x: L_plus * p.unitX, y: L_plus * p.unitY }));
    const cascade_plus = solveFn(S_plus);
    
    const L_minus = Math.max(minL, Math.min(maxL, L - pd));
    const S_minus = S_base.map(p => ({ ...p, x: L_minus * p.unitX, y: L_minus * p.unitY }));
    const cascade_minus = solveFn(S_minus);

    if (!cascade_plus || !cascade_minus || isNaN(cascade_plus.target.err) || isNaN(cascade_minus.target.err)) {
      break;
    }

    const rms_plus = cascade_plus.target.err;
    const rms_minus = cascade_minus.target.err;

    const deriv = (rms_plus - rms_minus) / (2 * pd);
    if (isNaN(deriv) || !isFinite(deriv)) {
      break;
    }

    const max_dL = 0.03;
    let dL = - gamma * deriv;
    if (isNaN(dL) || !isFinite(dL)) {
      break;
    }
    dL = Math.max(-max_dL, Math.min(max_dL, dL));

    if (Math.abs(dL) < tol) {
      L = L + dL;
      L = Math.max(minL, Math.min(maxL, L));
      const S_final = S_base.map(p => ({ ...p, x: L * p.unitX, y: L * p.unitY }));
      const cascade_final = solveFn(S_final);
      if (cascade_final && cascade_final.target && isFinite(cascade_final.target.err) && cascade_final.target.err > 0) {
        finalTarget = cascade_final.target;
        finalKeptSteps = cascade_final.keptPoints.map(p => p.step);
        finalRms = cascade_final.target.err;
      }
      break;
    }

    L = L + dL;
    L = Math.max(minL, Math.min(maxL, L));

    if (iter === maxIter - 1) {
      const S_final = S_base.map(p => ({ ...p, x: L * p.unitX, y: L * p.unitY }));
      const cascade_final = solveFn(S_final);
      if (cascade_final && cascade_final.target && isFinite(cascade_final.target.err) && cascade_final.target.err > 0) {
        finalTarget = cascade_final.target;
        finalKeptSteps = cascade_final.keptPoints.map(p => p.step);
        finalRms = cascade_final.target.err;
      }
    }
  }

  if (!finalTarget) {
     L = initialL;
     const S_final = S_base.map(p => ({ ...p, x: L * p.unitX, y: L * p.unitY }));
     const cascade_final = solveFn(S_final);
     if (cascade_final && cascade_final.target && isFinite(cascade_final.target.err) && cascade_final.target.err > 0) {
       finalTarget = cascade_final.target;
       finalKeptSteps = cascade_final.keptPoints.map(p => p.step);
       finalRms = cascade_final.target.err;
     }
  }

  return {
    L: L,
    target: finalTarget,
    keptSteps: finalKeptSteps,
    rms: finalRms
  };
}

/**
 * Draws the RTT Ranging Tool plot on the specified canvas.
 *
 * <p>
 * Renders PDR trajectories, target positions, ground truth, ranging circles,
 * and error vectors for the selected playback step window.
 * </p>
 *
 * @param {!HTMLCanvasElement} canvas The canvas to draw on.
 * @param {?Array<!Object>} pdrData Array of original PDR data points.
 * @param {?Array<!Object>} targetData Array of target position estimation
 *     points.
 * @param {?Array<!Object>} gtInterpolated Array of interpolated ground truth
 *     points.
 * @param {number|undefined} minStep Minimum step number in the current playback
 *     range.
 * @param {number|undefined} maxStep Maximum step number in the current playback
 *     range.
 * @param {?Array<!Object>} enhancedPdrData Array of enhanced PDR data points.
 */
window.drawPlot = function drawPlot(
    canvas, pdrData, targetData, gtInterpolated, minStep, maxStep,
    enhancedPdrData) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  
  // Reset inline styles to allow CSS to dictate size correctly before measuring
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  
  const parent = canvas.parentElement;
  const width = parent.clientWidth;
  const height = parent.clientHeight;
  
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  ctx.scale(dpr, dpr);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);

  const divInput = document.getElementById('enhanced-diversity');
  const diversityThreshold = divInput ? parseFloat(divInput.value) : 0.8;
  const ransacMode = window.ransacMode || 'none';
  const useRansac = (ransacMode === 'ransac-only' || ransacMode === 'ransac-step');
  const useStepCalib = (ransacMode === 'step-only' || ransacMode === 'ransac-step');
  const enhancedStepLengthVal = document.getElementById('enhanced-step-length')?.value || '0.67';
  
  const plotParamsStr = `${diversityThreshold}_${minStep}_${ransacMode}_${enhancedStepLengthVal}`;
  if (canvas._previousPlotParams !== plotParamsStr) {
    window.firstEnhancedCrossingStep = -1;
    canvas._previousPlotParams = plotParamsStr;
  }
  if (canvas._previousMaxStep !== undefined && maxStep < canvas._previousMaxStep) {
    window.firstEnhancedCrossingStep = -1;
  }
  canvas._previousMaxStep = maxStep;

  let foundStepEnhanced = -1;
  let foundStep = -1;

  // Store current data to redraw on click
  canvas._plotData = { pdrData, targetData, gtInterpolated, minStep, maxStep, enhancedPdrData };
  
  if (!canvas._plotState) {
    canvas._plotState = {
      showLegend: true,
      showApDirection: true,
      showPdr: true,
      showTarget: true,
      showGt: true,
      showRange: true,
      showEnhanced: true,
      showEnhancedRange: true,
      showEnhancedTarget: true,
      showPdrArrows: true,
      showEnhancedArrows: true,
      showTrueTarget: true,
      showPhoneFoundStep: true,
      showEnhancedFoundStep: true,
      showEnhancedPositionOnFound: true,
      includeFilenames: false,
      metricReference: 'Enhanced'
    };
    canvas._zoomFactor = 1.0;
    canvas._panX = 0;
    canvas._panY = 0;

    let isPanning = false;
    let startX = 0;
    let startY = 0;

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      let onLegend = false;
      if (canvas._legendBounds) {
        const b = canvas._legendBounds;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          onLegend = true;
        }
      }
      if (canvas._apDirectionBounds) {
        const b = canvas._apDirectionBounds;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          onLegend = true;
        }
      }
      if (!onLegend && canvas._plotBoxes) {
        for (const box of canvas._plotBoxes) {
          if (x >= box.x && x <= box.x + box.w &&
              y >= box.y && y <= box.y + box.h) {
            onLegend = true;
            break;
          }
        }
      }

      if (!onLegend) {
        isPanning = true;
        startX = e.clientX;
        startY = e.clientY;
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (isPanning) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        startX = e.clientX;
        startY = e.clientY;

        canvas._panX = (canvas._panX || 0) + dx;
        canvas._panY = (canvas._panY || 0) + dy;

        if (canvas._plotData) {
          const d = canvas._plotData;
          window.drawPlot(canvas, d.pdrData, d.targetData, d.gtInterpolated, d.minStep, d.maxStep, d.enhancedPdrData);
        }
        return;
      }

      let hover = false;
      if (canvas._plotBoxes) {
        for (const box of canvas._plotBoxes) {
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
            hover = true;
            break;
          }
        }
      }

      if (hover) {
        canvas.style.cursor = 'pointer';
      } else {
        const zoom = canvas._zoomFactor || 1.0;
        canvas.style.cursor = zoom > 1.0 ? 'grab' : 'default';
      }
    });

    const stopPan = () => {
      if (isPanning) {
        isPanning = false;
        const zoom = canvas._zoomFactor || 1.0;
        canvas.style.cursor = zoom > 1.0 ? 'grab' : 'default';
      }
    };

    canvas.addEventListener('mouseup', stopPan);
    canvas.addEventListener('mouseleave', stopPan);

    canvas.addEventListener('click', (e) => {
      if (!canvas._plotBoxes) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      let changed = false;
      for (const box of canvas._plotBoxes) {
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          if (box.type === 'radio') {
            if (canvas._plotState[box.key] !== box.value) {
              canvas._plotState[box.key] = box.value;
              changed = true;
            }
          } else if (box.action === 'toggleCheckboxes') {
            const checkboxKeys = [
              'showPdr',
              'showPdrArrows',
              'showPhoneFoundStep',
              'showRange',
              'showTarget',
              'showGt',
              'showTrueTarget',
              'showEnhanced',
              'showEnhancedRange',
              'showEnhancedTarget',
              'showEnhancedFoundStep',
              'showEnhancedPositionOnFound',
              'showEnhancedArrows'
            ];
            const anyChecked = checkboxKeys.some(k => canvas._plotState[k] === true);
            const targetVal = !anyChecked;
            for (const k of checkboxKeys) {
              canvas._plotState[k] = targetVal;
            }
            changed = true;
          } else {
            canvas._plotState[box.key] = !canvas._plotState[box.key];
            changed = true;
          }
          break;
        }
      }
      if (changed) {
        const d = canvas._plotData;
        window.drawPlot(canvas, d.pdrData, d.targetData, d.gtInterpolated, d.minStep, d.maxStep, d.enhancedPdrData);
      }
    });
  }

  const showLegend = canvas._plotState.showLegend !== false;
  const showApDirection = canvas._plotState.showApDirection !== false;
  const showPdr = canvas._plotState.showPdr;
  const showTarget = canvas._plotState.showTarget;
  const showGt = canvas._plotState.showGt;
  const showRange = canvas._plotState.showRange;
  const showEnhanced = canvas._plotState.showEnhanced;
  const showEnhancedRange = canvas._plotState.showEnhancedRange;
  const showEnhancedTarget = canvas._plotState.showEnhancedTarget;
  const showPdrArrows = canvas._plotState.showPdrArrows;
  const showEnhancedArrows = canvas._plotState.showEnhancedArrows;
  const showTrueTarget = canvas._plotState.showTrueTarget;
  const showPhoneFoundStep = canvas._plotState.showPhoneFoundStep;
  const showEnhancedFoundStep = canvas._plotState.showEnhancedFoundStep;
  const showEnhancedPositionOnFound = canvas._plotState.showEnhancedPositionOnFound;
  const includeFilenames = canvas._plotState.includeFilenames === true;

  const pdrPoints = (pdrData || [])
    .map(p => ({ x: parseFloat(p['PdrX(m)']), y: parseFloat(p['PdrY(m)']), step: p['Steps(int)'], range: parseFloat(p['Range(m)']), findState: parseInt(p['findState(int)'], 10) }))
    .filter(p => !isNaN(p.x) && !isNaN(p.y));

  const targetPoints = (targetData || [])
    .map(p => ({ x: parseFloat(p.x), y: parseFloat(p.y), step: p['Steps(int)'], err: parseFloat(p['TargetErr(m)']) }))
    .filter(p => !isNaN(p.x) && !isNaN(p.y))
    .filter(t => {
      if (t.step < 3) return false;
      const validRangesSoFar = pdrPoints.filter(p => p.step <= t.step && p.range > 0 && !isNaN(p.range)).length;
      return validRangesSoFar >= 3;
    });

  const gtPoints = (gtInterpolated || [])
    .map(p => ({ x: parseFloat(p.x), y: parseFloat(p.y), step: p['Steps(int)'], isDefinedGt: p.isDefinedGt }))
    .filter(p => !isNaN(p.x) && !isNaN(p.y));

  let enhancedPoints = [];
  let calibratedL = parseFloat(document.getElementById('enhanced-step-length')?.value) || 0.67;
  let finalSpatialRansacTarget = null;
  let keptSteps = [];
  let S_base_all = [];

  if (enhancedPdrData && enhancedPdrData.length > 0) {
    const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
    let manualBias = parseFloat(document.getElementById('manual-bias')?.value);
    if (isNaN(manualBias)) {
      manualBias = (typeof window.manualBias === 'number' && !isNaN(window.manualBias)) ? window.manualBias : 0.5;
    }
    let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
    if (isNaN(scaleRange) || scaleRange <= 0) {
      scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
    }

    S_base_all = (enhancedPdrData || [])
      .map(p => ({
        unitX: parseFloat(p.unitX),
        unitY: parseFloat(p.unitY),
        step: parseInt(p['Steps(int)'], 10),
        range: parseFloat(p['Range(m)']),
        findState: parseInt(p['findState(int)'], 10),
        weight: parseFloat(p.weight) || 1.0
      }))
      .map(p => {
        let r_adj = p.range;
        if (rangeBiasMode === 'none') {
          r_adj = p.range * scaleRange;
        } else if (rangeBiasMode === 'manual') {
          r_adj = (p.range - manualBias) * scaleRange;
        } else if (rangeBiasMode === 'auto') {
          r_adj = p.range * scaleRange;
        }
        if (isNaN(p.unitX) || isNaN(p.unitY)) {
           const origRow = enhancedPdrData.find(orig => parseInt(orig['Steps(int)'], 10) === p.step);
           const rawX = origRow ? parseFloat(origRow.x) : NaN;
           const rawY = origRow ? parseFloat(origRow.y) : NaN;
           return { ...p, range: r_adj, unitX: isNaN(rawX) ? 0 : rawX / 0.67, unitY: isNaN(rawY) ? 0 : rawY / 0.67 };
        }
        return { ...p, range: r_adj };
      })
      .filter(p => !isNaN(p.unitX) && !isNaN(p.unitY));
  }

  if (ransacMode !== 'none' && S_base_all.length > 0) {
    const S_base = S_base_all;
    const hasStepFilter = (minStep !== undefined && maxStep !== undefined);
    const S_active = S_base.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep));
    const S_active_valid = S_active.filter(p => p.range > 0 && !isNaN(p.range));

    const minPointsNeeded = useRansac ? 4 : 3;

    if (S_active_valid.length >= minPointsNeeded) {
      const pd = 0.02;
      const gamma = 0.1;
      const maxGDIter = 15;
      const tol = 1e-4;

      const calibResult = calibrateStepLengthSpatialRansac(S_active_valid, calibratedL, pd, gamma, maxGDIter, tol, useRansac, useStepCalib);
      if (calibResult && calibResult.target && typeof calibResult.target.x === 'number' && !isNaN(calibResult.target.x) && typeof calibResult.target.y === 'number' && !isNaN(calibResult.target.y) && typeof calibResult.target.err === 'number' && !isNaN(calibResult.target.err) && calibResult.target.err > 0) {
        calibratedL = calibResult.L;
        finalSpatialRansacTarget = calibResult.target;
        keptSteps = calibResult.keptSteps;
      }
    }
    
    if (!finalSpatialRansacTarget && S_active_valid.length >= 3) {
      const S_final = S_active_valid.map(p => ({ ...p, x: calibratedL * p.unitX, y: calibratedL * p.unitY }));
      const fallbackNG = window.solveGaussNewton(S_final);
      if (fallbackNG && typeof fallbackNG.x === 'number' && !isNaN(fallbackNG.x) && typeof fallbackNG.y === 'number' && !isNaN(fallbackNG.y) && typeof fallbackNG.err === 'number' && !isNaN(fallbackNG.err) && fallbackNG.err > 0) {
        finalSpatialRansacTarget = fallbackNG;
        keptSteps = S_final.map(p => p.step);
      }
    }

    const estPoints = S_base.map(p => {
      const x = calibratedL * p.unitX;
      const y = calibratedL * p.unitY;
      
      let rangeVal = p.range;
      const inActiveWindow = !hasStepFilter || (p.step >= minStep && p.step <= maxStep);
      const isValidRange = p.range > 0 && !isNaN(p.range);

      if (inActiveWindow && isValidRange && !keptSteps.includes(p.step)) {
        rangeVal = NaN;
      }

      return {
        x: x,
        y: y,
        step: p.step,
        range: rangeVal,
        findState: p.findState,
        weight: p.weight,
        L: calibratedL,
        unitX: p.unitX,
        unitY: p.unitY
      };
    });

    enhancedPoints = estPoints;
    canvas._spatialRansacTarget = finalSpatialRansacTarget;

    window.currentRansacKeptSteps = keptSteps;
    if (window.currentParsedData && window.currentParsedData.enhancedPdrData) {
       window.currentParsedData.enhancedPdrData.forEach(row => {
         const p = estPoints.find(e => e.step === parseInt(row['Steps(int)'], 10));
         if (p) {
           row.x = p.x;
           row.y = p.y;
           row.L = p.L;
         }
       });
    }
  } else {
    const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
    let manualBias = parseFloat(document.getElementById('manual-bias')?.value);
    if (isNaN(manualBias)) {
      manualBias = (typeof window.manualBias === 'number' && !isNaN(window.manualBias)) ? window.manualBias : 0.5;
    }
    let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
    if (isNaN(scaleRange) || scaleRange <= 0) {
      scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
    }

    enhancedPoints = (enhancedPdrData || [])
      .map(p => {
        const r_raw = parseFloat(p['Range(m)']);
        let r_adj = r_raw;
        if (rangeBiasMode === 'none') {
          r_adj = r_raw * scaleRange;
        } else if (rangeBiasMode === 'manual') {
          r_adj = (r_raw - manualBias) * scaleRange;
        } else if (rangeBiasMode === 'auto') {
          r_adj = r_raw * scaleRange;
        }
        return {
          x: parseFloat(p.x),
          y: parseFloat(p.y),
          step: p['Steps(int)'],
          range: r_adj,
          findState: parseInt(p['findState(int)'], 10),
          weight: p.weight
        };
      })
      .filter(p => !isNaN(p.x) && !isNaN(p.y));
  }

  const hasStepFilter = (minStep !== undefined && maxStep !== undefined);
  const activePdr = showPdr ? pdrPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  const activeTarget = showTarget ? targetPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  const activeGt = showGt ? gtPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  const activeRange = showRange ? pdrPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  const activeEnhanced = showEnhanced ? enhancedPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  const activeEnhancedRange = showEnhancedRange ? enhancedPoints.filter(p => !hasStepFilter || (p.step >= minStep && p.step <= maxStep)) : [];
  console.log("plot.js fullEnhancedTarget points:", enhancedPoints.map(p => ({step: p.step, range: p.range, weight: p.weight})));
  let fullEnhancedTarget = null;
  if (ransacMode !== 'none' && canvas._spatialRansacTarget && typeof canvas._spatialRansacTarget.x === 'number' && !isNaN(canvas._spatialRansacTarget.x) && typeof canvas._spatialRansacTarget.y === 'number' && !isNaN(canvas._spatialRansacTarget.y) && typeof canvas._spatialRansacTarget.err === 'number' && !isNaN(canvas._spatialRansacTarget.err) && canvas._spatialRansacTarget.err > 0) {
    fullEnhancedTarget = canvas._spatialRansacTarget;
  } else {
    const windowSize = window.windowStepsLimit || Infinity;
    let fullPts = enhancedPoints;
    
    // Filter to current playback window!
    const hasStepFilter = (minStep !== undefined && maxStep !== undefined);
    if (hasStepFilter) {
      fullPts = fullPts.filter(p => p.step >= minStep && p.step <= maxStep);
    }
    
    if (windowSize !== Infinity && fullPts.length > 0) {
      const lastStep = fullPts[fullPts.length - 1].step;
      fullPts = fullPts.filter(p => p.step > lastStep - windowSize);
    }
    
    const fallbackTarget = window.solveGaussNewton(fullPts);
    if (fallbackTarget && typeof fallbackTarget.x === 'number' && !isNaN(fallbackTarget.x) && typeof fallbackTarget.y === 'number' && !isNaN(fallbackTarget.y) && typeof fallbackTarget.err === 'number' && !isNaN(fallbackTarget.err) && fallbackTarget.err > 0) {
       fullEnhancedTarget = fallbackTarget;
    }
  }

  console.log(`Plotting with ${activePdr.length} PDR points, ${activeTarget.length} Target points, ${activeGt.length} GT points, and ${activeEnhanced.length} Enhanced points.`);

  if (pdrPoints.length === 0 && targetPoints.length === 0 && gtPoints.length === 0 && enhancedPoints.length === 0) {
    ctx.font = '16px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.fillText('No valid data to plot', width / 2, height / 2);
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const allPoints = [...pdrPoints, ...targetPoints, ...gtPoints, ...enhancedPoints];
  if (fullEnhancedTarget) allPoints.push(fullEnhancedTarget);
  allPoints.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const dataWidth = maxX - minX;
  const dataHeight = maxY - minY;
  const marginFactor = 0.1; // 10% margin

  minX -= dataWidth * marginFactor;
  maxX += dataWidth * marginFactor;
  minY -= dataHeight * marginFactor;
  maxY += dataHeight * marginFactor;

  // Add a 6 meter margin to the right side so the legend does not overlap paths
  maxX += 6;

  if (maxX === minX) {
    minX -= 1;
    maxX += 1;
  }
  if (maxY === minY) {
    minY -= 1;
    maxY += 1;
  }

  const plotMargin = { top: 60, right: 20, bottom: 60, left: 80 };
  const plotWidth = width - plotMargin.left - plotMargin.right;
  const plotHeight = height - plotMargin.top - plotMargin.bottom;

  const zoom = canvas._zoomFactor || 1.0;
  const panX = canvas._panX || 0;
  const panY = canvas._panY || 0;

  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;

  const baseScale = Math.min(plotWidth / dx, plotHeight / dy);
  const scale = baseScale * zoom;

  const baseOffsetX = plotMargin.left + (plotWidth - dx * scale) / 2;
  const baseOffsetY = plotMargin.top + (plotHeight - dy * scale) / 2;
  const offsetX = baseOffsetX + panX;
  const offsetY = baseOffsetY + panY;

  const boxY1 = offsetY + dy * scale;

  /**
   * Converts a world X coordinate to screen canvas pixel X.
   *
   * @param {number} x World X coordinate in meters.
   * @return {number} Screen pixel X coordinate.
   */
  function toScreenX(x) {
    return offsetX + (x - minX) * scale;
  }

  /**
   * Converts a world Y coordinate to screen canvas pixel Y.
   *
   * @param {number} y World Y coordinate in meters.
   * @return {number} Screen pixel Y coordinate.
   */
  function toScreenY(y) {
    return boxY1 - (y - minY) * scale;
  }

  /**
   * Converts a screen pixel X coordinate to world X coordinate.
   *
   * @param {number} sx Screen pixel X coordinate.
   * @return {number} World X coordinate in meters.
   */
  function toWorldX(sx) {
    return minX + (sx - offsetX) / scale;
  }

  /**
   * Converts a screen pixel Y coordinate to world Y coordinate.
   *
   * @param {number} sy Screen pixel Y coordinate.
   * @return {number} World Y coordinate in meters.
   */
  function toWorldY(sy) {
    return minY + (boxY1 - sy) / scale;
  }

  /**
   * Calculates path geometric diversity using trajectory covariance.
   *
   * <p>
   * Computes the smaller semi-major axis length of the spatial covariance
   * ellipse to quantify 2D spread.
   * </p>
   *
   * @param {!Array<!Object>} points Trajectory points with x and y coordinates.
   * @return {number} Calculated path diversity metric in meters.
   */
  window.calculatePathDiversity = function calculatePathDiversity(points) {
    if (points.length < 2) return 0;
    let sumX = 0, sumY = 0;
    points.forEach(p => { sumX += p.x; sumY += p.y; });
    const mx = sumX / points.length;
    const my = sumY / points.length;

    let varXX = 0, varYY = 0, varXY = 0;
    points.forEach(p => {
      const dx = p.x - mx;
      const dy = p.y - my;
      varXX += dx * dx;
      varYY += dy * dy;
      varXY += dx * dy;
    });
    varXX /= points.length;
    varYY /= points.length;
    varXY /= points.length;

    const trace = varXX + varYY;
    const det = varXX * varYY - varXY * varXY;
    const discriminant = trace * trace - 4 * det;
    if (discriminant < 0) return 0;
    const lambda2 = (trace - Math.sqrt(discriminant)) / 2;
    return Math.sqrt(Math.max(0, lambda2));
  };

  /**
   * Draws a directional arrow on the canvas between two world coordinates.
   *
   * <p>
   * Transforms coordinates to screen space and draws an arrow shaft with an
   * angled arrowhead.
   * </p>
   *
   * @param {number} x0 Source world X coordinate.
   * @param {number} y0 Source world Y coordinate.
   * @param {number} targetX Target world X coordinate.
   * @param {number} targetY Target world Y coordinate.
   * @param {string} color CSS color string for stroke and fill.
   */
  function drawArrow(x0, y0, targetX, targetY, color) {
    const angle = Math.atan2(targetY - y0, targetX - x0);
    const x1 = x0 + 0.5 * Math.cos(angle);
    const y1 = y0 + 0.5 * Math.sin(angle);

    const sx0 = toScreenX(x0);
    const sy0 = toScreenY(y0);
    const sx1 = toScreenX(x1);
    const sy1 = toScreenY(y1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();

    const screenAngle = Math.atan2(sy1 - sy0, sx1 - sx0);
    const headLen = 8;
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx1 - headLen * Math.cos(screenAngle - Math.PI / 6), sy1 - headLen * Math.sin(screenAngle - Math.PI / 6));
    ctx.lineTo(sx1 - headLen * Math.cos(screenAngle + Math.PI / 6), sy1 - headLen * Math.sin(screenAngle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Draws a green triangle marker at the given world coordinates.
   *
   * @param {number} x World X coordinate.
   * @param {number} y World Y coordinate.
   */
  function drawGreenTriangle(x, y) {
    const sx = toScreenX(x);
    const sy = toScreenY(y);
    const sz = 8;
    ctx.fillStyle = '#aaffaa';
    ctx.strokeStyle = '#008800';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy - sz);
    ctx.lineTo(sx + sz * 0.866, sy + sz * 0.5);
    ctx.lineTo(sx - sz * 0.866, sy + sz * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Draws a red triangle marker at the given world coordinates.
   *
   * @param {number} x World X coordinate.
   * @param {number} y World Y coordinate.
   */
  function drawRedTriangle(x, y) {
    const sx = toScreenX(x);
    const sy = toScreenY(y);
    const sz = 8;
    ctx.fillStyle = '#ff6666';
    ctx.strokeStyle = '#990000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy - sz);
    ctx.lineTo(sx + sz * 0.866, sy + sz * 0.5);
    ctx.lineTo(sx - sz * 0.866, sy + sz * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Draws a pink triangle marker at the given world coordinates.
   *
   * @param {number} x World X coordinate.
   * @param {number} y World Y coordinate.
   */
  function drawPinkTriangle(x, y) {
    drawRedTriangle(x, y);
  }

  const xMinVisible = toWorldX(plotMargin.left);
  const xMaxVisible = toWorldX(plotMargin.left + plotWidth);
  const yMinVisible = toWorldY(plotMargin.top + plotHeight);
  const yMaxVisible = toWorldY(plotMargin.top);

  const visibleRangeX = xMaxVisible - xMinVisible;
  const visibleRangeY = yMaxVisible - yMinVisible;
  const maxVisibleRange = Math.max(visibleRangeX, visibleRangeY);
  
  let roughStep = maxVisibleRange / 10;
  if (roughStep === 0) roughStep = 1;
  
  let magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  let normalized = roughStep / magnitude;
  let niceStep = 1;
  if (normalized < 1.5)
    niceStep = 1;
  else if (normalized < 3)
    niceStep = 2;
  else if (normalized < 7)
    niceStep = 5;
  else
    niceStep = 10;

  let gridStep = niceStep * magnitude;
  if (!isFinite(gridStep) || gridStep <= 0) gridStep = 1;
  
  if (gridStep > 1) {
    gridStep = 1;
  }

  const maxGridLines = 2000;
  if (visibleRangeX / gridStep > maxGridLines || visibleRangeY / gridStep > maxGridLines) {
    gridStep = Math.max(visibleRangeX / maxGridLines, visibleRangeY / maxGridLines);
  }

  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 0.5;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'gray';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // --- Draw Grid Tick Labels and Axis Titles (Outside Clip) ---
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'gray';

  // X Labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const startGridX = Math.ceil(xMinVisible / gridStep) * gridStep;
  for (let x = startGridX; x <= xMaxVisible; x += gridStep) {
    const sx = toScreenX(x);
    if (sx >= plotMargin.left && sx <= plotMargin.left + plotWidth) {
      ctx.fillText(x.toFixed(1), sx, plotMargin.top + plotHeight + 5);
    }
  }

  // Y Labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const startGridY = Math.ceil(yMinVisible / gridStep) * gridStep;
  for (let y = startGridY; y <= yMaxVisible; y += gridStep) {
    const sy = toScreenY(y);
    if (sy >= plotMargin.top && sy <= plotMargin.top + plotHeight) {
      ctx.fillText(y.toFixed(1), plotMargin.left - 5, sy);
    }
  }

  // Axis names and title
  ctx.fillStyle = 'black';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('X (m)', plotMargin.left + plotWidth / 2, plotMargin.top + plotHeight + 30);
  ctx.save();
  ctx.translate(plotMargin.left - 50, plotMargin.top + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Y (m)', 0, 0);
  ctx.restore();

  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('AP Location Analysis', width / 2, 20);

  // --- Start Clipped Drawing (Grid and Data) ---
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotMargin.left, plotMargin.top, plotWidth, plotHeight);
  ctx.clip();

  // Draw Grid Lines (Clipped)
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 0.5;

  // Vertical Grid Lines
  for (let x = startGridX; x <= xMaxVisible; x += gridStep) {
    const sx = toScreenX(x);
    if (sx >= plotMargin.left && sx <= plotMargin.left + plotWidth) {
      ctx.beginPath();
      ctx.moveTo(sx, plotMargin.top);
      ctx.lineTo(sx, plotMargin.top + plotHeight);
      ctx.stroke();
    }
  }

  // Horizontal Grid Lines
  for (let y = startGridY; y <= yMaxVisible; y += gridStep) {
    const sy = toScreenY(y);
    if (sy >= plotMargin.top && sy <= plotMargin.top + plotHeight) {
      ctx.beginPath();
      ctx.moveTo(plotMargin.left, sy);
      ctx.lineTo(plotMargin.left + plotWidth, sy);
      ctx.stroke();
    }
  }



  // 0. Plot Range Circles (Light Grey)
  if (activeRange.length > 0) {
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    activeRange.forEach(p => {
      if (p.range > 0) {
        const sx = toScreenX(p.x);
        const sy = toScreenY(p.y);
        const r = p.range * scale;
        if (r > 0) {
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
    });
  }

  let enhancedTargetPath = [];
  if (ransacMode !== 'none') {
    const hasStepFilter = (minStep !== undefined && maxStep !== undefined);
    const windowSize = window.windowStepsLimit || Infinity;
    enhancedTargetPath = activeEnhanced.map(s => {
      if (s.step < 3) return null;

      let S_hist = S_base_all.filter(p => p.step <= s.step);
      if (hasStepFilter) {
        S_hist = S_hist.filter(p => p.step >= minStep);
      }
      if (windowSize !== Infinity) {
        S_hist = S_hist.filter(p => p.step > s.step - windowSize);
      }
      
      const S_hist_valid = S_hist.filter(p => p.range > 0 && !isNaN(p.range));

      const minPointsNeeded = useRansac ? 4 : 3;

      if (S_hist_valid.length >= minPointsNeeded) {
        const pd = 0.02;
        const gamma = 0.1;
        const maxGDIter = 15;
        const tol = 1e-4;

        const calibResult = calibrateStepLengthSpatialRansac(S_hist_valid, calibratedL, pd, gamma, maxGDIter, tol, useRansac, useStepCalib);
        if (calibResult && calibResult.target && typeof calibResult.target.x === 'number' && !isNaN(calibResult.target.x) && typeof calibResult.target.y === 'number' && !isNaN(calibResult.target.y) && typeof calibResult.target.err === 'number' && !isNaN(calibResult.target.err) && calibResult.target.err > 0) {
           return { ...calibResult.target, step: s.step };
        }
      }

      if (S_hist_valid.length >= 3) {
        const S_final = S_hist_valid.map(p => ({ ...p, x: calibratedL * p.unitX, y: calibratedL * p.unitY }));
        const fallbackNG = window.solveGaussNewton(S_final);
        if (fallbackNG && typeof fallbackNG.x === 'number' && !isNaN(fallbackNG.x) && typeof fallbackNG.y === 'number' && !isNaN(fallbackNG.y) && typeof fallbackNG.err === 'number' && !isNaN(fallbackNG.err) && fallbackNG.err > 0) {
           return { ...fallbackNG, step: s.step };
        }
      }
      return null;
    }).filter(Boolean);
  } else {
    enhancedTargetPath = activeEnhanced.map(s => {
      if (s.step < 3) return null;
      const windowSize = window.windowStepsLimit || Infinity;
      let pts = enhancedPoints.filter(p => p.step <= s.step);
      if (windowSize !== Infinity) {
        pts = pts.filter(p => p.step > s.step - windowSize);
      }
      const est = solveGaussNewton(pts);
      if (est) return { ...est, step: s.step };
      return null;
    }).filter(Boolean);
  }

  window.currentEnhancedTargetPath = enhancedTargetPath;

  // 0b. Plot Enhanced Range Circles (Light Grey, Dashed)
  if (activeEnhancedRange.length > 0) {
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    let finalBias = null;
    const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
    let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
    if (isNaN(scaleRange) || scaleRange <= 0) {
      scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
    }
    if (rangeBiasMode === 'auto') {
      if (finalSpatialRansacTarget && typeof finalSpatialRansacTarget.bias === 'number' && !isNaN(finalSpatialRansacTarget.bias)) {
        finalBias = finalSpatialRansacTarget.bias;
      } else if (fullEnhancedTarget && typeof fullEnhancedTarget.bias === 'number' && !isNaN(fullEnhancedTarget.bias)) {
        finalBias = fullEnhancedTarget.bias;
      } else if (enhancedTargetPath && enhancedTargetPath.length > 0) {
        const lastTarget = enhancedTargetPath[enhancedTargetPath.length - 1];
        if (lastTarget && typeof lastTarget.bias === 'number' && !isNaN(lastTarget.bias)) {
          finalBias = lastTarget.bias;
        }
      }
    }
    activeEnhancedRange.forEach(p => {
      if (p.range > 0) {
        const sx = toScreenX(p.x);
        const sy = toScreenY(p.y);
        let r_m = p.range;
        if (rangeBiasMode === 'auto' && finalBias !== null && !isNaN(finalBias)) {
          r_m = p.range - finalBias * scaleRange;
        }
        const r = r_m * scale;
        if (r > 0) {
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
    });
    ctx.setLineDash([]);
  }

  // 1. Plot Target Position (Blue)
  if (activeTarget.length > 0) {
    ctx.strokeStyle = 'blue';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    activeTarget.forEach((p, i) => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'blue';
    activeTarget.forEach(p => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
      ctx.fill();
    });

    // Draw Error Circle around the last target point
    const lastTarget = activeTarget[activeTarget.length - 1];
    if (lastTarget && lastTarget.err > 0) {
      const sx = toScreenX(lastTarget.x);
      const sy = toScreenY(lastTarget.y);
      const r = lastTarget.err * scale;
      if (r > 0) {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0, 0, 255, 0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 255, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // 2. Plot Interpolated Ground Truth (Green line, black dots)
  if (activeGt.length > 0) {
    ctx.strokeStyle = 'green';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    activeGt.forEach((p, i) => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    ctx.fillStyle = 'black';
    activeGt.forEach(p => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      ctx.beginPath();
      // Defined GT points get 50% larger diameter (radius 4.5 vs 3)
      ctx.arc(sx, sy, p.isDefinedGt ? 4.5 : 3, 0, 2 * Math.PI);
      ctx.fill();
    });
  }

  // 2b. Plot True Target (bright green dot at the last entry of ground truth).
  if (showTrueTarget && gtPoints.length > 0) {
    const trueTarget = gtPoints[gtPoints.length - 1];
    const sx = toScreenX(trueTarget.x);
    const sy = toScreenY(trueTarget.y);
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#00ff00'; // bright green
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 3. Plot PDR Path (Red line, black dots, pink triangle, arrows)
  if (activePdr.length > 0) {
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    activePdr.forEach((p, i) => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    ctx.fillStyle = 'black';
    activePdr.forEach(p => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
      ctx.fill();
    });

    foundStep = -1;
    for (let i = 0; i < pdrPoints.length; i++) {
      if (pdrPoints[i].findState === 2) {
        foundStep = pdrPoints[i].step;
        break;
      }
    }

    if (showPhoneFoundStep && foundStep !== -1) {
      const foundPt = activePdr.find(p => p.step === foundStep);
      if (foundPt) {
        drawGreenTriangle(foundPt.x, foundPt.y);
      }
    }

    if (showPdrArrows && foundStep !== -1) {
      activePdr.forEach(p => {
        if (p.step >= foundStep) {
          const tOrig = targetPoints.find(t => t.step === p.step);
          if (tOrig) {
            drawArrow(p.x, p.y, tOrig.x, tOrig.y, 'red');
          }
        }
      });
    }
  }

  if (activeEnhanced.length > 0) {
    ctx.strokeStyle = 'orange';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    activeEnhanced.forEach((p, i) => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    ctx.fillStyle = 'orange';
    activeEnhanced.forEach(p => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
      ctx.fill();

      if (p.range > 0 && !isNaN(p.range)) {
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 5.5, 0, 2 * Math.PI);
        ctx.stroke();
      }
    });

    foundStepEnhanced = -1;
    if (window.calculatePathDiversity && enhancedPoints.length > 0) {
      for (let i = 0; i < enhancedPoints.length; i++) {
        const pathSubset = enhancedPoints.slice(0, i + 1);
        const div = window.calculatePathDiversity(pathSubset);
        if (div >= diversityThreshold) {
          foundStepEnhanced = enhancedPoints[i].step;
          if (window.firstEnhancedCrossingStep === undefined || window.firstEnhancedCrossingStep === -1 || foundStepEnhanced < window.firstEnhancedCrossingStep) {
            window.firstEnhancedCrossingStep = foundStepEnhanced;
          }
          break;
        }
      }
    }

    if (showEnhancedFoundStep && foundStepEnhanced !== -1) {
      if (window.firstEnhancedCrossingStep !== -1) {
        const firstPt = activeEnhanced.find(p => p.step === window.firstEnhancedCrossingStep);
        if (firstPt) {
          drawGreenTriangle(firstPt.x, firstPt.y);
        }
      }
      if (foundStepEnhanced !== window.firstEnhancedCrossingStep) {
        const currentPt = activeEnhanced.find(p => p.step === foundStepEnhanced);
        if (currentPt) {
          drawRedTriangle(currentPt.x, currentPt.y);
        }
      }
    }

    if (showEnhancedArrows && foundStepEnhanced !== -1) {
      activeEnhanced.forEach(p => {
        if (p.step >= foundStepEnhanced) {
          const tEnh = enhancedTargetPath.find(t => t.step === p.step);
          if (tEnh) {
            drawArrow(p.x, p.y, tEnh.x, tEnh.y, 'orange');
          }
        }
      });
    }
  }

  // 5. Plot Enhanced Target Position (Purple path, dots & error circle).
  if (showEnhancedTarget && enhancedTargetPath.length > 0) {
    ctx.strokeStyle = 'purple';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    enhancedTargetPath.forEach((p, i) => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'purple';
    enhancedTargetPath.forEach(p => {
      const sx = toScreenX(p.x);
      const sy = toScreenY(p.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
      ctx.fill();
    });

    const lastActiveStep = activeEnhanced.length > 0 ? activeEnhanced[activeEnhanced.length - 1].step : -1;
    const isFound = (foundStepEnhanced !== -1 && lastActiveStep >= foundStepEnhanced);

    if (!showEnhancedPositionOnFound || isFound) {
      // Draw final purple dot and transparent purple error circle around
      // the last point in the active window.
      const lastEnhancedTarget = enhancedTargetPath[enhancedTargetPath.length - 1];
      if (lastEnhancedTarget) {
        const sx = toScreenX(lastEnhancedTarget.x);
        const sy = toScreenY(lastEnhancedTarget.y);

        let finalCircleRadiusM = (typeof lastEnhancedTarget.err === 'number' && !isNaN(lastEnhancedTarget.err) && lastEnhancedTarget.err > 0) ? lastEnhancedTarget.err : 0;

        if (finalCircleRadiusM > 0) {
          const r = finalCircleRadiusM * scale;
          if (r > 0) {
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(128, 0, 128, 0.2)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(128, 0, 128, 0.8)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }

        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, 2 * Math.PI);
        ctx.fillStyle = 'purple';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  ctx.restore();
  // --- End Clipped Drawing ---

  // Draw thicker grey axes lines (X and Y axis)
  ctx.strokeStyle = '#777';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  // Y Axis
  ctx.moveTo(plotMargin.left, plotMargin.top);
  ctx.lineTo(plotMargin.left, plotMargin.top + plotHeight);
  // X Axis
  ctx.lineTo(plotMargin.left + plotWidth, plotMargin.top + plotHeight);
  ctx.stroke();

  // Legend
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 1;
  ctx.save();
  let maxRequiredWidth = 220; // Default min width
  
  // A. Measure Legend Items
  ctx.font = '12px sans-serif';
  const legendLabels = [
    'Phone PDR Path',
    'Phone PDR Arrows',
    'Phone Found Step',
    'Phone Range Circles',
    'include filenames'
  ];
  if (targetPoints.length > 0) legendLabels.push('Phone Target Position');
  if (gtPoints.length > 0) {
    legendLabels.push('Ground Truth');
    legendLabels.push('True Target');
  }
  if (enhancedPoints.length > 0) {
    legendLabels.push('Enhanced PDR');
    legendLabels.push('Enhanced Range');
    if ((enhancedTargetPath && enhancedTargetPath.length > 0) ||
        fullEnhancedTarget) {
      legendLabels.push('Enhanced Target');
    }
    legendLabels.push('Enhanced Found Step');
    legendLabels.push('Enhanced Show Position On Found');
    legendLabels.push('Enhanced Arrows');
  }
  // Measure bottom buttons row
  ctx.font = 'bold 11px sans-serif';
  const apDirBtnTextW = ctx.measureText('AP Direction').width + 24;
  const toggleBtnTextW = ctx.measureText('Toggle []').width + 24;
  const reqBottomButtonsW = apDirBtnTextW + toggleBtnTextW + 24; // 8px margins + 8px gap
  if (reqBottomButtonsW > maxRequiredWidth) maxRequiredWidth = reqBottomButtonsW;

  legendLabels.forEach(lbl => {
    const w = ctx.measureText(lbl).width;
    const reqW = 50 + w + 15; // 50px offset for icon, 15px right margin
    if (reqW > maxRequiredWidth) maxRequiredWidth = reqW;
  });

  // B. Measure Green Box Items
  // 1. Standard bold 12px items
  ctx.font = 'bold 12px sans-serif';
  const greenBox12pxLabels = [
    'Est. angle (degs): 180.0',
    'True angle (degs): 180.0',
    'RMS angle error (degs): 180.0',
    'Mean angle error (degs): 180.0',
    'Est. dist. (m): 18.0',
    'True dist (m): 18.0',
    'RMS dist error (m): 18.0',
    'Mean dist error (m): 18.0',
    'Error Ref: GT in log',
    'Error Ref: GT File',
    'Arrows: White->Finder, Blue->GT'
  ];
  greenBox12pxLabels.forEach(lbl => {
    const w = ctx.measureText(lbl).width;
    const reqW = w + 30; // 15px margin on each side
    if (reqW > maxRequiredWidth) maxRequiredWidth = reqW;
  });

  // 2. Bold 10.5px items
  ctx.font = 'bold 10.5px sans-serif';
  const greenBox10_5pxLabels = [
    'Est. Target to GT angle err (degs): 180.0',
    'Est. Target to GT dist err (m): 18.0'
  ];
  greenBox10_5pxLabels.forEach(lbl => {
    const w = ctx.measureText(lbl).width;
    const reqW = w + 30; // 15px margin on each side
    if (reqW > maxRequiredWidth) maxRequiredWidth = reqW;
  });

  // 3. Radio row
  ctx.font = 'bold 12px sans-serif';
  const radioW_Enhanced = ctx.measureText('Enhanced').width + 20;
  const radioW_Phone = ctx.measureText('Phone').width + 20;
  const radioRowW = radioW_Enhanced + 25 + radioW_Phone; // 25px gap
  const reqRadioRowW = radioRowW + 30;
  if (reqRadioRowW > maxRequiredWidth) maxRequiredWidth = reqRadioRowW;

  // 4. Title
  ctx.font = 'bold 15px sans-serif';
  const titleBoxW = ctx.measureText('AP Direction').width + 10;
  const reqTitleW = titleBoxW + 30;
  if (reqTitleW > maxRequiredWidth) maxRequiredWidth = reqTitleW;

  ctx.restore();
  
  const legendWidth = Math.ceil(maxRequiredWidth);
  const legendMarginRight = 8;
  const legendMarginTop = 8;
  const legendX = width - legendWidth - legendMarginRight;
  const legendY = legendMarginTop;
  const legendHeaderH = 26;
  const itemHeight = 22;

  let checkboxCount = 5;
  if (targetPoints.length > 0) checkboxCount += 1;
  if (gtPoints.length > 0) checkboxCount += 2;
  if (enhancedPoints.length > 0) {
    checkboxCount += 2;
    if ((enhancedTargetPath && enhancedTargetPath.length > 0) ||
        fullEnhancedTarget) {
      checkboxCount += 1;
    }
    checkboxCount += 3;
  }

  const btnRowH = 26;
  const bottomPadding = 8;
  const legendHeight = legendHeaderH + 4 + (checkboxCount * itemHeight) +
      btnRowH + bottomPadding;

  canvas._plotBoxes = [];

  if (!showLegend) {
    canvas._legendBounds = {
      x: legendX,
      y: legendY,
      w: legendWidth,
      h: legendHeaderH
    };
    canvas._apDirectionBounds = null;
    canvas._plotBoxes.push({
      x: legendX,
      y: legendY,
      w: legendWidth,
      h: legendHeaderH,
      key: 'showLegend'
    });

    ctx.fillStyle = '#eeeeee';
    ctx.fillRect(legendX, legendY, legendWidth, legendHeaderH);
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeaderH);

    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Legend', legendX + 8, legendY + legendHeaderH / 2);

    const showBoxX = legendX + legendWidth - 55;
    const showBoxY = legendY + Math.round((legendHeaderH - 12) / 2);
    ctx.fillStyle = 'white';
    ctx.fillRect(showBoxX, showBoxY, 12, 12);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.strokeRect(showBoxX, showBoxY, 12, 12);

    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('show', showBoxX + 17, legendY + legendHeaderH / 2);
  } else {
    canvas._legendBounds = {
      x: legendX,
      y: legendY,
      w: legendWidth,
      h: legendHeight
    };

    ctx.fillStyle = '#eeeeee';
    ctx.fillRect(legendX, legendY, legendWidth, legendHeight);
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);

    // Header row
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Legend', legendX + 8, legendY + legendHeaderH / 2);

    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY + legendHeaderH);
    ctx.lineTo(legendX + legendWidth, legendY + legendHeaderH);
    ctx.stroke();

    const showBoxX = legendX + legendWidth - 55;
    const showBoxY = legendY + Math.round((legendHeaderH - 12) / 2);
    ctx.fillStyle = 'white';
    ctx.fillRect(showBoxX, showBoxY, 12, 12);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.strokeRect(showBoxX, showBoxY, 12, 12);
    ctx.beginPath();
    ctx.moveTo(showBoxX + 2, showBoxY + 5);
    ctx.lineTo(showBoxX + 5, showBoxY + 9);
    ctx.lineTo(showBoxX + 10, showBoxY + 2);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('show', showBoxX + 17, legendY + legendHeaderH / 2);

    canvas._plotBoxes.push({
      x: legendX,
      y: legendY,
      w: legendWidth,
      h: legendHeaderH,
      key: 'showLegend'
    });

    let currentLegendY = legendY + legendHeaderH + 4;

    // PDR Path legend
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'white';
    ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
    ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
    if (showPdr) {
      ctx.beginPath();
      ctx.moveTo(legendX + 7, currentLegendY + 10);
      ctx.lineTo(legendX + 10, currentLegendY + 14);
      ctx.lineTo(legendX + 15, currentLegendY + 7);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    canvas._plotBoxes.push({
      x: legendX,
      y: currentLegendY,
      w: legendWidth,
      h: itemHeight,
      key: 'showPdr'
    });

    ctx.strokeStyle = 'red';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(legendX + 25, currentLegendY + 11);
    ctx.lineTo(legendX + 45, currentLegendY + 11);
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(legendX + 35, currentLegendY + 11, 3, 0, 2 * Math.PI);
    ctx.fill();

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Phone PDR Path', legendX + 50, currentLegendY + 11);
    currentLegendY += itemHeight;

    // PDR Arrows legend
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'white';
    ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
    ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
    if (showPdrArrows) {
      ctx.beginPath();
      ctx.moveTo(legendX + 7, currentLegendY + 10);
      ctx.lineTo(legendX + 10, currentLegendY + 14);
      ctx.lineTo(legendX + 15, currentLegendY + 7);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    canvas._plotBoxes.push({
      x: legendX,
      y: currentLegendY,
      w: legendWidth,
      h: itemHeight,
      key: 'showPdrArrows'
    });

    ctx.strokeStyle = 'red';
    ctx.fillStyle = 'red';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(legendX + 25, currentLegendY + 11);
    ctx.lineTo(legendX + 40, currentLegendY + 11);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(legendX + 40, currentLegendY + 11);
    ctx.lineTo(legendX + 35, currentLegendY + 8);
    ctx.lineTo(legendX + 35, currentLegendY + 14);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'black';
    ctx.fillText('Phone PDR Arrows', legendX + 50, currentLegendY + 11);
    currentLegendY += itemHeight;

    // Phone Found Step legend
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'white';
    ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
    ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
    if (showPhoneFoundStep) {
      ctx.beginPath();
      ctx.moveTo(legendX + 7, currentLegendY + 10);
      ctx.lineTo(legendX + 10, currentLegendY + 14);
      ctx.lineTo(legendX + 15, currentLegendY + 7);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    canvas._plotBoxes.push({
      x: legendX,
      y: currentLegendY,
      w: legendWidth,
      h: itemHeight,
      key: 'showPhoneFoundStep'
    });

    ctx.fillStyle = '#00bb00';
    ctx.beginPath();
    ctx.moveTo(legendX + 35, currentLegendY + 5);
    ctx.lineTo(legendX + 30, currentLegendY + 15);
    ctx.lineTo(legendX + 40, currentLegendY + 15);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.fillText('Phone Found Step', legendX + 50, currentLegendY + 11);
    currentLegendY += itemHeight;

    // Range Circles legend
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'white';
    ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
    ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
    if (showRange) {
      ctx.beginPath();
      ctx.moveTo(legendX + 7, currentLegendY + 10);
      ctx.lineTo(legendX + 10, currentLegendY + 14);
      ctx.lineTo(legendX + 15, currentLegendY + 7);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    canvas._plotBoxes.push({
      x: legendX,
      y: currentLegendY,
      w: legendWidth,
      h: itemHeight,
      key: 'showRange'
    });

    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(legendX + 35, currentLegendY + 11, 6, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.fillText('Phone Range Circles', legendX + 50, currentLegendY + 11);
    currentLegendY += itemHeight;

    // Target Position legend
    if (targetPoints.length > 0) {
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showTarget) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showTarget'
      });

      ctx.strokeStyle = 'blue';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(legendX + 25, currentLegendY + 11);
      ctx.lineTo(legendX + 45, currentLegendY + 11);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'blue';
      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 3, 0, 2 * Math.PI);
      ctx.fill();

      ctx.fillStyle = 'black';
      ctx.fillText('Phone Target Position', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;
    }

    // Ground Truth legend
    if (gtPoints.length > 0) {
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showGt) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showGt'
      });

      ctx.strokeStyle = 'green';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(legendX + 25, currentLegendY + 11);
      ctx.lineTo(legendX + 45, currentLegendY + 11);
      ctx.stroke();

      ctx.fillStyle = 'black';
      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 4.5, 0, 2 * Math.PI);
      ctx.fill();

      ctx.fillStyle = 'black';
      ctx.fillText('Ground Truth', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;

      // True Target legend
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showTrueTarget) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showTrueTarget'
      });

      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 5, 0, 2 * Math.PI);
      ctx.fillStyle = '#00ff00';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = 'black';
      ctx.fillText('True Target', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;
    }

    // Enhanced PDR legend
    if (enhancedPoints.length > 0) {
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showEnhanced) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showEnhanced'
      });

      ctx.strokeStyle = 'orange';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(legendX + 25, currentLegendY + 11);
      ctx.lineTo(legendX + 45, currentLegendY + 11);
      ctx.stroke();

      ctx.fillStyle = 'orange';
      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 3, 0, 2 * Math.PI);
      ctx.fill();

      ctx.fillStyle = 'black';
      ctx.fillText('Enhanced PDR', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;

      // Enhanced Range Circles legend
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showEnhancedRange) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showEnhancedRange'
      });

      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 6, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'black';
      ctx.fillText('Enhanced Range', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;

      // Enhanced Target legend
      if ((enhancedTargetPath && enhancedTargetPath.length > 0) ||
          fullEnhancedTarget) {
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.fillStyle = 'white';
        ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
        ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
        if (showEnhancedTarget) {
          ctx.beginPath();
          ctx.moveTo(legendX + 7, currentLegendY + 10);
          ctx.lineTo(legendX + 10, currentLegendY + 14);
          ctx.lineTo(legendX + 15, currentLegendY + 7);
          ctx.strokeStyle = 'black';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        canvas._plotBoxes.push({
          x: legendX,
          y: currentLegendY,
          w: legendWidth,
          h: itemHeight,
          key: 'showEnhancedTarget'
        });

        ctx.strokeStyle = 'purple';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(legendX + 25, currentLegendY + 11);
        ctx.lineTo(legendX + 45, currentLegendY + 11);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(legendX + 35, currentLegendY + 11, 3, 0, 2 * Math.PI);
        ctx.fillStyle = 'purple';
        ctx.fill();

        ctx.fillStyle = 'black';
        ctx.fillText('Enhanced Target', legendX + 50, currentLegendY + 11);
        currentLegendY += itemHeight;
      }

      // Enhanced Found Step legend
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showEnhancedFoundStep) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showEnhancedFoundStep'
      });

      ctx.fillStyle = '#00bb00';
      ctx.beginPath();
      ctx.moveTo(legendX + 35, currentLegendY + 5);
      ctx.lineTo(legendX + 30, currentLegendY + 15);
      ctx.lineTo(legendX + 40, currentLegendY + 15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.fillStyle = 'black';
      ctx.fillText('Enhanced Found Step', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;

      // Enhanced Show Position On Found legend
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showEnhancedPositionOnFound) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showEnhancedPositionOnFound'
      });

      ctx.save();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 8, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(128, 0, 128, 0.2)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(128, 0, 128, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(legendX + 35, currentLegendY + 11, 5, 0, 2 * Math.PI);
      ctx.fillStyle = 'purple';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = 'black';
      ctx.fillText(
          'Enhanced Show Position On Found', legendX + 50,
          currentLegendY + 11);
      currentLegendY += itemHeight;

      // Enhanced Arrows legend
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'white';
      ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
      ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
      if (showEnhancedArrows) {
        ctx.beginPath();
        ctx.moveTo(legendX + 7, currentLegendY + 10);
        ctx.lineTo(legendX + 10, currentLegendY + 14);
        ctx.lineTo(legendX + 15, currentLegendY + 7);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      canvas._plotBoxes.push({
        x: legendX,
        y: currentLegendY,
        w: legendWidth,
        h: itemHeight,
        key: 'showEnhancedArrows'
      });

      ctx.strokeStyle = 'orange';
      ctx.fillStyle = 'orange';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(legendX + 25, currentLegendY + 11);
      ctx.lineTo(legendX + 40, currentLegendY + 11);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(legendX + 40, currentLegendY + 11);
      ctx.lineTo(legendX + 35, currentLegendY + 8);
      ctx.lineTo(legendX + 35, currentLegendY + 14);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = 'black';
      ctx.fillText('Enhanced Arrows', legendX + 50, currentLegendY + 11);
      currentLegendY += itemHeight;
    }

    // Include Filenames legend
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'white';
    ctx.fillRect(legendX + 5, currentLegendY + 5, 12, 12);
    ctx.strokeRect(legendX + 5, currentLegendY + 5, 12, 12);
    if (includeFilenames) {
      ctx.beginPath();
      ctx.moveTo(legendX + 7, currentLegendY + 10);
      ctx.lineTo(legendX + 10, currentLegendY + 14);
      ctx.lineTo(legendX + 15, currentLegendY + 7);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    canvas._plotBoxes.push({
      x: legendX,
      y: currentLegendY,
      w: legendWidth,
      h: itemHeight,
      key: 'includeFilenames'
    });

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'black';
    ctx.fillText('include filenames', legendX + 25, currentLegendY + 11);
    currentLegendY += itemHeight;

    // Bottom Button Row: AP Direction toggle button and Toggle [] button
    const btnMarginX = 8;
    const btnGap = 8;
    const btnY = currentLegendY + 2;
    const btnH = 22;
    const totalBtnW = legendWidth - (2 * btnMarginX) - btnGap;

    const btn1W = Math.round(totalBtnW * 0.55);
    const btn2W = totalBtnW - btn1W;
    const btn1X = legendX + btnMarginX;
    const btn2X = btn1X + btn1W + btnGap;

    // 1. AP Direction toggle button (shows/hides the direction panel)
    const isApDirActive = showApDirection;
    ctx.fillStyle = isApDirActive ? '#2e7d32' : '#ffffff';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(btn1X, btnY, btn1W, btnH, 3);
      ctx.fill();
      ctx.strokeStyle = isApDirActive ? '#1b5e20' : '#888888';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillRect(btn1X, btnY, btn1W, btnH);
      ctx.strokeStyle = isApDirActive ? '#1b5e20' : '#888888';
      ctx.lineWidth = 1;
      ctx.strokeRect(btn1X, btnY, btn1W, btnH);
    }
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isApDirActive ? '#ffffff' : '#2e7d32';
    ctx.fillText('AP Direction', btn1X + btn1W / 2, btnY + btnH / 2);

    canvas._plotBoxes.push({
      x: btn1X,
      y: btnY,
      w: btn1W,
      h: btnH,
      key: 'showApDirection'
    });

    // 2. Toggle [] button (toggles all checkboxes above on/off)
    ctx.fillStyle = '#ffffff';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(btn2X, btnY, btn2W, btnH, 3);
      ctx.fill();
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillRect(btn2X, btnY, btn2W, btnH);
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1;
      ctx.strokeRect(btn2X, btnY, btn2W, btnH);
    }
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#202124';
    ctx.fillText('Toggle []', btn2X + btn2W / 2, btnY + btnH / 2);

    canvas._plotBoxes.push({
      x: btn2X,
      y: btnY,
      w: btn2W,
      h: btnH,
      action: 'toggleCheckboxes'
    });

    currentLegendY += btnH + 4;
  }

  const autoStepValInput = document.getElementById('auto-step-val');
  if (autoStepValInput) {
    if (useStepCalib && activeEnhanced.length > 0) {
      autoStepValInput.value =
          (typeof calibratedL === 'number' && !isNaN(calibratedL)) ?
          calibratedL.toFixed(2) : '---';
    } else {
      autoStepValInput.value = '---';
    }
  }

  // Draw AP Direction Panel Box below Legend
  if (showLegend && showApDirection) {
    const greenBoxHeight = 390;
    const greenBoxY = legendY + legendHeight + 8;
    canvas._apDirectionBounds = {
      x: legendX,
      y: greenBoxY,
      w: legendWidth,
      h: greenBoxHeight
    };

    ctx.fillStyle = '#2e7d32';  // Green
    ctx.fillRect(legendX, greenBoxY, legendWidth, greenBoxHeight);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, greenBoxY, legendWidth, greenBoxHeight);

    // Draw Title with White Background Box
    ctx.font = 'bold 15px sans-serif';
    const titleText = 'AP Direction';
    const titleWidth = ctx.measureText(titleText).width;
    const titleBoxWidth = titleWidth + 10;
    const titleBoxHeight = 22;
    const titleBoxX = legendX + (legendWidth - titleBoxWidth) / 2;
    const titleBoxY = greenBoxY + 5;

    ctx.fillStyle = 'white';
    ctx.fillRect(titleBoxX, titleBoxY, titleBoxWidth, titleBoxHeight);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.strokeRect(titleBoxX, titleBoxY, titleBoxWidth, titleBoxHeight);

    ctx.fillStyle = '#0047ab';  // Cobalt blue
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(titleText, legendX + legendWidth / 2, greenBoxY + 8);

  let trueTarget = null;
  let errorRefLabel = '---';

  // 1. Final GT record point in the GT file (if it exists)
  if (gtPoints.length > 0) {
    trueTarget = gtPoints[gtPoints.length - 1];
    errorRefLabel = 'GT File';
  }
  // 2. Or else the last GT record in the logfile, if it is not a NaN for the x
  // and y position
  else if (
      window.currentParsedData && window.currentParsedData.gtData &&
      window.currentParsedData.gtData.length > 0) {
    const lastRow = window.currentParsedData
                        .gtData[window.currentParsedData.gtData.length - 1];
    const tx = parseFloat(lastRow['TargetX(m)']);
    const ty = parseFloat(lastRow['TargetY(m)']);
    if (!isNaN(tx) && !isNaN(ty)) {
      trueTarget = {x: tx, y: ty};
      errorRefLabel = 'GT in log';
    }
  }

  /**
   * Computes error statistics and bearing metrics along an active path.
   *
   * <p>
   * Evaluates RMS and mean distance and angle errors comparing estimated
   * positions and headings against ground truth.
   * </p>
   *
   * @param {!Array<!Object>} activePath Array of active trajectory points.
   * @param {!Array<!Object>} targetPath Array of target solution nodes.
   * @param {number} startStep Starting step index for the evaluation.
   * @param {?Object} trueTarget Ground truth target coordinate object.
   * @return {!Object} Computed summary metrics object.
   */
  function calcSummaryMetricsForPath(activePath, targetPath, startStep, trueTarget) {
    let estimatedAngleRad = null;
    let displayAngleDeg = null;
    let displayDistM = null;
    let trueAngleDeg = null;
    let trueDistM = null;
    let rmsAngleError = null;
    let rmsDistError = null;
    let meanAngleError = null;
    let meanDistError = null;
    let gtAngleRad = null;
    let arrowGtAngleErrDeg = null;
    let arrowGtDistErrM = null;

    let latestArrowPt = null;
    let latestTargetPt = null;

    if (activePath.length > 0 && targetPath.length > 0) {
      for (let i = activePath.length - 1; i >= 0; i--) {
        const p = activePath[i];
        if (startStep !== -1 && p.step >= startStep) {
          const tNode = targetPath.find(t => t.step === p.step);
          if (tNode) {
            latestArrowPt = p;
            latestTargetPt = tNode;
            break;
          }
        }
      }
    }

    if (latestArrowPt && latestTargetPt) {
      const dx = latestTargetPt.x - latestArrowPt.x;
      const dy = latestTargetPt.y - latestArrowPt.y;
      estimatedAngleRad = Math.atan2(dy, dx);
      displayDistM = Math.sqrt(dx * dx + dy * dy);

      const phi_deg = estimatedAngleRad * 180 / Math.PI;
      displayAngleDeg = 90 - phi_deg;
      if (displayAngleDeg > 180) displayAngleDeg -= 360;
      else if (displayAngleDeg <= -180) displayAngleDeg += 360;

      if (trueTarget && latestArrowPt) {
        const dxGt = trueTarget.x - latestArrowPt.x;
        const dyGt = trueTarget.y - latestArrowPt.y;
        gtAngleRad = Math.atan2(dyGt, dxGt);
        trueDistM = Math.sqrt(dxGt * dxGt + dyGt * dyGt);

        const gtPhiDeg = gtAngleRad * 180 / Math.PI;
        trueAngleDeg = 90 - gtPhiDeg;
        while (trueAngleDeg > 180) trueAngleDeg -= 360;
        while (trueAngleDeg <= -180) trueAngleDeg += 360;

        if (estimatedAngleRad !== null && gtAngleRad !== null) {
          let diffRad = estimatedAngleRad - gtAngleRad;
          let diffDeg = diffRad * 180 / Math.PI;
          while (diffDeg > 180) diffDeg -= 360;
          while (diffDeg <= -180) diffDeg += 360;
          arrowGtAngleErrDeg = Math.abs(diffDeg);
        }

        if (displayDistM !== null && trueDistM !== null) {
          arrowGtDistErrM = Math.abs(displayDistM - trueDistM);
        }
      }
    }

    const effectiveStartStep = startStep !== -1 ? startStep : 3;
    if (trueTarget && effectiveStartStep !== -1) {
      let sumSqAngle = 0;
      let sumSqDist = 0;
      let sumAbsAngle = 0;
      let sumAbsDist = 0;
      let errCount = 0;

      targetPath.forEach(tNode => {
        if (tNode.step >= effectiveStartStep) {
          const p = activePath.find(pt => pt.step === tNode.step);
          if (p) {
            const dxTarget = tNode.x - trueTarget.x;
            const dyTarget = tNode.y - trueTarget.y;
            const distErr = Math.sqrt(dxTarget * dxTarget + dyTarget * dyTarget);
            sumSqDist += distErr * distErr;
            sumAbsDist += distErr;

            const dxTrue = trueTarget.x - p.x;
            const dyTrue = trueTarget.y - p.y;
            const trueAngleRad = Math.atan2(dyTrue, dxTrue);

            const dxEst = tNode.x - p.x;
            const dyEst = tNode.y - p.y;
            const estAngleRad = Math.atan2(dyEst, dxEst);

            let angleDiffDeg = (estAngleRad - trueAngleRad) * 180 / Math.PI;
            while (angleDiffDeg > 180) angleDiffDeg -= 360;
            while (angleDiffDeg <= -180) angleDiffDeg += 360;

            const angleErr = Math.abs(angleDiffDeg);
            sumSqAngle += angleErr * angleErr;
            sumAbsAngle += angleErr;

            errCount++;
          }
        }
      });

      if (errCount > 0) {
        rmsAngleError = Math.sqrt(sumSqAngle / errCount);
        rmsDistError = Math.sqrt(sumSqDist / errCount);
        meanAngleError = sumAbsAngle / errCount;
        meanDistError = sumAbsDist / errCount;
      }
    }

    return {
      estimatedAngleRad,
      displayAngleDeg,
      displayDistM,
      trueAngleDeg,
      trueDistM,
      rmsAngleError,
      rmsDistError,
      meanAngleError,
      meanDistError,
      gtAngleRad,
      arrowGtAngleErrDeg,
      arrowGtDistErrM
    };
  }

  const enhancedMetrics = calcSummaryMetricsForPath(activeEnhanced, enhancedTargetPath, foundStepEnhanced, trueTarget);
  const phoneMetrics = calcSummaryMetricsForPath(activePdr, targetPoints, foundStep, trueTarget);

  window.greenBoxSummaryMetrics = {
    enhanced: enhancedMetrics,
    phone: phoneMetrics
  };

  const metricRef = (canvas._plotState && canvas._plotState.metricReference) || 'Enhanced';
  const activeMetrics = metricRef === 'Enhanced' ? enhancedMetrics : phoneMetrics;

  const estimatedAngleRad = activeMetrics.estimatedAngleRad;
  const displayAngleDeg = activeMetrics.displayAngleDeg;
  const trueAngleDeg = activeMetrics.trueAngleDeg;
  const displayDistM = activeMetrics.displayDistM;
  const trueDistM = activeMetrics.trueDistM;
  const rmsAngleError = activeMetrics.rmsAngleError;
  const rmsDistError = activeMetrics.rmsDistError;
  const meanAngleError = activeMetrics.meanAngleError;
  const meanDistError = activeMetrics.meanDistError;
  const gtAngleRad = activeMetrics.gtAngleRad;
  const arrowGtAngleErrDeg = activeMetrics.arrowGtAngleErrDeg;
  const arrowGtDistErrM = activeMetrics.arrowGtDistErrM;

  // Draw Text
  const textY_ArrowsLegend = greenBoxY + 128; // Blank line above and below
  const textY1 = greenBoxY + 160;
  const textY_TrueAngle = greenBoxY + 175;
  const textY2 = greenBoxY + 190;
  const textY_MeanAngle = greenBoxY + 205;
  const textY3 = greenBoxY + 220;
  const textY4 = greenBoxY + 248; 
  const textY_TrueDist = greenBoxY + 263;
  const textY5 = greenBoxY + 278;
  const textY_MeanDist = greenBoxY + 293;
  const textY6 = greenBoxY + 308;
  const textY7 = greenBoxY + 336;
  const textY8 = greenBoxY + 361;

  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  ctx.textBaseline = 'middle';

  const part1 = "Arrows: White->Finder, ";
  const part2 = "Blue";
  const part3 = "->GT";

  const w1 = ctx.measureText(part1).width;
  const w2 = ctx.measureText(part2).width;
  const w3 = ctx.measureText(part3).width;
  const totalW = w1 + w2 + w3;

  const startX = legendX + (legendWidth - totalW) / 2;

  ctx.textAlign = 'left';
  ctx.fillStyle = 'white';
  ctx.fillText(part1, startX, textY_ArrowsLegend);
  
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeText(part2, startX + w1, textY_ArrowsLegend);
  ctx.fillStyle = '#000080'; // Exact Navy Blue from the GT Arrow
  ctx.fillText(part2, startX + w1, textY_ArrowsLegend);
  ctx.restore();

  ctx.fillStyle = 'white';
  ctx.fillText(part3, startX + w1 + w2, textY_ArrowsLegend);
  
  ctx.restore();

  ctx.fillStyle = 'white';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (displayAngleDeg !== null) {
    ctx.fillText(
        `Est. angle (degs): ${displayAngleDeg.toFixed(1)}`,
        legendX + legendWidth / 2, textY1);
  } else {
    ctx.fillText('Est. angle (degs): ---', legendX + legendWidth / 2, textY1);
  }

  if (trueAngleDeg !== null) {
    ctx.fillText(
        `True angle (degs): ${trueAngleDeg.toFixed(1)}`,
        legendX + legendWidth / 2, textY_TrueAngle);
  } else {
    ctx.fillText('True angle (degs): ---', legendX + legendWidth / 2, textY_TrueAngle);
  }

  if (rmsAngleError !== null) {
    ctx.fillText(
        `RMS angle error (degs): ${rmsAngleError.toFixed(1)}`,
        legendX + legendWidth / 2, textY2);
  } else {
    ctx.fillText(
        'RMS angle error (degs): ---', legendX + legendWidth / 2, textY2);
  }

  if (meanAngleError !== null) {
    ctx.fillText(
        `Mean angle error (degs): ${meanAngleError.toFixed(1)}`,
        legendX + legendWidth / 2, textY_MeanAngle);
  } else {
    ctx.fillText(
        'Mean angle error (degs): ---', legendX + legendWidth / 2, textY_MeanAngle);
  }

  if (arrowGtAngleErrDeg !== null) {
    ctx.font = 'bold 10.5px sans-serif';
    ctx.fillText(
        `Est. Target to GT angle err (degs): ${arrowGtAngleErrDeg.toFixed(1)}`,
        legendX + legendWidth / 2, textY3);
    ctx.font = 'bold 12px sans-serif';
  } else {
    ctx.font = 'bold 10.5px sans-serif';
    ctx.fillText(
        'Est. Target to GT angle err (degs): ---', legendX + legendWidth / 2, textY3);
    ctx.font = 'bold 12px sans-serif';
  }

  if (displayDistM !== null) {
    ctx.fillText(
        `Est. dist. (m): ${displayDistM.toFixed(1)}`, legendX + legendWidth / 2,
        textY4);
  } else {
    ctx.fillText('Est. dist. (m): ---', legendX + legendWidth / 2, textY4);
  }

  if (trueDistM !== null) {
    ctx.fillText(
        `True dist (m): ${trueDistM.toFixed(1)}`, legendX + legendWidth / 2,
        textY_TrueDist);
  } else {
    ctx.fillText('True dist (m): ---', legendX + legendWidth / 2, textY_TrueDist);
  }

  if (rmsDistError !== null) {
    ctx.fillText(
        `RMS dist error (m): ${rmsDistError.toFixed(1)}`,
        legendX + legendWidth / 2, textY5);
  } else {
    ctx.fillText('RMS dist error (m): ---', legendX + legendWidth / 2, textY5);
  }

  if (meanDistError !== null) {
    ctx.fillText(
        `Mean dist error (m): ${meanDistError.toFixed(1)}`,
        legendX + legendWidth / 2, textY_MeanDist);
  } else {
    ctx.fillText('Mean dist error (m): ---', legendX + legendWidth / 2, textY_MeanDist);
  }

  if (arrowGtDistErrM !== null) {
    ctx.font = 'bold 10.5px sans-serif';
    ctx.fillText(
        `Est. Target to GT dist err (m): ${arrowGtDistErrM.toFixed(1)}`,
        legendX + legendWidth / 2, textY6);
    ctx.font = 'bold 12px sans-serif';
  } else {
    ctx.font = 'bold 10.5px sans-serif';
    ctx.fillText(
        'Est. Target to GT dist err (m): ---', legendX + legendWidth / 2, textY6);
    ctx.font = 'bold 12px sans-serif';
  }

  ctx.fillText(
      `Error Ref: ${errorRefLabel}`, legendX + legendWidth / 2, textY7);

  /**
   * Draws a themed radio button control onto the canvas context.
   *
   * <p>
   * Renders the outer circular bezel, selection dot, and text label.
   * </p>
   *
   * @param {!CanvasRenderingContext2D} ctx 2D rendering context.
   * @param {number} x Left horizontal coordinate for the radio button.
   * @param {number} y Vertical center coordinate.
   * @param {string} label Label text to display beside the button.
   * @param {boolean} isChecked Whether the radio option is currently selected.
   */
  function drawCanvasRadioButton(ctx, x, y, label, isChecked) {
    ctx.save();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 6, y, 6, 0, 2 * Math.PI);
    ctx.stroke();

    if (isChecked) {
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.arc(x + 6, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = 'white';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 16, y);
    ctx.restore();
  }


  const radioGap = 25;
  const totalRadioRowW = radioW_Enhanced + radioGap + radioW_Phone;
  const startRadioX = legendX + (legendWidth - totalRadioRowW) / 2;

  const radioX1 = startRadioX;
  const radioX2 = startRadioX + radioW_Enhanced + radioGap;
  const radioH = 18;

  drawCanvasRadioButton(ctx, radioX1, textY8, 'Enhanced', metricRef === 'Enhanced');
  canvas._plotBoxes.push({
    x: radioX1 - 2,
    y: textY8 - 7,
    w: radioW_Enhanced + 4,
    h: radioH,
    key: 'metricReference',
    value: 'Enhanced',
    type: 'radio'
  });

  drawCanvasRadioButton(ctx, radioX2, textY8, 'Phone', metricRef === 'Phone');
  canvas._plotBoxes.push({
    x: radioX2 - 2,
    y: textY8 - 7,
    w: radioW_Phone + 4,
    h: radioH,
    key: 'metricReference',
    value: 'Phone',
    type: 'radio'
  });

  // Draw Arrow
  if (estimatedAngleRad !== null) {
    const cx = legendX + legendWidth / 2;
    const cy = greenBoxY + 74;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-estimatedAngleRad);  // Screen angle is -worldAngle

    ctx.fillStyle = 'white';
    ctx.beginPath();

    const L = 1.5 * (96 / 2.54);  // ~56.7 px
    const W = 0.5 * (96 / 2.54);  // ~18.9 px
    const headLen = L * 0.35;
    const headWidth = W * 1.8;

    ctx.moveTo(-L / 2, -W / 2);
    ctx.lineTo(L / 2 - headLen, -W / 2);
    ctx.lineTo(L / 2 - headLen, -headWidth / 2);
    ctx.lineTo(L / 2, 0);
    ctx.lineTo(L / 2 - headLen, headWidth / 2);
    ctx.lineTo(L / 2 - headLen, W / 2);
    ctx.lineTo(-L / 2, W / 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // Draw Skinny Navy Blue Arrow on top of White Arrow
  if (gtAngleRad !== null) {
    const cx = legendX + legendWidth / 2;
    const cy = greenBoxY + 74;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-gtAngleRad);  // Screen angle is -worldAngle

    ctx.fillStyle = '#000080';  // Navy blue
    ctx.beginPath();

    const L_gt = 1.5 * (96 / 2.54);
    const W_gt = 0.15 * (96 / 2.54);  // Skinny shaft
    const headLen_gt = L_gt * 0.35;
    const headWidth_gt = W_gt * 2.5;  // Slightly wider head relative to shaft

    ctx.moveTo(-L_gt / 2, -W_gt / 2);
    ctx.lineTo(L_gt / 2 - headLen_gt, -W_gt / 2);
    ctx.lineTo(L_gt / 2 - headLen_gt, -headWidth_gt / 2);
    ctx.lineTo(L_gt / 2, 0);
    ctx.lineTo(L_gt / 2 - headLen_gt, headWidth_gt / 2);
    ctx.lineTo(L_gt / 2 - headLen_gt, W_gt / 2);
    ctx.lineTo(-L_gt / 2, W_gt / 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
} else {
  canvas._apDirectionBounds = null;
}

  const biasInput = document.getElementById('auto-range-bias-val');
  if (biasInput) {
    const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
    if (rangeBiasMode === 'none') {
      biasInput.value = '---';
    } else if (rangeBiasMode === 'manual') {
      let manualBias = parseFloat(document.getElementById('manual-bias')?.value);
      if (isNaN(manualBias)) {
        manualBias = (typeof window.manualBias === 'number' && !isNaN(window.manualBias)) ? window.manualBias : 0.5;
      }
      biasInput.value = manualBias.toFixed(2);
    } else if (rangeBiasMode === 'auto') {
      let finalBias = null;
      if (ransacMode !== 'none') {
        if (finalSpatialRansacTarget && typeof finalSpatialRansacTarget.bias === 'number' && !isNaN(finalSpatialRansacTarget.bias)) {
          finalBias = finalSpatialRansacTarget.bias;
        } else if (fullEnhancedTarget && typeof fullEnhancedTarget.bias === 'number' && !isNaN(fullEnhancedTarget.bias)) {
          finalBias = fullEnhancedTarget.bias;
        } else if (enhancedTargetPath && enhancedTargetPath.length > 0) {
          const lastTarget = enhancedTargetPath[enhancedTargetPath.length - 1];
          if (lastTarget && typeof lastTarget.bias === 'number' && !isNaN(lastTarget.bias)) {
            finalBias = lastTarget.bias;
          }
        }
      } else if (fullEnhancedTarget && typeof fullEnhancedTarget.bias === 'number' && !isNaN(fullEnhancedTarget.bias)) {
         finalBias = fullEnhancedTarget.bias;
      } else if (enhancedTargetPath && enhancedTargetPath.length > 0) {
        const lastTarget = enhancedTargetPath[enhancedTargetPath.length - 1];
        if (lastTarget && typeof lastTarget.bias === 'number' && !isNaN(lastTarget.bias)) {
          finalBias = lastTarget.bias;
        }
      }
      biasInput.value = (finalBias !== null && !isNaN(finalBias)) ? finalBias.toFixed(2) : '---';
    }
  }

  const rmsPosInput = document.getElementById('enhanced-rms-pos-val');
  if (rmsPosInput) {
    const lastTarget = (enhancedTargetPath && enhancedTargetPath.length > 0) ? enhancedTargetPath[enhancedTargetPath.length - 1] : null;
    const ngRmsErr = (lastTarget && typeof lastTarget.err === 'number' && !isNaN(lastTarget.err)) ? lastTarget.err : null;
    rmsPosInput.value = (ngRmsErr !== null) ? ngRmsErr.toFixed(2) : '---';
  }

  // Draw loaded filenames at the bottom left of the canvas if enabled
  if (canvas._plotState && canvas._plotState.includeFilenames) {
    const findFile = (document.getElementById('log-file-text')?.value) || localStorage.getItem('lastLogFile') || '---';
    const gtFile = (document.getElementById('gt-file-text')?.value) || localStorage.getItem('lastGtFile') || '---';
    const fileTextStr = `Find: ${findFile}, GT: ${gtFile}`;

    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fileTextStr, 10, height - 10);
    ctx.restore();
  }
};
console.log('plot.js loaded and drawPlot defined.');
