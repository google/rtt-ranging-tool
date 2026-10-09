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

(function() {
  const TOTAL_COMBINATIONS = 1728;
  let isOptimizing = false;
  let cancelRequested = false;

  /**
   * Generates all solver parameter combinations for grid search optimization.
   *
   * <p>
   * Computes the Cartesian product of initialization modes, weighting options,
   * range bias modes, and RANSAC step calibration strategies.
   * </p>
   *
   * @return {!Array<!Object>} Array of parameter combination configuration
   *     objects.
   */
  function generateCombinations() {
    const ngInits = ['first', 'centroid', 'lls', 'last'];
    const rssiWeights = ['none', 'inverse', 'linear'];
    const rangeWeights = ['none', 'inv-r', 'inv-r2'];
    const weightSuccesses = [false, true];
    const weightSds = [false, true];
    const rangeBiasModes = ['none', 'auto', 'manual'];
    const ransacModes = ['none', 'step-only', 'ransac-only', 'ransac-step'];
    const combinations = [];
    for (const ngInit of ngInits) {
      for (const rssiW of rssiWeights) {
        for (const rangeW of rangeWeights) {
          for (const wSuccess of weightSuccesses) {
            for (const wSd of weightSds) {
              for (const rbMode of rangeBiasModes) {
                for (const rMode of ransacModes) {
                  combinations.push({
                    ngInit,
                    rssiW,
                    rangeW,
                    wSuccess,
                    wSd,
                    rbMode,
                    rMode
                  });
                }
              }
            }
          }
        }
      }
    }
    return combinations;
  }

  /**
   * Applies a parameter combination to global solver state and UI widgets.
   *
   * <p>
   * Synchronizes window properties and corresponding radio buttons and
   * checkboxes with the provided configuration object.
   * </p>
   *
   * @param {!Object} config Configuration object with solver options.
   */
  function applyCombination(config) {
    // 1. Update window global state
    window.ngInitMode = config.ngInit;
    window.rssiWeightMode = config.rssiW;
    window.rangeWeightMode = config.rangeW;
    window.weightSuccess = config.wSuccess;
    window.weightSd = config.wSd;
    window.rangeBiasMode = config.rbMode;
    window.ransacMode = config.rMode;

    // 2. Update DOM Widgets
    const radioNgInit = document.querySelector(`input[name="ng-init"][value="${config.ngInit}"]`);
    if (radioNgInit) radioNgInit.checked = true;

    const radioRssi = document.querySelector(`input[name="rssi-weight"][value="${config.rssiW}"]`);
    if (radioRssi) radioRssi.checked = true;

    const radioRange = document.querySelector(`input[name="range-weight"][value="${config.rangeW}"]`);
    if (radioRange) radioRange.checked = true;

    const checkSuccess = document.getElementById('weight-success');
    if (checkSuccess) checkSuccess.checked = config.wSuccess;

    const checkSd = document.getElementById('weight-sd');
    if (checkSd) checkSd.checked = config.wSd;

    const radioRangeBias = document.querySelector(`input[name="range-bias-mode"][value="${config.rbMode}"]`);
    if (radioRangeBias) radioRangeBias.checked = true;

    const radioRansac = document.querySelector(`input[name="ransac-mode"][value="${config.rMode}"]`);
    if (radioRansac) radioRansac.checked = true;
  }

  /**
   * Evaluates the optimization objective score for the current solver state.
   *
   * <p>
   * Combines normalized angle error, distance error, and NG RMS error metrics
   * based on user-selected optimization criteria.
   * </p>
   *
   * @param {boolean} useAngle Whether to include angle error in objective.
   * @param {boolean} useDist Whether to include distance error in objective.
   * @param {boolean} useRmsPos Whether to include RMS position error in
   *     objective.
   * @return {number} Calculated aggregate penalty score (lower is better).
   */
  function evaluateCurrentScore(useAngle, useDist, useRmsPos) {
    const metrics = window.greenBoxSummaryMetrics && window.greenBoxSummaryMetrics.enhanced;
    if (!metrics) return Infinity;

    const getMetricValue = (val, fallback) => {
      if (typeof val === 'number' && !isNaN(val) && val >= 0) return val;
      if (typeof fallback === 'number' && !isNaN(fallback) && fallback >= 0) return fallback;
      return Infinity;
    };

    const angleErr = getMetricValue(metrics.meanAngleError, metrics.arrowGtAngleErrDeg);
    const distErr  = getMetricValue(metrics.meanDistError, metrics.arrowGtDistErrM);
    let ngRmsErr = Infinity;
    if (window.currentEnhancedTargetPath && window.currentEnhancedTargetPath.length > 0) {
      const lastTarg = window.currentEnhancedTargetPath[window.currentEnhancedTargetPath.length - 1];
      if (lastTarg && typeof lastTarg.err === 'number' && !isNaN(lastTarg.err) && lastTarg.err >= 0) {
        ngRmsErr = lastTarg.err;
      }
    }

    let score = 0;
    let count = 0;

    if (useAngle) {
      if (angleErr === Infinity) return Infinity;
      score += (angleErr / 180.0);
      count++;
    }
    if (useDist) {
      if (distErr === Infinity) return Infinity;
      score += (distErr / 20.0);
      count++;
    }
    if (useRmsPos) {
      if (ngRmsErr === Infinity) return Infinity;
      score += (ngRmsErr / 20.0);
      count++;
    }

    if (count > 0) return score;
    return Infinity;
  }

  /**
   * Initiates the asynchronous grid search parameter optimization process.
   *
   * <p>
   * Validates dataset availability and objective selections, updates button
   * state, and schedules batch evaluation frames.
   * </p>
   */
  function startOptimization() {
    const checkAngle = document.getElementById('optimize-angle');
    const checkDist = document.getElementById('optimize-dist');
    const checkRmsPos = document.getElementById('optimize-rms-pos');
    const progressInput = document.getElementById('optimize-progress');
    const btnStart = document.getElementById('btn-optimize-start');

    if (!window.currentParsedData || !window.currentParsedData.data) {
      alert('Please load an RTT Ranging Tool Log CSV file first.');
      return;
    }

    const useAngle = checkAngle && checkAngle.checked;
    const useDist = checkDist && checkDist.checked;
    const useRmsPos = checkRmsPos && checkRmsPos.checked;

    if (!useAngle && !useDist && !useRmsPos) {
      alert('Please select at least one optimization goal (Angle, Distance, or NG Position RMS Error).');
      return;
    }

    if (isOptimizing) return;
    isOptimizing = true;
    cancelRequested = false;

    if (btnStart) {
      btnStart.disabled = true;
      btnStart.innerText = 'Optimizing...';
      btnStart.style.backgroundColor = '#eeeeee';
      btnStart.style.color = '#888888';
      btnStart.style.borderColor = '#cccccc';
    }

    const combos = generateCombinations();
    let bestScore = Infinity;
    let bestConfig = null;
    let idx = 0;

    // Save Initial Configuration just in case
    const initialConfig = {
      ngInit: window.ngInitMode || 'first',
      rssiW: window.rssiWeightMode || 'none',
      rangeW: window.rangeWeightMode || 'none',
      wSuccess: window.weightSuccess || false,
      wSd: window.weightSd || false,
      rbMode: window.rangeBiasMode || 'none',
      rMode: window.ransacMode || 'none'
    };

    /**
     * Executes a single batch step of the grid search optimization.
     *
     * <p>
     * Evaluates a subset of combinations, updates progress UI, and schedules
     * subsequent batches using requestAnimationFrame until finished or
     * canceled.
     * </p>
     */
    function stepGrid() {
      if (cancelRequested) {
        // Cancelled! Restore initial configuration and exit.
        applyCombination(initialConfig);
        if (typeof window.updateDisplay === 'function') {
          window.updateDisplay();
        }
        if (progressInput) progressInput.value = `0 / ${TOTAL_COMBINATIONS}`;
        if (btnStart) {
          btnStart.disabled = false;
          btnStart.innerText = 'Start';
          btnStart.style.backgroundColor = '#e3f2fd';
          btnStart.style.color = '#1565c0';
          btnStart.style.borderColor = '#bbdefb';
        }
        isOptimizing = false;
        cancelRequested = false;
        return;
      }

      const BATCH_SIZE = 10;
      const limit = Math.min(idx + BATCH_SIZE, TOTAL_COMBINATIONS);

      for (; idx < limit; idx++) {
        const config = combos[idx];
        applyCombination(config);
        
        // Re-execute calculations synchronously
        if (typeof window.updateDisplay === 'function') {
          window.updateDisplay();
        }

        const score = evaluateCurrentScore(useAngle, useDist, useRmsPos);
        if (score < bestScore) {
          bestScore = score;
          bestConfig = config;
        }
      }

      if (progressInput) {
        progressInput.value = `${limit} / ${TOTAL_COMBINATIONS}`;
      }

      if (idx < TOTAL_COMBINATIONS) {
        window.requestAnimationFrame(stepGrid);
      } else {
        // Optimization Complete!
        if (bestConfig) {
          applyCombination(bestConfig);
          if (typeof window.updateDisplay === 'function') {
            window.updateDisplay();
          }
        } else {
          // Fallback to initial if all states returned Infinity
          applyCombination(initialConfig);
          if (typeof window.updateDisplay === 'function') {
            window.updateDisplay();
          }
        }

        // Leave checkboxes in their current user-set states
        if (progressInput) {
          progressInput.value = `${TOTAL_COMBINATIONS} / ${TOTAL_COMBINATIONS}`;
        }
        if (btnStart) {
          btnStart.disabled = false;
          btnStart.innerText = 'Start';
          btnStart.style.backgroundColor = '#e3f2fd';
          btnStart.style.color = '#1565c0';
          btnStart.style.borderColor = '#bbdefb';
        }
        isOptimizing = false;
      }
    }

    // Yield to let UI update and start
    if (progressInput) progressInput.value = `0 / ${TOTAL_COMBINATIONS}`;
    window.requestAnimationFrame(stepGrid);
  }

  /**
   * Resets optimizer controls or cancels an active optimization run.
   *
   * <p>
   * If an optimization is in progress, requests cancellation; otherwise
   * unchecks goal options and clears the progress indicator.
   * </p>
   */
  function handleReset() {
    const checkAngle = document.getElementById('optimize-angle');
    const checkDist = document.getElementById('optimize-dist');
    const checkRmsPos = document.getElementById('optimize-rms-pos');
    const progressInput = document.getElementById('optimize-progress');
    
    if (isOptimizing) {
      // Trigger cancellation
      cancelRequested = true;
    } else {
      if (checkAngle) checkAngle.checked = false;
      if (checkDist) checkDist.checked = false;
      if (checkRmsPos) checkRmsPos.checked = false;
      if (progressInput) {
        progressInput.value = `0 / ${TOTAL_COMBINATIONS}`;
      }
    }
  }

  /**
   * Initializes event listeners and UI elements for parameter optimization.
   *
   * <p>
   * Binds click handlers to start and reset buttons and resets progress input.
   * </p>
   */
  function initParamOptimizer() {
    const btnStart = document.getElementById('btn-optimize-start');
    const btnReset = document.getElementById('btn-optimize-reset');
    const progressInput = document.getElementById('optimize-progress');

    if (progressInput) {
      progressInput.value = `0 / ${TOTAL_COMBINATIONS}`;
    }

    if (btnStart) btnStart.addEventListener('click', startOptimization);
    if (btnReset) btnReset.addEventListener('click', handleReset);
  }

  // Hook into global load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initParamOptimizer);
  } else {
    initParamOptimizer();
  }

  window.runParamOptimizerGrid = startOptimization;
})();
