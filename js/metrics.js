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

window.addEventListener('load', () => {
  const btnGenerate = document.getElementById('btn-generate-cdfs');
  const modal = document.getElementById('cdf-modal');
  const btnClose = document.getElementById('cdf-modal-close');

  if (!btnGenerate || !modal) return;

  let currentAngleCdfData = null;
  let currentDistCdfData = null;
  let cdfState = { showOrigAngle: true, showEnhAngle: true, showOrigDist: true, showEnhDist: true };

  btnGenerate.addEventListener('click', () => {
    if (!window.currentParsedData || !window.currentParsedData.data) {
      alert('Please load a log file first.');
      return;
    }
    modal.style.display = 'flex';
    const mainMin = document.getElementById('slider-min');
    const mainMax = document.getElementById('slider-max');
    if (mainMin && mainMax && typeof window.updateMetricsSliderLimits === 'function') {
      const effectiveMax = parseInt(mainMin.max, 10) || 100;
      const pStart = parseInt(mainMin.value, 10) || 0;
      const pEnd = parseInt(mainMax.value, 10) || effectiveMax;
      window.updateMetricsSliderLimits(effectiveMax, pStart, pEnd);
    }
    calculateAndRenderCDFs();
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => { modal.style.display = 'none'; });
  }
  window.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  /**
   * Calculates cumulative distribution functions for angle and distance errors.
   *
   * <p>
   * Filters error samples against the active step range, computes CDF arrays,
   * updates summary statistics tables, and renders the CDF canvases.
   * </p>
   */
  function calculateAndRenderCDFs() {
    const pData = window.currentParsedData;
    if (!pData || !pData.data || !pData.gtData || pData.gtData.length === 0) {
      console.warn('Missing data or ground truth for CDFs');
      return;
    }

    const trueTarget = pData.gtData[pData.gtData.length - 1];
    if (!trueTarget || trueTarget.x === undefined || trueTarget.y === undefined) {
      alert('True Target coordinates not available. Please load GT Coords file.');
      return;
    }

    const T_x = trueTarget.x;
    const T_y = trueTarget.y;

    const origAngleErrors = [];
    const enhAngleErrors = [];
    const origDistErrors = [];
    const enhDistErrors = [];

    const origData = pData.data;
    const enhData = pData.enhancedPdrData || [];

    const minS = typeof window.getSharedMinStep === 'function' ? window.getSharedMinStep() : 0;
    const maxS = typeof window.getSharedMaxStep === 'function' ? window.getSharedMaxStep() : Infinity;

    // Calculate errors for Phone PDR
    origData.forEach(r => {
      const step = parseInt(r['Steps(int)'], 10);
      if (step < 3 || step < minS || step > maxS) return;
      const r_s = parseFloat(r['Range(m)']);
      const measAngle = parseFloat(r['Direction(deg)']);
      const x = parseFloat(r['PdrX(m)']);
      const y = parseFloat(r['PdrY(m)']);

      const validRangesSoFar = origData.filter(o => {
        const oStep = parseInt(o['Steps(int)'], 10);
        return oStep <= step && oStep >= minS && oStep <= maxS && parseFloat(o['Range(m)']) > 0;
      }).length;
      if (validRangesSoFar < 3) return;

      if (!isNaN(x) && !isNaN(y) && !isNaN(r_s)) {
        const dx = T_x - x;
        const dy = T_y - y;
        const trueDist = Math.sqrt(dx * dx + dy * dy);
        origDistErrors.push({ step, err: Math.abs(r_s - trueDist) });

        if (!isNaN(measAngle)) {
          const trueAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
          let diff = measAngle - trueAngleDeg;
          while (diff > 180) diff -= 360;
          while (diff < -180) diff += 360;
          origAngleErrors.push({ step, err: Math.abs(diff) });
        }
      }
    });

    // Calculate errors for Enhanced PDR
    enhData.forEach(r => {
      const step = parseInt(r['Steps(int)'], 10);
      if (step < 3 || step < minS || step > maxS) return;
      
      let r_s = parseFloat(r['Range(m)']);
      const isRansacActive = (window.ransacMode === 'ransac-only' || window.ransacMode === 'ransac-step');
      const isPruned = isRansacActive && window.currentRansacKeptSteps && !window.currentRansacKeptSteps.includes(step);
      if (isPruned) {
        r_s = NaN;
      }

      const origRow = origData.find(o => parseInt(o['Steps(int)'], 10) === step);
      const measAngle = origRow ? parseFloat(origRow['Direction(deg)']) : NaN;
      const x = parseFloat(r.x);
      const y = parseFloat(r.y);

      const validRangesSoFar = enhData.filter(e => {
        const eStep = parseInt(e['Steps(int)'], 10);
        if (eStep > step || eStep < minS || eStep > maxS) return false;
        const eRange = (isRansacActive && window.currentRansacKeptSteps && !window.currentRansacKeptSteps.includes(eStep)) ? NaN : parseFloat(e['Range(m)']);
        return eRange > 0 && !isNaN(eRange);
      }).length;

      if (validRangesSoFar < 3) return;

      const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
      let manualBias = parseFloat(document.getElementById('manual-bias')?.value);
      if (isNaN(manualBias)) {
        manualBias = (typeof window.manualBias === 'number' && !isNaN(window.manualBias)) ? window.manualBias : 0.5;
      }
      let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
      if (isNaN(scaleRange) || scaleRange <= 0) {
        scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
      }

      let r_adj = r_s;
      if (!isNaN(r_s)) {
        if (rangeBiasMode === 'none') {
          r_adj = r_s * scaleRange;
        } else if (rangeBiasMode === 'manual') {
          r_adj = (r_s - manualBias) * scaleRange;
        } else if (rangeBiasMode === 'auto') {
          let stepBias = 0.0;
          if (window.currentEnhancedTargetPath && window.currentEnhancedTargetPath.length > 0) {
            const node = window.currentEnhancedTargetPath.find(n => n.step === step);
            if (node && typeof node.bias === 'number' && !isNaN(node.bias)) {
               stepBias = node.bias;
            }
          }
          r_adj = (r_s - stepBias) * scaleRange;
        }
      }

      if (!isNaN(x) && !isNaN(y) && !isNaN(r_adj)) {
        const dx = T_x - x;
        const dy = T_y - y;
        const trueDist = Math.sqrt(dx * dx + dy * dy);
        enhDistErrors.push({ step, err: Math.abs(r_adj - trueDist) });

        if (!isNaN(measAngle)) {
          const trueAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
          let diff = measAngle - trueAngleDeg;
          while (diff > 180) diff -= 360;
          while (diff < -180) diff += 360;
          enhAngleErrors.push({ step, err: Math.abs(diff) });
        }
      }
    });

    /**
     * Generates a sorted cumulative distribution function from error values.
     *
     * <p>
     * Sorts the numeric errors ascending and pairs each sample value with its
     * cumulative empirical probability from 0.0 to 1.0.
     * </p>
     *
     * @param {!Array<!Object>} errList Error objects with err and step.
     * @return {!Array<!Object>} Array of CDF points with err, cdf, and step.
     */
    function makeCDF(errList) {
      const valid = errList.filter(e => !isNaN(e.err)).sort((a, b) => a.err - b.err);
      if (valid.length === 0) return [];
      return valid.map((e, i) => ({ err: e.err, cdf: ((i + 1) / valid.length) * 100, step: e.step }));
    }

    currentAngleCdfData = { orig: makeCDF(origAngleErrors), enh: makeCDF(enhAngleErrors) };
    currentDistCdfData = { orig: makeCDF(origDistErrors), enh: makeCDF(enhDistErrors) };

    renderCdfChart('canvas-cdf-angle', currentAngleCdfData, cdfState.showOrigAngle, cdfState.showEnhAngle, 'Angle Error (deg)', 'CDF (%)', 'showOrigAngle', 'showEnhAngle');
    renderCdfChart('canvas-cdf-dist', currentDistCdfData, cdfState.showOrigDist, cdfState.showEnhDist, 'Distance Error (m)', 'CDF (%)', 'showOrigDist', 'showEnhDist');
  }

  /**
   * Renders a CDF chart with axes, gridlines, curves, and legend on a canvas.
   *
   * <p>
   * Draws original and enhanced CDF curves with shaded areas, reference ticks,
   * and median probability indicators.
   * </p>
   *
   * @param {string} canvasId ID of the target canvas element.
   * @param {!Object} dataObj Original and enhanced CDF data arrays.
   * @param {boolean} showOrig Whether to render the original dataset curve.
   * @param {boolean} showEnh Whether to render the enhanced dataset curve.
   * @param {string} xLabel Label text for the horizontal axis.
   * @param {string} yLabel Label text for the vertical axis.
   * @param {string} origKey Key name for original dataset visibility state.
   * @param {string} enhKey Key name for enhanced dataset visibility state.
   */
  function renderCdfChart(canvasId, dataObj, showOrig, showEnh, xLabel, yLabel, origKey, enhKey) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const parent = canvas.parentElement;
    const width = parent.clientWidth || 500;
    const height = parent.clientHeight || 350;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    canvas._cdfMeta = { dataObj, showOrig, showEnh, xLabel, yLabel, origKey, enhKey };

    if (!canvas._cdfClickAttached) {
      canvas._cdfClickAttached = true;
      canvas.addEventListener('click', (e) => {
        if (!canvas._legendBoxes) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const box of canvas._legendBoxes) {
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
            cdfState[box.key] = !cdfState[box.key];
            calculateAndRenderCDFs();
            break;
          }
        }
      });
      canvas.addEventListener('mousemove', (e) => {
        if (!canvas._legendBoxes) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        let hover = false;
        for (const box of canvas._legendBoxes) {
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
            hover = true;
            break;
          }
        }
        canvas.style.cursor = hover ? 'pointer' : 'default';
      });
    }

    const origPts = showOrig ? dataObj.orig : [];
    const enhPts = showEnh ? dataObj.enh : [];
    const allPts = [...dataObj.orig, ...dataObj.enh];

    if (allPts.length === 0) {
      ctx.font = '14px sans-serif';
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.fillText('No data available for ' + xLabel, width / 2, height / 2);
      return;
    }

    let minX = Infinity, maxX = -Infinity;
    allPts.forEach(p => {
      if (p.err < minX) minX = p.err;
      if (p.err > maxX) maxX = p.err;
    });

    if (maxX === minX) { minX -= 1; maxX += 1; }
    const rangeX = maxX - minX;
    minX = 0;
    maxX += rangeX * 0.05;

    const minY = 0;
    const maxY = 100;

    const margin = { top: 40, right: 245, bottom: 50, left: 60 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    /**
     * Converts a data value to horizontal pixel coordinate on the canvas.
     *
     * @param {number} val Data value on the horizontal axis.
     * @return {number} Computed horizontal pixel coordinate.
     */
    function getX(val) { return margin.left + ((val - minX) / (maxX - minX)) * plotW; }

    /**
     * Converts a probability value to vertical pixel coordinate on canvas.
     *
     * @param {number} val Probability value on vertical axis (0.0 to 100.0).
     * @return {number} Computed vertical pixel coordinate.
     */
    function getY(val) { return margin.top + plotH - ((val - minY) / (maxY - minY)) * plotH; }

    // Grid & Axes
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 0.5;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'gray';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let xStep = Number(((maxX - minX) / 8).toPrecision(1));
    if (xStep <= 0) xStep = 1;
    let startX = Math.ceil(minX / xStep) * xStep;
    for (let x = startX; x <= maxX; x += xStep) {
      const sx = getX(x);
      ctx.beginPath(); ctx.moveTo(sx, margin.top); ctx.lineTo(sx, height - margin.bottom); ctx.stroke();
      ctx.fillText(x.toFixed(1), sx, height - margin.bottom + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = 0; y <= 100; y += 10) {
      const sy = getY(y);
      ctx.beginPath(); ctx.moveTo(margin.left, sy); ctx.lineTo(width - margin.right, sy); ctx.stroke();
      ctx.fillText(y + '%', margin.left - 5, sy);
    }

    ctx.fillStyle = 'black';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(xLabel, margin.left + plotW / 2, height - margin.bottom + 25);
    ctx.save();
    ctx.translate(margin.left - 40, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel.split(' ')[0] + ' CDF (Measured - True)', width / 2, 15);

    if (origPts.length > 0) {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      ctx.beginPath();
      origPts.forEach((p, i) => {
        const sx = getX(p.err);
        const sy = getY(p.cdf);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    if (enhPts.length > 0) {
      ctx.strokeStyle = 'orange';
      ctx.lineWidth = 2;
      ctx.beginPath();
      enhPts.forEach((p, i) => {
        const sx = getX(p.err);
        const sy = getY(p.cdf);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    // Legend
    const legW = 220;
    const legH = 165;
    const legX = margin.left + plotW + 10;
    const legY = margin.top;

    ctx.fillStyle = 'white'; ctx.strokeStyle = 'black'; ctx.lineWidth = 1;
    ctx.fillRect(legX, legY, legW, legH); ctx.strokeRect(legX, legY, legW, legH);

    canvas._legendBoxes = [];

    // Row 1: Original PDR Checkbox
    ctx.strokeRect(legX + 5, legY + 9, 12, 12);
    if (showOrig) {
      ctx.beginPath(); ctx.moveTo(legX + 7, legY + 14); ctx.lineTo(legX + 10, legY + 18); ctx.lineTo(legX + 15, legY + 11); ctx.stroke();
    }
    canvas._legendBoxes.push({ x: legX, y: legY + 5, w: legW, h: 20, key: origKey });

    ctx.strokeStyle = 'red'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(legX + 25, legY + 15); ctx.lineTo(legX + 45, legY + 15); ctx.stroke();
    ctx.fillStyle = 'black'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Phone PDR', legX + 50, legY + 15);

    const m = window.greenBoxSummaryMetrics || { phone: {}, enhanced: {} };
    const pM = m.phone || {};
    const eM = m.enhanced || {};

    const isDistChart = (xLabel && xLabel.includes('Distance')) || (yLabel && yLabel.includes('Distance'));

    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#444';

    const tOrig = isDistChart ? pM.trueDistM : pM.trueAngleDeg;
    const rOrig = isDistChart ? pM.rmsDistError : pM.rmsAngleError;
    const mOrig = isDistChart ? pM.meanDistError : pM.meanAngleError;
    const aOrig = isDistChart ? pM.arrowGtDistErrM : pM.arrowGtAngleErrDeg;
    const u = isDistChart ? 'm' : 'degs';
    const tLabel = isDistChart ? 'True dist' : 'True angle';

    ctx.fillText(`  ${tLabel} (${u}): ${tOrig != null ? tOrig.toFixed(1) : '---'}`, legX + 25, legY + 30);
    ctx.fillText(`  RMS Err (${u}): ${rOrig != null ? rOrig.toFixed(1) : '---'}`, legX + 25, legY + 44);
    ctx.fillText(`  Mean Err (${u}): ${mOrig != null ? mOrig.toFixed(1) : '---'}`, legX + 25, legY + 58);
    ctx.fillText(`  Est. Target to GT Err (${u}): ${aOrig != null ? aOrig.toFixed(1) : '---'}`, legX + 20, legY + 72);

    // Row 5: Enhanced PDR Checkbox
    const legY2 = legY + 82;
    ctx.strokeStyle = 'black'; ctx.lineWidth = 1; ctx.strokeRect(legX + 5, legY2 + 9, 12, 12);
    if (showEnh) {
      ctx.beginPath(); ctx.moveTo(legX + 7, legY2 + 14); ctx.lineTo(legX + 10, legY2 + 18); ctx.lineTo(legX + 15, legY2 + 11); ctx.stroke();
    }
    canvas._legendBoxes.push({ x: legX, y: legY2 + 5, w: legW, h: 20, key: enhKey });

    ctx.strokeStyle = 'orange'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(legX + 25, legY2 + 15); ctx.lineTo(legX + 45, legY2 + 15); ctx.stroke();
    ctx.fillStyle = 'black'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText('Enhanced PDR', legX + 50, legY2 + 15);

    const tEnh = isDistChart ? eM.trueDistM : eM.trueAngleDeg;
    const rEnh = isDistChart ? eM.rmsDistError : eM.rmsAngleError;
    const mEnh = isDistChart ? eM.meanDistError : eM.meanAngleError;
    const aEnh = isDistChart ? eM.arrowGtDistErrM : eM.arrowGtAngleErrDeg;

    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#444';
    ctx.fillText(`  ${tLabel} (${u}): ${tEnh != null ? tEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 30);
    ctx.fillText(`  RMS Err (${u}): ${rEnh != null ? rEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 44);
    ctx.fillText(`  Mean Err (${u}): ${mEnh != null ? mEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 58);
    ctx.fillText(`  Est. Target to GT Err (${u}): ${aEnh != null ? aEnh.toFixed(1) : '---'}`, legX + 20, legY2 + 72);
  }

  /**
   * Exports CDF error and percentile data to a downloaded CSV file.
   *
   * <p>
   * Formats percentiles and error values for original and enhanced datasets
   * into comma-separated text and triggers a browser file download.
   * </p>
   *
   * @param {string} filename Output name for the downloaded file.
   * @param {!Object} dataObj Object containing orig and enh CDF point arrays.
   * @param {string} errLabel Column header description for the error metric.
   */
  function downloadCSV(filename, dataObj, errLabel) {
    if (!dataObj || (!dataObj.orig.length && !dataObj.enh.length)) {
      alert('No CDF data to save.');
      return;
    }
    let csv = `Step,Original_${errLabel},Original_CDF(%),Enhanced_${errLabel},Enhanced_CDF(%)\n`;
    const maxLen = Math.max(dataObj.orig.length, dataObj.enh.length);
    for (let i = 0; i < maxLen; i++) {
      const o = dataObj.orig[i] || { step: '', err: '', cdf: '' };
      const e = dataObj.enh[i] || { step: '', err: '', cdf: '' };
      csv += `${o.step !== '' ? o.step : (e.step !== '' ? e.step : '')},${o.err !== '' ? o.err.toFixed(4) : ''},${o.cdf !== '' ? o.cdf.toFixed(2) : ''},${e.err !== '' ? e.err.toFixed(4) : ''},${e.cdf !== '' ? e.cdf.toFixed(2) : ''}\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Exports a chart canvas to a downloaded PNG image file.
   *
   * <p>
   * Converts the canvas image bitmap to a PNG data URL and triggers an
   * automatic browser download.
   * </p>
   *
   * @param {string} filename Output filename for the downloaded image.
   * @param {string} canvasId ID of the source HTMLCanvasElement.
   */
  function downloadPNG(filename, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    
    tempCtx.fillStyle = '#fafafa';
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tempCtx.drawImage(canvas, 0, 0);
    
    const url = tempCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  document.getElementById('btn-save-angle-csv')?.addEventListener('click', () => {
    downloadCSV('Angle_Error_CDF.csv', currentAngleCdfData, 'AngleErr(deg)');
  });
  document.getElementById('btn-save-angle-png')?.addEventListener('click', () => {
    downloadPNG('Angle_Error_CDF.png', 'canvas-cdf-angle');
  });
  document.getElementById('btn-save-dist-csv')?.addEventListener('click', () => {
    downloadCSV('Distance_Error_CDF.csv', currentDistCdfData, 'DistErr(m)');
  });
  document.getElementById('btn-save-dist-png')?.addEventListener('click', () => {
    downloadPNG('Distance_Error_CDF.png', 'canvas-cdf-dist');
  });

  const btnSteps = document.getElementById('btn-generate-steps');
  const stepModal = document.getElementById('step-modal');
  const stepBtnClose = document.getElementById('step-modal-close');

  let currentStepAngleData = null;
  let currentStepDistData = null;
  let stepState = { showOrigAngle: true, showEnhAngle: true, showOrigDist: true, showEnhDist: true };

  btnSteps?.addEventListener('click', () => {
    if (!window.currentParsedData || !window.currentParsedData.data) {
      alert('Please load a log file first.');
      return;
    }
    stepModal.style.display = 'flex';
    const mainMin = document.getElementById('slider-min');
    const mainMax = document.getElementById('slider-max');
    if (mainMin && mainMax && typeof window.updateMetricsSliderLimits === 'function') {
      const effectiveMax = parseInt(mainMin.max, 10) || 100;
      const pStart = parseInt(mainMin.value, 10) || 0;
      const pEnd = parseInt(mainMax.value, 10) || effectiveMax;
      window.updateMetricsSliderLimits(effectiveMax, pStart, pEnd);
    }
    calculateAndRenderStepCharts();
  });

  stepBtnClose?.addEventListener('click', () => { stepModal.style.display = 'none'; });
  window.addEventListener('click', (e) => {
    if (e.target === stepModal) stepModal.style.display = 'none';
  });

  /**
   * Computes and renders step-by-step error charts across playback steps.
   *
   * <p>
   * Calculates per-step angle and distance errors against ground truth target
   * positions and updates the step error chart canvases.
   * </p>
   */
  function calculateAndRenderStepCharts() {
    const pData = window.currentParsedData;
    if (!pData || !pData.data || !pData.gtData || pData.gtData.length === 0) return;

    const trueTarget = pData.gtData[pData.gtData.length - 1];
    if (!trueTarget || trueTarget.x === undefined || trueTarget.y === undefined) return;

    const T_x = trueTarget.x;
    const T_y = trueTarget.y;

    const origAngleErrors = [];
    const enhAngleErrors = [];
    const origDistErrors = [];
    const enhDistErrors = [];

    const origData = pData.data;
    const enhData = pData.enhancedPdrData || [];

    let foundStep = -1;
    for (let i = 0; i < origData.length; i++) {
      if (parseInt(origData[i]['findState(int)'], 10) === 2) {
        foundStep = origData[i]['Steps(int)'];
        break;
      }
    }

    const divInput = document.getElementById('enhanced-diversity');
    const diversityThreshold = divInput ? parseFloat(divInput.value) : 0.8;
    let foundStepEnh = -1;
    if (window.calculatePathDiversity && enhData.length > 0) {
      const mappedEnhData = enhData.map(p => ({ x: p.x, y: p.y }));
      for (let i = 0; i < enhData.length; i++) {
        const pathSubset = mappedEnhData.slice(0, i + 1);
        const div = window.calculatePathDiversity(pathSubset);
        if (div >= diversityThreshold) {
          foundStepEnh = enhData[i]['Steps(int)'];
          break;
        }
      }
    }

    const minS = typeof window.getSharedMinStep === 'function' ? window.getSharedMinStep() : 0;
    const maxS = typeof window.getSharedMaxStep === 'function' ? window.getSharedMaxStep() : Infinity;

    origData.forEach(r => {
      const step = parseInt(r['Steps(int)'], 10);
      if (step < 3 || step < minS || step > maxS) return;
      const r_s = parseFloat(r['Range(m)']);
      const measAngle = parseFloat(r['Direction(deg)']);
      const x = parseFloat(r['PdrX(m)']);
      const y = parseFloat(r['PdrY(m)']);

      const validRangesSoFar = origData.filter(o => {
        const oStep = parseInt(o['Steps(int)'], 10);
        return oStep <= step && oStep >= minS && oStep <= maxS && parseFloat(o['Range(m)']) > 0;
      }).length;
      if (validRangesSoFar < 3) return;

      if (!isNaN(x) && !isNaN(y) && !isNaN(r_s)) {
        const dx = T_x - x;
        const dy = T_y - y;
        const trueDist = Math.sqrt(dx * dx + dy * dy);
        origDistErrors.push({ step, err: Math.abs(r_s - trueDist) });

        if (!isNaN(measAngle)) {
          const trueAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
          let diff = measAngle - trueAngleDeg;
          while (diff > 180) diff -= 360;
          while (diff < -180) diff += 360;
          origAngleErrors.push({ step, err: Math.abs(diff) });
        }
      }
    });

    enhData.forEach(r => {
      const step = parseInt(r['Steps(int)'], 10);
      if (step < 3 || step < minS || step > maxS) return;
      
      let r_s = parseFloat(r['Range(m)']);
      const isRansacActive = (window.ransacMode === 'ransac-only' || window.ransacMode === 'ransac-step');
      const isPruned = isRansacActive && window.currentRansacKeptSteps && !window.currentRansacKeptSteps.includes(step);
      if (isPruned) {
        r_s = NaN;
      }

      const origRow = origData.find(o => parseInt(o['Steps(int)'], 10) === step);
      const measAngle = origRow ? parseFloat(origRow['Direction(deg)']) : NaN;
      const x = parseFloat(r.x);
      const y = parseFloat(r.y);

      const validRangesSoFar = enhData.filter(e => {
        const eStep = parseInt(e['Steps(int)'], 10);
        if (eStep > step || eStep < minS || eStep > maxS) return false;
        const eRange = (isRansacActive && window.currentRansacKeptSteps && !window.currentRansacKeptSteps.includes(eStep)) ? NaN : parseFloat(e['Range(m)']);
        return eRange > 0 && !isNaN(eRange);
      }).length;

      if (validRangesSoFar < 3) return;

      const rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || window.rangeBiasMode || 'none';
      let manualBias = parseFloat(document.getElementById('manual-bias')?.value);
      if (isNaN(manualBias)) {
        manualBias = (typeof window.manualBias === 'number' && !isNaN(window.manualBias)) ? window.manualBias : 0.5;
      }
      let scaleRange = parseFloat(document.getElementById('scale-range')?.value);
      if (isNaN(scaleRange) || scaleRange <= 0) {
        scaleRange = (typeof window.scaleRange === 'number' && !isNaN(window.scaleRange) && window.scaleRange > 0) ? window.scaleRange : 0.93;
      }

      let r_adj = r_s;
      if (!isNaN(r_s)) {
        if (rangeBiasMode === 'none') {
          r_adj = r_s * scaleRange;
        } else if (rangeBiasMode === 'manual') {
          r_adj = (r_s - manualBias) * scaleRange;
        } else if (rangeBiasMode === 'auto') {
          let stepBias = 0.0;
          if (window.currentEnhancedTargetPath && window.currentEnhancedTargetPath.length > 0) {
            const node = window.currentEnhancedTargetPath.find(n => n.step === step);
            if (node && typeof node.bias === 'number' && !isNaN(node.bias)) {
               stepBias = node.bias;
            }
          }
          r_adj = (r_s - stepBias) * scaleRange;
        }
      }

      if (!isNaN(x) && !isNaN(y) && !isNaN(r_adj)) {
        const dx = T_x - x;
        const dy = T_y - y;
        const trueDist = Math.sqrt(dx * dx + dy * dy);
        enhDistErrors.push({ step, err: Math.abs(r_adj - trueDist) });

        if (!isNaN(measAngle)) {
          const trueAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
          let diff = measAngle - trueAngleDeg;
          while (diff > 180) diff -= 360;
          while (diff < -180) diff += 360;
          enhAngleErrors.push({ step, err: Math.abs(diff) });
        }
      }
    });

    origDistErrors.sort((a, b) => a.step - b.step);
    enhDistErrors.sort((a, b) => a.step - b.step);
    origAngleErrors.sort((a, b) => a.step - b.step);
    enhAngleErrors.sort((a, b) => a.step - b.step);

    currentStepAngleData = { orig: origAngleErrors, enh: enhAngleErrors };
    currentStepDistData = { orig: origDistErrors, enh: enhDistErrors };

    renderStepChart('canvas-step-angle', currentStepAngleData, stepState.showOrigAngle, stepState.showEnhAngle, 'Step Number', 'Angle Error (deg)', 'showOrigAngle', 'showEnhAngle', foundStep, foundStepEnh);
    renderStepChart('canvas-step-dist', currentStepDistData, stepState.showOrigDist, stepState.showEnhDist, 'Step Number', 'Distance Error (m)', 'showOrigDist', 'showEnhDist', foundStep, foundStepEnh);
  }

  /**
   * Renders error vs step line charts on the specified canvas.
   *
   * <p>
   * Draws time-series error curves for original and enhanced trajectories with
   * metric statistics summaries and step markers.
   * </p>
   *
   * @param {string} canvasId ID of the target canvas element.
   * @param {!Object} dataObj Object containing orig and enh step error arrays.
   * @param {boolean} showOrig Whether to draw the original trajectory errors.
   * @param {boolean} showEnh Whether to draw the enhanced trajectory errors.
   * @param {string} xLabel Label text for the horizontal step axis.
   * @param {string} yLabel Label text for the vertical error axis.
   * @param {string} origKey Key name for original dataset visibility state.
   * @param {string} enhKey Key name for enhanced dataset visibility state.
   * @param {number} foundStep Step index where target was identified.
   * @param {number} foundStepEnh Step index where enhanced diversity was met.
   */
  function renderStepChart(canvasId, dataObj, showOrig, showEnh, xLabel, yLabel, origKey, enhKey, foundStep, foundStepEnh) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const parent = canvas.parentElement;
    const width = parent.clientWidth || 500;
    const height = parent.clientHeight || 350;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    canvas._stepMeta = { dataObj, showOrig, showEnh, xLabel, yLabel, origKey, enhKey, foundStep, foundStepEnh };

    if (!canvas._stepClickAttached) {
      canvas._stepClickAttached = true;
      canvas.addEventListener('click', (e) => {
        if (!canvas._legendBoxes) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const box of canvas._legendBoxes) {
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
            stepState[box.key] = !stepState[box.key];
            calculateAndRenderStepCharts();
            break;
          }
        }
      });
      canvas.addEventListener('mousemove', (e) => {
        if (!canvas._legendBoxes) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        let hover = false;
        for (const box of canvas._legendBoxes) {
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
            hover = true;
            break;
          }
        }
        canvas.style.cursor = hover ? 'pointer' : 'default';
      });
    }

    const origPts = showOrig ? dataObj.orig : [];
    const enhPts = showEnh ? dataObj.enh : [];
    const allPts = [...dataObj.orig, ...dataObj.enh];

    if (allPts.length === 0) {
      ctx.font = '14px sans-serif';
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.fillText('No data available for ' + yLabel, width / 2, height / 2);
      return;
    }

    const minX = 0;
    let maxX = 0;
    let maxErr = 0;
    allPts.forEach(p => {
      if (p.step > maxX) maxX = p.step;
      if (p.err > maxErr) maxErr = p.err;
    });

    if (maxX === 0) maxX = 10;
    if (maxErr === 0) maxErr = 10;

    const minY = 0;
    const maxY = maxErr * 1.05;

    const margin = { top: 40, right: 245, bottom: 50, left: 60 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    /**
     * Maps step number to horizontal canvas pixel coordinate.
     *
     * @param {number} val Step index value.
     * @return {number} Pixel horizontal coordinate on the canvas.
     */
    function getX(val) { return margin.left + ((val - minX) / (maxX - minX)) * plotW; }

    /**
     * Maps error magnitude to vertical canvas pixel coordinate.
     *
     * @param {number} val Error metric value.
     * @return {number} Pixel vertical coordinate on the canvas.
     */
    function getY(val) { return margin.top + plotH - ((val - minY) / (maxY - minY)) * plotH; }

    // Grid & Axes
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 0.5;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'gray';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let xStep = Math.ceil(maxX / 10);
    if (xStep <= 0) xStep = 1;
    for (let x = 0; x <= maxX; x += xStep) {
      const sx = getX(x);
      ctx.beginPath(); ctx.moveTo(sx, margin.top); ctx.lineTo(sx, height - margin.bottom); ctx.stroke();
      ctx.fillText(x, sx, height - margin.bottom + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let yStep = Number((maxY / 5).toPrecision(1));
    if (yStep <= 0) yStep = 1;
    for (let y = 0; y <= maxY; y += yStep) {
      const sy = getY(y);
      ctx.beginPath(); ctx.moveTo(margin.left, sy); ctx.lineTo(width - margin.right, sy); ctx.stroke();
      ctx.fillText(y.toFixed(yStep < 1 ? 2 : 0), margin.left - 5, sy);
    }

    ctx.fillStyle = 'black';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(xLabel, margin.left + plotW / 2, height - margin.bottom + 25);
    ctx.save();
    ctx.translate(margin.left - 40, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(yLabel.split(' ')[0] + ' Error vs Step Number', width / 2, 15);

    if (origPts.length > 0) {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      ctx.beginPath();
      origPts.forEach((p, i) => {
        const sx = getX(p.step);
        const sy = getY(p.err);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    if (enhPts.length > 0) {
      ctx.strokeStyle = 'orange';
      ctx.lineWidth = 2;
      ctx.beginPath();
      enhPts.forEach((p, i) => {
        const sx = getX(p.step);
        const sy = getY(p.err);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    // Dashed green vertical line for Phone Found State
    if (showOrig && foundStep !== -1 && foundStep >= minX && foundStep <= maxX) {
      const sx = getX(foundStep);
      ctx.strokeStyle = 'rgba(0, 128, 0, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, margin.top);
      ctx.lineTo(sx, height - margin.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#006600';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Phone Found (Step ' + foundStep + ')', sx + 5, margin.top + 10);
    }

    // Dashed green vertical line for Enhanced FIRST Found State
    const firstEnhStep = window.firstEnhancedCrossingStep;
    if (showEnh && firstEnhStep !== undefined && firstEnhStep !== -1 && firstEnhStep >= minX && firstEnhStep <= maxX) {
      const sx = getX(firstEnhStep);
      ctx.strokeStyle = 'rgba(0, 128, 0, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, margin.top);
      ctx.lineTo(sx, height - margin.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#006600';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      
      let yOffset = margin.top + 10;
      if (foundStep !== -1 && Math.abs(foundStep - firstEnhStep) < (maxX - minX) * 0.1) {
        yOffset = margin.top + 25;
      }
      ctx.fillText('Enh First Found (Step ' + firstEnhStep + ')', sx + 5, yOffset);
    }

    // Dashed orange vertical line for Enhanced CURRENT Found State
    if (showEnh && foundStepEnh !== -1 && foundStepEnh >= minX && foundStepEnh <= maxX && foundStepEnh !== firstEnhStep) {
      const sx = getX(foundStepEnh);
      ctx.strokeStyle = 'rgba(255, 68, 68, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, margin.top);
      ctx.lineTo(sx, height - margin.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#cc0000';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      
      let yOffset = margin.top + 10;
      const nearPhone = (foundStep !== -1 && Math.abs(foundStep - foundStepEnh) < (maxX - minX) * 0.1);
      const nearFirst = (firstEnhStep !== undefined && firstEnhStep !== -1 && Math.abs(firstEnhStep - foundStepEnh) < (maxX - minX) * 0.1);
      
      if (nearPhone && nearFirst) {
        yOffset = margin.top + 40;
      } else if (nearPhone || nearFirst) {
        yOffset = margin.top + 25;
      }
      ctx.fillText('Enh Shifted Found (Step ' + foundStepEnh + ')', sx + 5, yOffset);
    }

    // Legend
    const legW = 220;
    const legH = 165;
    const legX = margin.left + plotW + 10;
    const legY = margin.top;

    ctx.fillStyle = 'white'; ctx.strokeStyle = 'black'; ctx.lineWidth = 1;
    ctx.fillRect(legX, legY, legW, legH); ctx.strokeRect(legX, legY, legW, legH);

    canvas._legendBoxes = [];

    // Row 1: Original PDR Checkbox
    ctx.strokeRect(legX + 5, legY + 9, 12, 12);
    if (showOrig) {
      ctx.beginPath(); ctx.moveTo(legX + 7, legY + 14); ctx.lineTo(legX + 10, legY + 18); ctx.lineTo(legX + 15, legY + 11); ctx.stroke();
    }
    canvas._legendBoxes.push({ x: legX, y: legY + 5, w: legW, h: 20, key: origKey });

    ctx.strokeStyle = 'red'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(legX + 25, legY + 15); ctx.lineTo(legX + 45, legY + 15); ctx.stroke();
    ctx.fillStyle = 'black'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Phone PDR', legX + 50, legY + 15);

    const m = window.greenBoxSummaryMetrics || { phone: {}, enhanced: {} };
    const pM = m.phone || {};
    const eM = m.enhanced || {};

    const isDistChart = (xLabel && xLabel.includes('Distance')) || (yLabel && yLabel.includes('Distance'));

    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#444';

    const tOrig = isDistChart ? pM.trueDistM : pM.trueAngleDeg;
    const rOrig = isDistChart ? pM.rmsDistError : pM.rmsAngleError;
    const mOrig = isDistChart ? pM.meanDistError : pM.meanAngleError;
    const aOrig = isDistChart ? pM.arrowGtDistErrM : pM.arrowGtAngleErrDeg;
    const u = isDistChart ? 'm' : 'degs';
    const tLabel = isDistChart ? 'True dist' : 'True angle';

    ctx.fillText(`  ${tLabel} (${u}): ${tOrig != null ? tOrig.toFixed(1) : '---'}`, legX + 25, legY + 30);
    ctx.fillText(`  RMS Err (${u}): ${rOrig != null ? rOrig.toFixed(1) : '---'}`, legX + 25, legY + 44);
    ctx.fillText(`  Mean Err (${u}): ${mOrig != null ? mOrig.toFixed(1) : '---'}`, legX + 25, legY + 58);
    ctx.fillText(`  Est. Target to GT Err (${u}): ${aOrig != null ? aOrig.toFixed(1) : '---'}`, legX + 20, legY + 72);

    // Row 5: Enhanced PDR Checkbox
    const legY2 = legY + 82;
    ctx.strokeStyle = 'black'; ctx.lineWidth = 1; ctx.strokeRect(legX + 5, legY2 + 9, 12, 12);
    if (showEnh) {
      ctx.beginPath(); ctx.moveTo(legX + 7, legY2 + 14); ctx.lineTo(legX + 10, legY2 + 18); ctx.lineTo(legX + 15, legY2 + 11); ctx.stroke();
    }
    canvas._legendBoxes.push({ x: legX, y: legY2 + 5, w: legW, h: 20, key: enhKey });

    ctx.strokeStyle = 'orange'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(legX + 25, legY2 + 15); ctx.lineTo(legX + 45, legY2 + 15); ctx.stroke();
    ctx.fillStyle = 'black'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText('Enhanced PDR', legX + 50, legY2 + 15);

    const tEnh = isDistChart ? eM.trueDistM : eM.trueAngleDeg;
    const rEnh = isDistChart ? eM.rmsDistError : eM.rmsAngleError;
    const mEnh = isDistChart ? eM.meanDistError : eM.meanAngleError;
    const aEnh = isDistChart ? eM.arrowGtDistErrM : eM.arrowGtAngleErrDeg;

    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#444';
    ctx.fillText(`  ${tLabel} (${u}): ${tEnh != null ? tEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 30);
    ctx.fillText(`  RMS Err (${u}): ${rEnh != null ? rEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 44);
    ctx.fillText(`  Mean Err (${u}): ${mEnh != null ? mEnh.toFixed(1) : '---'}`, legX + 25, legY2 + 58);
    ctx.fillText(`  Est. Target to GT Err (${u}): ${aEnh != null ? aEnh.toFixed(1) : '---'}`, legX + 20, legY2 + 72);
  }

  document.getElementById('btn-save-step-angle-csv')?.addEventListener('click', () => {
    downloadStepCSV('Angle_Error_vs_Step.csv', currentStepAngleData, 'AngleErr(deg)');
  });
  document.getElementById('btn-save-step-angle-png')?.addEventListener('click', () => {
    downloadPNG('Angle_Error_vs_Step.png', 'canvas-step-angle');
  });
  document.getElementById('btn-save-step-dist-csv')?.addEventListener('click', () => {
    downloadStepCSV('Distance_Error_vs_Step.csv', currentStepDistData, 'DistErr(m)');
  });
  document.getElementById('btn-save-step-dist-png')?.addEventListener('click', () => {
    downloadPNG('Distance_Error_vs_Step.png', 'canvas-step-dist');
  });

  /**
   * Exports step-by-step error metrics to a downloaded CSV file.
   *
   * <p>
   * Constructs step-aligned rows comparing original and enhanced error values
   * and triggers a browser file download.
   * </p>
   *
   * @param {string} filename Output name for the downloaded file.
   * @param {!Object} dataObj Object containing orig and enh step error arrays.
   * @param {string} errLabel Error column header label.
   */
  function downloadStepCSV(filename, dataObj, errLabel) {
    if (!dataObj || (!dataObj.orig.length && !dataObj.enh.length)) {
      alert('No step data to save.');
      return;
    }
    let csv = `Step,Original_${errLabel},Enhanced_${errLabel}\n`;
    const maxStep = Math.max(...dataObj.orig.map(p => p.step), ...dataObj.enh.map(p => p.step), 0);
    for (let s = 0; s <= maxStep; s++) {
      const o = dataObj.orig.find(p => p.step === s);
      const e = dataObj.enh.find(p => p.step === s);
      if (o || e) {
        csv += `${s},${o ? o.err.toFixed(4) : ''},${e ? e.err.toFixed(4) : ''}\n`;
      }
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Returns the current minimum playback step from the main slider widget.
   *
   * @return {number} Current minimum step integer value.
   */
  window.getSharedMinStep = function() {
    const mainMin = document.getElementById('slider-min');
    return mainMin ? parseInt(mainMin.value, 10) || 0 : 0;
  };

  /**
   * Returns the current maximum playback step from the main slider widget.
   *
   * @return {number} Current maximum step integer value.
   */
  window.getSharedMaxStep = function() {
    const mainMax = document.getElementById('slider-max');
    return mainMax ? parseInt(mainMax.value, 10) || 1000 : 1000;
  };

  /**
   * Synchronizes step limits and range positions across all metrics sliders.
   *
   * <p>
   * Updates minimum and maximum range inputs, visual slider fills, and text
   * labels across main and modal playback controls.
   * </p>
   *
   * @param {number} effectiveMax Maximum allowable step index.
   * @param {number} pStart Start step position of active range.
   * @param {number} pEnd End step position of active range.
   */
  window.updateMetricsSliderLimits = function(effectiveMax, pStart, pEnd) {
    const containers = document.querySelectorAll('.metrics-slider-container');
    containers.forEach(container => {
      const minInput = container.querySelector('.metrics-slider-min');
      const maxInput = container.querySelector('.metrics-slider-max');
      const fill = container.querySelector('.metrics-slider-range-fill');
      const text = container.nextElementSibling;
      
      if (minInput && maxInput) {
        minInput.max = effectiveMax;
        maxInput.max = effectiveMax;
        minInput.value = pStart;
        maxInput.value = pEnd;
        
        let leftPct = (pStart / effectiveMax) * 100;
        let widthPct = ((pEnd - pStart) / effectiveMax) * 100;
        if (fill) {
          fill.style.left = leftPct + '%';
          fill.style.width = widthPct + '%';
        }
        if (text && text.classList.contains('metrics-slider-val')) {
          text.innerText = `Step: ${pStart} - ${pEnd}`;
        }
      }
    });

    const mainMin = document.getElementById('slider-min');
    const mainMax = document.getElementById('slider-max');
    const mainFill = document.getElementById('slider-range-fill');
    const mainText = document.getElementById('slider-val');
    if (mainMin && mainMax) {
      mainMin.max = effectiveMax;
      mainMax.max = effectiveMax;
      mainMin.value = pStart;
      mainMax.value = pEnd;
      let leftPct = (pStart / effectiveMax) * 100;
      let widthPct = ((pEnd - pStart) / effectiveMax) * 100;
      if (mainFill) {
        mainFill.style.left = leftPct + '%';
        mainFill.style.width = widthPct + '%';
      }
      if (mainText) mainText.innerText = `Step: ${pStart} - ${pEnd}`;
    }
  };

  /**
   * Synchronizes all step sliders and redraws active plots and open modals.
   *
   * <p>
   * Normalizes step bounds, refreshes the primary plot canvas, and recalculates
   * visible CDF or step chart modal contents.
   * </p>
   *
   * @param {number} minVal Requested start step value.
   * @param {number} maxVal Requested end step value.
   */
  window.syncAllStepSliders = function(minVal, maxVal) {
    let pStart = Math.min(minVal, maxVal);
    let pEnd = Math.max(minVal, maxVal);

    const mainMin = document.getElementById('slider-min');
    const maxPossible = mainMin ? (parseInt(mainMin.max, 10) || 100) : 100;

    window.updateMetricsSliderLimits(maxPossible, pStart, pEnd);

    const canvas = document.getElementById('plot-canvas');
    if (canvas && window.currentParsedData && window.currentParsedData.data && typeof window.drawPlot === 'function') {
      const d = window.currentParsedData;
      window.drawPlot(canvas, d.data, d.targetData, d.gtInterpolated, pStart, pEnd, d.enhancedPdrData);
    }

    const cdfModal = document.getElementById('cdf-modal');
    if (cdfModal && cdfModal.style.display === 'flex') {
      calculateAndRenderCDFs();
    }
    const stepModal = document.getElementById('step-modal');
    if (stepModal && stepModal.style.display === 'flex') {
      calculateAndRenderStepCharts();
    }
  };

  /**
   * Attaches input event listeners to all modal metrics range sliders.
   *
   * <p>
   * Pauses active animation playback and dispatches synchronized step updates
   * on user interaction.
   * </p>
   */
  const wireMetricsSliders = () => {
    const containers = document.querySelectorAll('.metrics-slider-container');
    containers.forEach(container => {
      const minInput = container.querySelector('.metrics-slider-min');
      const maxInput = container.querySelector('.metrics-slider-max');
      if (minInput && maxInput) {
        minInput.addEventListener('input', () => {
          if (typeof window.pauseAnimation === 'function') window.pauseAnimation();
          window.syncAllStepSliders(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        });
        maxInput.addEventListener('input', () => {
          if (typeof window.pauseAnimation === 'function') window.pauseAnimation();
          window.syncAllStepSliders(parseInt(minInput.value, 10), parseInt(maxInput.value, 10));
        });
      }
    });
  };

  // Wait a moment for DOM to paint completely
  setTimeout(wireMetricsSliders, 100);
});
