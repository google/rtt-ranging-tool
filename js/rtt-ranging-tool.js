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

// --- File Loaders & IndexedDB ---
const dbName = 'RttRangingToolDB';
const storeName = 'handles';

/**
 * Opens the IndexedDB database for storing file handles.
 *
 * <p>
 * Creates the object store on upgrade and resolves with the database instance.
 * </p>
 *
 * @return {!Promise<!IDBDatabase>} Promise resolving to the database instance.
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = function(e) {
      const db = e.target.result;
      db.createObjectStore(storeName);
    };
    request.onsuccess = function(e) {
      resolve(e.target.result);
    };
    request.onerror = function(e) {
      reject(e.target.error);
    };
  });
}

/**
 * Saves a file or directory handle to IndexedDB under the specified key.
 *
 * <p>
 * Writes the handle within a readwrite transaction in the handle store.
 * </p>
 *
 * @param {string} key Storage key for the handle.
 * @param {*} handle FileSystemHandle to store.
 * @return {!Promise<void>} Promise resolving when the handle is saved.
 */
async function saveHandle(key, handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(handle, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieves a stored file or directory handle from IndexedDB by key.
 *
 * <p>
 * Reads the entry within a readonly transaction from the handle store.
 * </p>
 *
 * @param {string} key Storage key for the handle.
 * @return {!Promise<*>} Promise resolving to the stored handle, or undefined.
 */
async function getHandle(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

window.addEventListener('load', () => {
  console.log('window.onload fired.');
  window.ngInitMode = document.querySelector('input[name="ng-init"]:checked')?.value || 'first';
  window.rssiWeightMode = document.querySelector('input[name="rssi-weight"]:checked')?.value || 'none';
  window.rangeWeightMode = document.querySelector('input[name="range-weight"]:checked')?.value || 'none';
  window.weightSuccess = document.getElementById('weight-success')?.checked || false;
  window.weightSd = document.getElementById('weight-sd')?.checked || false;
  window.rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || 'none';
  const mBiasVal = parseFloat(document.getElementById('manual-bias')?.value);
  window.manualBias = isNaN(mBiasVal) ? 0.5 : mBiasVal;
  const sRangeVal = parseFloat(document.getElementById('scale-range')?.value);
  window.scaleRange = (isNaN(sRangeVal) || sRangeVal <= 0) ? 0.93 : sRangeVal;
  window.ransacMode = document.querySelector('input[name="ransac-mode"]:checked')?.value || 'none';
  window.windowStepsLimit = Infinity;
  const rightPanel = document.querySelector('.right-panel');
  let canvas = document.querySelector('#plot-canvas');

  if (!canvas && rightPanel) {
    console.log('Creating canvas dynamically.');
    canvas = document.createElement('canvas');
    canvas.id = 'plot-canvas';
    rightPanel.appendChild(canvas);
  } else if(!rightPanel) {
    console.error('Right panel not found!');
    return;
  }
  console.log('Canvas element:', canvas);

  document.getElementById("title-version").innerText = "RTT Ranging Tool: " + APP_VERSION;

  // Tab switching logic
  const tabRangeAnalysis = document.getElementById('tab-range-analysis');
  const tabApLocation = document.getElementById('tab-ap-location');
  const contentRangeAnalysis = document.getElementById('tab-content-range-analysis');
  const contentApLocation = document.getElementById('tab-content-ap-location');
  const containerRangeAnalysis = document.getElementById('range-analysis-container');
  const containerApLocation = document.getElementById('ap-location-container');

  /**
   * Switches the active UI mode between Range Analysis and AP Location tabs.
   *
   * <p>
   * Adjusts tab navigation classes, panel visibility, and triggers redraws
   * for charts or plot canvases corresponding to the selected view mode.
   * </p>
   *
   * @param {string} mode Mode identifier ('range-analysis' or 'ap-location').
   */
  function switchTab(mode) {
    if (mode === 'range-analysis') {
      if (tabRangeAnalysis) tabRangeAnalysis.classList.add('active');
      if (tabApLocation) tabApLocation.classList.remove('active');
      if (contentRangeAnalysis) contentRangeAnalysis.classList.add('active');
      if (contentApLocation) contentApLocation.classList.remove('active');
      if (containerRangeAnalysis) containerRangeAnalysis.style.display = 'block';
      if (containerApLocation) containerApLocation.style.display = 'none';
      if (typeof window.renderRangeAnalysisCharts === 'function') {
        window.renderRangeAnalysisCharts();
      }
    } else {
      if (tabApLocation) tabApLocation.classList.add('active');
      if (tabRangeAnalysis) tabRangeAnalysis.classList.remove('active');
      if (contentApLocation) contentApLocation.classList.add('active');
      if (contentRangeAnalysis) contentRangeAnalysis.classList.remove('active');
      if (containerRangeAnalysis) containerRangeAnalysis.style.display = 'none';
      if (containerApLocation) containerApLocation.style.display = 'block';
      const plotCanvas = document.getElementById('plot-canvas');
      if (plotCanvas && window.currentParsedData && window.currentParsedData.data && typeof window.drawPlot === 'function') {
        const d = window.currentParsedData;
        const minS = typeof window.getSharedMinStep === 'function' ? window.getSharedMinStep() : 0;
        const maxS = typeof window.getSharedMaxStep === 'function' ? window.getSharedMaxStep() : 1000;
        window.drawPlot(plotCanvas, d.data, d.targetData, d.gtInterpolated, minS, maxS, d.enhancedPdrData);
      }
    }
  }

  if (tabRangeAnalysis && tabApLocation) {
    tabRangeAnalysis.addEventListener('click', () => switchTab('range-analysis'));
    tabApLocation.addEventListener('click', () => switchTab('ap-location'));
  }

  // Resizing logic
  const leftPanel = document.getElementById('left-panel');
  const divider = document.getElementById('divider');
  const collapseBtn = document.getElementById('collapse-btn');
  let isResizing = false;
  let leftPanelCollapsed = false;

  divider.addEventListener('mousedown', (e) => {
    if (e.target === collapseBtn || leftPanelCollapsed) return;
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResize);
  });

  collapseBtn.addEventListener('click', () => {
    if (leftPanelCollapsed) {
      leftPanel.style.display = 'block';
      divider.style.cursor = 'col-resize';
      collapseBtn.innerHTML = '&laquo;';
      leftPanelCollapsed = false;
    } else {
      leftPanel.style.display = 'none';
      divider.style.cursor = 'pointer';
      collapseBtn.innerHTML = '&raquo;';
      leftPanelCollapsed = true;
    }
  });

  /**
   * Handles panel divider drag interactions to resize the sidebar.
   *
   * @param {!MouseEvent} e Mouse move DOM event.
   */
  function handleMouseMove(e) {
    if (isResizing) {
      const newWidth = e.clientX;
      // Set min and max width for left panel
      if (newWidth > 50 && newWidth < window.innerWidth - 100) {
        leftPanel.style.width = `${newWidth}px`;
      }
    }
  }

  /**
   * Terminates the sidebar panel resizing interaction and cleans up listeners.
   */
  function stopResize() {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResize);
  }

  // Re-render plot on resize (handles both window resize and panel resize)
  const resizeObserver = new ResizeObserver(() => {
    if (canvas && canvas._plotData && typeof window.drawPlot === 'function') {
      const d = canvas._plotData;
      // Use requestAnimationFrame to avoid loop limit exceeded errors.
      window.requestAnimationFrame(() => {
        window.drawPlot(canvas, d.pdrData, d.targetData, d.gtInterpolated, d.minStep, d.maxStep, d.enhancedPdrData);
      });
    }
  });
  if (rightPanel) {
    resizeObserver.observe(rightPanel);
  }

  // File input logic
  const browseButton = document.getElementById('browse-button');
  const fileInput = document.getElementById('log-file-input');
  const fileText = document.getElementById('log-file-text');
  const logFileInputContainer =
      document.getElementById('log-file-input-container');
  const logFileDropzone = document.getElementById('log-file-dropzone');
  const logFileDropzoneText =
      document.getElementById('log-file-dropzone-text');

  const gtBrowseButton = document.getElementById('gt-browse-button');
  const gtFileInput = document.getElementById('gt-file-input');
  const gtFileText = document.getElementById('gt-file-text');
  const gtFileInputContainer =
      document.getElementById('gt-file-input-container');
  const gtFileDropzone = document.getElementById('gt-file-dropzone');
  const gtFileDropzoneText =
      document.getElementById('gt-file-dropzone-text');

  const apFileDrag = document.getElementById('ap-file-drag');
  const btnApFileReset = document.getElementById('btn-ap-file-reset');
  const apToggleShowBtn = document.getElementById('ap-toggle-show-button');

  const dataTextbox = document.getElementById('data-textbox');
  const showDataCheckbox = document.getElementById('show-data-checkbox');
  const reloadButton = document.getElementById('reload-button');

  // Dual Slider DOM
  const minSlider = document.getElementById('slider-min');
  const maxSlider = document.getElementById('slider-max');
  const sliderRangeFill = document.getElementById('slider-range-fill');
  const sliderValText = document.getElementById('slider-val');
  const dualSliderContainer = document.querySelector('.dual-slider-container');

  // Enhanced PDR DOM
  const enhancedStepLengthInput = document.getElementById('enhanced-step-length');
  const enhancedDiversityInput = document.getElementById('enhanced-diversity');
  const enhancedRssiInput = document.getElementById('enhanced-rssi');
  const enhancedSuccessInput = document.getElementById('enhanced-success');
  const enhancedStdDevInput = document.getElementById('enhanced-stddev');

  let currentParsedData = null;
  let currentGtCoords = null;
  let currentLogContent = '';

  /**
   * Updates visual fill, labels, and canvas for playback sliders.
   *
   * <p>
   * Computes normalized range track percentages and dispatches redraws to
   * display trajectory slices bounded by the selected steps.
   * </p>
   */
  function updateDualSliderUI() {
    if (!minSlider || !maxSlider || !sliderRangeFill || !sliderValText) return;
    let val1 = parseInt(minSlider.value, 10);
    let val2 = parseInt(maxSlider.value, 10);
    let maxPossible = parseInt(minSlider.max, 10) || 100;
    let pStart = Math.min(val1, val2);
    let pEnd = Math.max(val1, val2);

    let leftPct = (pStart / maxPossible) * 100;
    let widthPct = ((pEnd - pStart) / maxPossible) * 100;

    sliderRangeFill.style.left = leftPct + '%';
    sliderRangeFill.style.width = widthPct + '%';
    sliderValText.innerText = `Step: ${pStart} - ${pEnd}`;

    if (canvas && currentParsedData && currentParsedData.data) {
      if (typeof window.drawPlot === 'function') {
        window.drawPlot(canvas, currentParsedData.data, currentParsedData.targetData, currentParsedData.gtInterpolated, pStart, pEnd, currentParsedData.enhancedPdrData);
      } else {
        console.error('window.drawPlot is still undefined!');
      }
    }
  }

  /**
   * Reconfigures playback slider bounds based on dataset step count.
   *
   * <p>
   * Adjusts maximum step bounds taking into account the GT-1 limiting option
   * and synchronizes secondary metrics sliders.
   * </p>
   *
   * @param {boolean=} isInitialLoad Whether invocation occurs on initial load.
   */
  function updatePlaySliderLimits(isInitialLoad = false) {
    if (!currentParsedData || !currentParsedData.data) return;
    
    let maxSteps = 0;
    currentParsedData.data.forEach(r => {
      const s = r['Steps(int)'];
      if (!isNaN(s) && s > maxSteps) maxSteps = s;
    });

    const limitGtCheckbox = document.getElementById('limit-gt-checkbox');
    const isLimited = limitGtCheckbox && limitGtCheckbox.checked && maxSteps > 1;
    const effectiveMax = isLimited ? (maxSteps - 1) : maxSteps;

    if (minSlider && maxSlider && effectiveMax > 0) {
      const curMax = parseInt(maxSlider.value, 10);
      const curLimit = parseInt(maxSlider.max, 10);
      const atMax = isInitialLoad || (curMax >= curLimit);

      minSlider.max = effectiveMax;
      maxSlider.max = effectiveMax;

      if (atMax) {
        maxSlider.value = effectiveMax;
      } else {
        maxSlider.value = Math.min(curMax, effectiveMax);
      }

      minSlider.value = Math.min(isInitialLoad ? 0 : parseInt(minSlider.value, 10), effectiveMax);

      const windowSlider = document.getElementById('window-steps-slider');
      const windowValSpan = document.getElementById('window-steps-val');
      if (windowSlider) {
        const curWindowVal = parseInt(windowSlider.value, 10);
        const curWindowLimit = parseInt(windowSlider.max, 10);
        const windowAtMax = isInitialLoad || (curWindowVal >= curWindowLimit || window.windowStepsLimit === Infinity);

        windowSlider.max = effectiveMax;
        if (windowAtMax) {
          windowSlider.value = effectiveMax;
          window.windowStepsLimit = Infinity;
          if (windowValSpan) windowValSpan.innerText = 'All (' + effectiveMax + ')';
        } else {
          windowSlider.value = Math.min(curWindowVal, effectiveMax);
          if (windowValSpan) windowValSpan.innerText = windowSlider.value;
          window.windowStepsLimit = parseInt(windowSlider.value, 10);
        }
      }

      const pStart = Math.min(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));
      const pEnd = Math.max(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));

      if (typeof window.updateMetricsSliderLimits === 'function') {
        window.updateMetricsSliderLimits(effectiveMax, pStart, pEnd);
      } else {
        updateDualSliderUI();
      }
    }
  }

  if (minSlider && maxSlider) {
    minSlider.addEventListener('input', () => {
      pauseAnimation();
      if (typeof window.syncAllStepSliders === 'function') {
        window.syncAllStepSliders(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));
      } else {
        updateDualSliderUI();
      }
    });
    maxSlider.addEventListener('input', () => {
      pauseAnimation();
      if (typeof window.syncAllStepSliders === 'function') {
        window.syncAllStepSliders(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));
      } else {
        updateDualSliderUI();
      }
    });
  }

  if (enhancedStepLengthInput) enhancedStepLengthInput.addEventListener('input', updateDisplay);
  if (enhancedDiversityInput) enhancedDiversityInput.addEventListener('input', updateDisplay);
  if (enhancedRssiInput) enhancedRssiInput.addEventListener('input', updateDisplay);
  if (enhancedSuccessInput) enhancedSuccessInput.addEventListener('input', updateDisplay);
  if (enhancedStdDevInput) enhancedStdDevInput.addEventListener('input', updateDisplay);

  document.querySelectorAll('input[name="ng-init"]').forEach(rb => {
    rb.addEventListener('change', () => {
      window.ngInitMode = document.querySelector('input[name="ng-init"]:checked')?.value || 'first';
      updateDualSliderUI();
    });
  });

  document.querySelectorAll('input[name="rssi-weight"]').forEach(rb => {
    rb.addEventListener('change', () => {
      window.rssiWeightMode = document.querySelector('input[name="rssi-weight"]:checked')?.value || 'none';
      updateDisplay();
    });
  });

  document.querySelectorAll('input[name="range-weight"]').forEach(rb => {
    rb.addEventListener('change', () => {
      window.rangeWeightMode = document.querySelector('input[name="range-weight"]:checked')?.value || 'none';
      updateDisplay();
    });
  });

  const successCheckbox = document.getElementById('weight-success');
  if (successCheckbox) {
    successCheckbox.addEventListener('change', () => {
      window.weightSuccess = successCheckbox.checked;
      updateDisplay();
    });
  }

  const sdCheckbox = document.getElementById('weight-sd');
  if (sdCheckbox) {
    sdCheckbox.addEventListener('change', () => {
      window.weightSd = sdCheckbox.checked;
      updateDisplay();
    });
  }

  const rangeBiasRadioButtons = document.querySelectorAll('input[name="range-bias-mode"]');
  rangeBiasRadioButtons.forEach(radio => {
    radio.addEventListener('change', () => {
      window.rangeBiasMode = document.querySelector('input[name="range-bias-mode"]:checked')?.value || 'none';
      updateDisplay();
    });
  });

  const manualBiasInput = document.getElementById('manual-bias');
  if (manualBiasInput) {
    manualBiasInput.addEventListener('input', () => {
      const val = parseFloat(manualBiasInput.value);
      window.manualBias = isNaN(val) ? 0.0 : val;
      updateDisplay();
    });
  }

  const scaleRangeInput = document.getElementById('scale-range');
  if (scaleRangeInput) {
    scaleRangeInput.addEventListener('input', () => {
      const val = parseFloat(scaleRangeInput.value);
      window.scaleRange = (isNaN(val) || val <= 0) ? 1.0 : val;
      updateDisplay();
    });
  }

  const limitGtCheckbox = document.getElementById('limit-gt-checkbox');
  if (limitGtCheckbox) {
    limitGtCheckbox.addEventListener('change', () => {
      pauseAnimation();
      updatePlaySliderLimits(false);
      updateDisplay();
    });
  }

  const ransacRadioButtons = document.querySelectorAll('input[name="ransac-mode"]');
  ransacRadioButtons.forEach(radio => {
    radio.addEventListener('change', () => {
      window.ransacMode = document.querySelector('input[name="ransac-mode"]:checked')?.value || 'none';
      updateDisplay();
    });
  });

  const windowStepsSlider = document.getElementById('window-steps-slider');
  const windowStepsVal = document.getElementById('window-steps-val');
  if (windowStepsSlider) {
    windowStepsSlider.addEventListener('input', () => {
      const val = parseInt(windowStepsSlider.value, 10);
      const maxVal = parseInt(windowStepsSlider.max, 10);
      
      if (val === maxVal) {
        window.windowStepsLimit = Infinity;
        if (windowStepsVal) windowStepsVal.innerText = `All (${val})`;
      } else {
        window.windowStepsLimit = val;
        if (windowStepsVal) windowStepsVal.innerText = val;
      }
      updateDisplay();
    });
  }

  let isDraggingWindow = false;
  let startDragX = 0;
  let startMinVal = 0;
  let startMaxVal = 0;

  if (sliderRangeFill && dualSliderContainer) {
    sliderRangeFill.addEventListener('mousedown', (e) => {
      if (minSlider.disabled) return;
      isDraggingWindow = true;
      startDragX = e.clientX;
      startMinVal = Math.min(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));
      startMaxVal = Math.max(parseInt(minSlider.value, 10), parseInt(maxSlider.value, 10));
      document.body.style.cursor = 'grabbing';
      sliderRangeFill.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDraggingWindow) return;
      const rect = dualSliderContainer.getBoundingClientRect();
      const maxPossible = parseInt(minSlider.max, 10);
      if (maxPossible <= 0 || rect.width <= 0) return;

      const dx = e.clientX - startDragX;
      const stepsMoved = Math.round((dx / rect.width) * maxPossible);

      const windowWidth = startMaxVal - startMinVal;
      let newMin = startMinVal + stepsMoved;
      let newMax = startMaxVal + stepsMoved;

      if (newMin < 0) {
        newMin = 0;
        newMax = windowWidth;
      }
      if (newMax > maxPossible) {
        newMax = maxPossible;
        newMin = maxPossible - windowWidth;
      }

      minSlider.value = newMin;
      maxSlider.value = newMax;
      updateDualSliderUI();
    });

    document.addEventListener('mouseup', () => {
      if (isDraggingWindow) {
        isDraggingWindow = false;
        document.body.style.cursor = '';
        sliderRangeFill.style.cursor = 'grab';
      }
    });
  }

  /**
   * Recomputes enhanced PDR trajectory, solves target, and redraws UI.
   *
   * <p>
   * Applies weighting heuristics, filters, spatial RANSAC, and Gauss-Newton
   * solvers across the loaded dataset and renders the updated plot.
   * </p>
   */
  function updateDisplay() {
    if (!currentParsedData) return;

    if (currentGtCoords && typeof matchGtCoords === 'function') {
      matchGtCoords(currentParsedData, currentGtCoords);
    }

    // Calculate Enhanced PDR
    const stepLen = parseFloat(enhancedStepLengthInput ? enhancedStepLengthInput.value : 0.67) || 0.67;
    const minRssi = parseFloat(enhancedRssiInput ? enhancedRssiInput.value : -95) || -95;
    const minSuccess = parseFloat(enhancedSuccessInput ? enhancedSuccessInput.value : 5) || 5;
    const maxStdDev = parseFloat(enhancedStdDevInput ? enhancedStdDevInput.value : 2.0) || 2.0;

    let currX = 0;
    let currY = 0;
    let unitX = 0;
    let unitY = 0;
    const enhancedPdrData = [];

    if (currentParsedData.data && currentParsedData.data.length > 0) {
      const rawRssiWeights = [];
      const rawRangeWeights = [];
      const rawSuccessWeights = [];
      const rawSdWeights = [];
      const validIndices = [];

      currentParsedData.data.forEach((r, i) => {
        if (i === 0) {
          currX = 0;
          currY = 0;
        } else {
          const prevSteps = currentParsedData.data[i - 1]['Steps(int)'];
          const currSteps = r['Steps(int)'];
          const dSteps = currSteps - prevSteps;
          if (dSteps > 0) {
            const angleRad = (r['phoneAngle(deg)'] || 0) * Math.PI / 180;
            currX += dSteps * stepLen * Math.sin(angleRad);
            currY += dSteps * stepLen * Math.cos(angleRad);
            unitX += dSteps * Math.sin(angleRad);
            unitY += dSteps * Math.cos(angleRad);
          }
        }

        let rangeVal = parseFloat(r['Range(m)']);
        const rssiVal = parseFloat(r['RSSI']);
        const stdDevVal = parseFloat(r['RangeStdDev(m)']);
        const successVal = Math.round(parseFloat(r['SuccessRatio']) * 8);

        if (!isNaN(rangeVal) && rangeVal > 0) {
          if (!isNaN(rssiVal) && rssiVal < minRssi) {
            rangeVal = NaN;
          } else if (!isNaN(successVal) && successVal < minSuccess) {
            rangeVal = NaN;
          } else if (!isNaN(stdDevVal) && stdDevVal > maxStdDev) {
            rangeVal = NaN;
          }
        }

        let rawRssiW = 1.0;
        let rawRangeW = 1.0;
        let rawSuccessW = 1.0;
        let rawSdW = 1.0;
        const isValid = !isNaN(rangeVal) && rangeVal > 0;

        if (isValid) {
          const rssiWeightMode = window.rssiWeightMode || 'none';
          if (rssiWeightMode === 'inverse') {
            rawRssiW = 1.0 / Math.max(Math.abs(rssiVal), 1.0);
          } else if (rssiWeightMode === 'linear') {
            const anchorRssi = -30.0;
            const clampedRssi = Math.min(rssiVal, anchorRssi);
            const n = 2.5;
            rawRssiW = Math.pow(10, (clampedRssi - anchorRssi) / (5.0 * n));
          }

          const rangeWeightMode = window.rangeWeightMode || 'none';
          if (rangeWeightMode === 'inv-r') {
            rawRangeW = 1.0 / rangeVal;
          } else if (rangeWeightMode === 'inv-r2') {
            rawRangeW = 1.0 / (rangeVal * rangeVal);
          }

          if (window.weightSuccess) {
            rawSuccessW = successVal;
          }

          if (window.weightSd) {
            const sd = Math.max(stdDevVal, 0.1);
            rawSdW = 1.0 / (sd * sd);
          }

          validIndices.push(i);
        }

        rawRssiWeights.push(rawRssiW);
        rawRangeWeights.push(rawRangeW);
        rawSuccessWeights.push(rawSuccessW);
        rawSdWeights.push(rawSdW);

        enhancedPdrData.push({
          'Time(ms)': r['Time(ms)'],
          'Steps(int)': r['Steps(int)'],
          'Range(m)': rangeVal,
          'findState(int)': r['findState(int)'],
          x: currX,
          y: currY,
          unitX: unitX,
          unitY: unitY,
          weight: 1.0
        });
      });

      const N_v = validIndices.length;
      const activeWeightArrays = [];

      const rssiWeightMode = window.rssiWeightMode || 'none';
      if (rssiWeightMode !== 'none') {
        activeWeightArrays.push(rawRssiWeights);
      }
      const rangeWeightMode = window.rangeWeightMode || 'none';
      if (rangeWeightMode !== 'none') {
        activeWeightArrays.push(rawRangeWeights);
      }
      if (window.weightSuccess) {
        activeWeightArrays.push(rawSuccessWeights);
      }
      if (window.weightSd) {
        activeWeightArrays.push(rawSdWeights);
      }

      if (activeWeightArrays.length > 0) {
        const normalizedArrays = activeWeightArrays.map(rawWeights => {
          let sum = 0;
          validIndices.forEach(idx => { sum += rawWeights[idx]; });
          return rawWeights.map((w, idx) => validIndices.includes(idx) ? (sum > 0 ? N_v * w / sum : 1.0) : 0);
        });

        const combined = [];
        let sumCombined = 0;
        for (let i = 0; i < enhancedPdrData.length; i++) {
          if (validIndices.includes(i)) {
            let wComb = 1.0;
            normalizedArrays.forEach(normArr => {
              wComb *= normArr[i];
            });
            combined.push(wComb);
            sumCombined += wComb;
          } else {
            combined.push(0);
          }
        }

        enhancedPdrData.forEach((item, idx) => {
          if (validIndices.includes(idx)) {
            item.weight = sumCombined > 0 ? N_v * combined[idx] / sumCombined : 1.0;
          } else {
            item.weight = 0;
          }
        });
      } else {
        enhancedPdrData.forEach((item, idx) => {
          if (validIndices.includes(idx)) {
            item.weight = 1.0;
          } else {
            item.weight = 0;
          }
        });
      }
    }
    currentParsedData.enhancedPdrData = enhancedPdrData;
    console.log("Calculated weights (first 10):", enhancedPdrData.slice(0, 10).map(p => p.weight));

    let text = currentLogContent || '';
    if (currentGtCoords && currentParsedData.gtData && currentParsedData.gtData.length > 0) {
      text += '\n\n# --- Matched Ground Truth Coordinates ---\n';
      text += '# GtNum | Time(ms) | TargetX(m) | TargetY(m)\n';
      currentParsedData.gtData.forEach(row => {
        const gtNum = row['GtNum(int)'];
        const time = row['Time(ms)'];
        const tx = row['TargetX(m)'];
        const ty = row['TargetY(m)'];
        text += `GT, ${gtNum}, ${time}, ${tx !== undefined ? tx : 'NaN'}, ${ty !== undefined ? ty : 'NaN'}\n`;
      });
    }

    if (currentParsedData.gtInterpolated && currentParsedData.gtInterpolated.length > 0) {
      text += '\n\n# --- Interpolated Ground Truth Coordinates (FIND1 timestamps) ---\n';
      text += '# Time(ms) | TargetX(m) | TargetY(m)\n';
      currentParsedData.gtInterpolated.forEach(row => {
        const time = row['Time(ms)'];
        const tx = row['TargetX(m)'];
        const ty = row['TargetY(m)'];
        text += `INTERP, ${time}, ${tx.toFixed(2)}, ${ty.toFixed(2)}\n`;
      });
    }
    dataTextbox.value = text;

    updateDualSliderUI();
  }

  /**
   * Processes raw CSV content from an uploaded RTT ranging log file.
   *
   * <p>
   * Parses log records, configures playback slider limits, enables animation
   * controls, and triggers a display redraw.
   * </p>
   *
   * @param {string} content Raw text content of the CSV log.
   * @param {string} filename Name of the loaded log file.
   */
  function processLogContent(content, filename) {
    fileText.value = filename;
    if (logFileDropzoneText) {
      logFileDropzoneText.textContent = `Loaded: ${filename}`;
    }
    currentLogContent = content;
    currentParsedData = parseCsvData(content);
    window.currentParsedData = currentParsedData;
    window.firstEnhancedCrossingStep = -1;
    console.log('Parsed log data:', currentParsedData);

    if (enhancedStepLengthInput && currentParsedData.params &&
        currentParsedData.params['STEP_LENGTH_M'] !== undefined) {
      enhancedStepLengthInput.value = currentParsedData.params['STEP_LENGTH_M'];
    }

    let maxSteps = 0;
    if (currentParsedData && currentParsedData.data) {
      currentParsedData.data.forEach(r => {
        const s = r['Steps(int)'];
        if (!isNaN(s) && s > maxSteps) maxSteps = s;
      });
    }
    if (minSlider && maxSlider && maxSteps > 0) {
      minSlider.disabled = false;
      maxSlider.disabled = false;

      const windowSlider = document.getElementById('window-steps-slider');
      if (windowSlider) {
        windowSlider.disabled = false;
        window.windowStepsLimit = Infinity;
      }

      updatePlaySliderLimits(true);

      const btnAnimate = document.getElementById('btn-animate');
      const btnReset = document.getElementById('btn-reset');
      const btnIncrement = document.getElementById('btn-increment');
      const btnCancel = document.getElementById('btn-cancel');
      const btnDecrement = document.getElementById('btn-decrement');

      if (btnAnimate) btnAnimate.disabled = false;
      if (btnReset) btnReset.disabled = false;
      if (btnIncrement) btnIncrement.disabled = false;
      if (btnCancel) btnCancel.disabled = false;
      if (btnDecrement) btnDecrement.disabled = false;
    }

    updateDisplay();
  }

  /**
   * Processes raw CSV content containing ground truth target coordinates.
   *
   * <p>
   * Parses marker coordinate mappings, associates them with the active dataset,
   * and refreshes visualization displays.
   * </p>
   *
   * @param {string} content Raw CSV text containing GT coordinates.
   * @param {string} filename Name of the ground truth coordinates file.
   */
  function processGtCoordsContent(content, filename) {
    gtFileText.value = filename;
    if (gtFileDropzoneText) {
      gtFileDropzoneText.textContent = `Loaded: ${filename}`;
    }
    if (typeof parseGtCoordsData === 'function') {
      currentGtCoords = parseGtCoordsData(content);
      console.log('Parsed GT coords:', currentGtCoords);
      updateDisplay();
    }
  }

  browseButton.addEventListener('click', async () => {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'CSV/Log Files',
            accept: {'text/csv': ['.csv'], 'text/plain': ['.txt', '.csv']},
          }],
        });
        await saveHandle('logHandle', handle);
        const file = await handle.getFile();
        localStorage.setItem('lastLogFile', file.name);
        const text = await file.text();
        processLogContent(text, file.name);
      } else {
        fileInput.value = '';
        fileInput.click();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        alert('Failed to open log file: ' + err.message);
      }
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      localStorage.setItem('lastLogFile', file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        processLogContent(e.target.result, file.name);
      };
      reader.readAsText(file);
    } else {
      fileText.value = '';
      if (logFileDropzoneText) {
        logFileDropzoneText.textContent = 'Drag & Drop FIND Log CSV Here';
      }
      currentLogContent = '';
      currentParsedData = null;
      window.currentParsedData = null;
      updateDisplay();
    }
  });

  gtBrowseButton.addEventListener('click', async () => {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'GT Coords Files',
            accept: {'text/csv': ['.csv'], 'text/plain': ['.txt', '.csv']},
          }],
        });
        await saveHandle('gtHandle', handle);
        const file = await handle.getFile();
        localStorage.setItem('lastGtFile', file.name);
        const text = await file.text();
        processGtCoordsContent(text, file.name);
      } else {
        gtFileInput.value = '';
        gtFileInput.click();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        alert('Failed to open GT coords file: ' + err.message);
      }
    }
  });

  gtFileInput.addEventListener('change', () => {
    if (gtFileInput.files.length > 0) {
      const file = gtFileInput.files[0];
      localStorage.setItem('lastGtFile', file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        processGtCoordsContent(e.target.result, file.name);
      };
      reader.readAsText(file);
    } else {
      gtFileText.value = '';
      if (gtFileDropzoneText) {
        gtFileDropzoneText.textContent = 'Drag & Drop GT Coords CSV Here';
      }
      currentGtCoords = null;
      updateDisplay();
    }
  });

  if (reloadButton) {
    reloadButton.addEventListener('click', async () => {
      const logHandle = await getHandle('logHandle');
      const logFile = localStorage.getItem('lastLogFile');

      const gtHandle = await getHandle('gtHandle');
      const gtFile = localStorage.getItem('lastGtFile');

      if (!logHandle && !logFile && !gtHandle && !gtFile) {
        alert('No previously loaded files found.');
        return;
      }

      console.log('Reloading previous files...');

      // Reload Log File
      if (logHandle || logFile) {
        try {
          let logText = '';
          let logName = '';

          if (logHandle) {
            if (await logHandle.queryPermission({ mode: 'read' }) !== 'granted') {
              if (await logHandle.requestPermission({ mode: 'read' }) !== 'granted') {
                alert('Permission denied for log file.');
                return;
              }
            }
            const file = await logHandle.getFile();
            logName = file.name;
            logText = await file.text();
          } else {
            console.log('Log handle missing, falling back to fetch for:', logFile);
            const response = await fetch(logFile);
            if (!response.ok) throw new Error('Network response was not ok: ' + response.statusText);
            logText = await response.text();
            logName = logFile;
          }

          processLogContent(logText, logName);
        } catch (err) {
          alert('Error reloading log file: ' + err.message);
        }
      }

      // Reload GT Coords File
      if (gtHandle || gtFile) {
        try {
          let gtText = '';
          let gtName = '';

          if (gtHandle) {
            if (await gtHandle.queryPermission({ mode: 'read' }) !== 'granted') {
              if (await gtHandle.requestPermission({ mode: 'read' }) !== 'granted') {
                alert('Permission denied for GT coords file.');
                return;
              }
            }
            const file = await gtHandle.getFile();
            gtName = file.name;
            gtText = await file.text();
          } else {
            console.log('GT handle missing, falling back to fetch for:', gtFile);
            const response = await fetch(gtFile);
            if (!response.ok) throw new Error('Network response was not ok: ' + response.statusText);
            gtText = await response.text();
            gtName = gtFile;
          }

          processGtCoordsContent(gtText, gtName);
        } catch (err) {
          alert('Error reloading GT coords file: ' + err.message);
        }
      }
    });
  }

  // Show/hide data textbox logic
  showDataCheckbox.addEventListener('change', () => {
    dataTextbox.style.display = showDataCheckbox.checked ? 'block' : 'none';
  });

  // --- File Subpanel Drag & Drop for AP Location ---
  if (apFileDrag && logFileInputContainer && logFileDropzone &&
      gtFileInputContainer && gtFileDropzone) {
    apFileDrag.addEventListener('change', () => {
      if (apFileDrag.checked) {
        logFileInputContainer.style.display = 'none';
        logFileDropzone.style.display = 'block';
        if (fileText && fileText.value) {
          logFileDropzoneText.textContent =
              `Current: ${fileText.value} (Drop file to replace)`;
        } else {
          logFileDropzoneText.textContent = 'Drag & Drop FIND Log CSV Here';
        }

        gtFileInputContainer.style.display = 'none';
        gtFileDropzone.style.display = 'block';
        if (gtFileText && gtFileText.value) {
          gtFileDropzoneText.textContent =
              `Current: ${gtFileText.value} (Drop file to replace)`;
        } else {
          gtFileDropzoneText.textContent = 'Drag & Drop GT Coords CSV Here';
        }
      } else {
        logFileInputContainer.style.display = 'flex';
        logFileDropzone.style.display = 'none';
        gtFileInputContainer.style.display = 'flex';
        gtFileDropzone.style.display = 'none';
      }
    });

    // Log CSV dropzone drag-and-drop event handlers
    logFileDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      logFileDropzone.style.background = '#e8f0fe';
      logFileDropzone.style.borderColor = '#174ea6';
    });

    logFileDropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      logFileDropzone.style.background = '#f8fafd';
      logFileDropzone.style.borderColor = '#1a73e8';
    });

    logFileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      logFileDropzone.style.background = '#f8fafd';
      logFileDropzone.style.borderColor = '#1a73e8';
      if (e.dataTransfer && e.dataTransfer.files &&
          e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        localStorage.setItem('lastLogFile', file.name);
        const reader = new FileReader();
        reader.onload = (evt) => {
          processLogContent(evt.target.result, file.name);
        };
        reader.readAsText(file);
      }
    });

    logFileDropzone.addEventListener('click', () => {
      if (browseButton) browseButton.click();
    });

    // GT Coords CSV dropzone drag-and-drop event handlers
    gtFileDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gtFileDropzone.style.background = '#e8f0fe';
      gtFileDropzone.style.borderColor = '#174ea6';
    });

    gtFileDropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gtFileDropzone.style.background = '#f8fafd';
      gtFileDropzone.style.borderColor = '#1a73e8';
    });

    gtFileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gtFileDropzone.style.background = '#f8fafd';
      gtFileDropzone.style.borderColor = '#1a73e8';
      if (e.dataTransfer && e.dataTransfer.files &&
          e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        localStorage.setItem('lastGtFile', file.name);
        const reader = new FileReader();
        reader.onload = (evt) => {
          processGtCoordsContent(evt.target.result, file.name);
        };
        reader.readAsText(file);
      }
    });

    gtFileDropzone.addEventListener('click', () => {
      if (gtBrowseButton) gtBrowseButton.click();
    });
  }

  // Purple reset button in File subpanel: clears all loaded chart data
  // and paints the right panel canvas solid white
  if (btnApFileReset) {
    btnApFileReset.addEventListener('click', () => {
      currentParsedData = null;
      window.currentParsedData = null;
      currentGtCoords = null;
      currentLogContent = '';
      if (fileText) fileText.value = '';
      if (gtFileText) gtFileText.value = '';
      if (fileInput) fileInput.value = '';
      if (gtFileInput) gtFileInput.value = '';
      if (logFileDropzoneText) {
        logFileDropzoneText.textContent = 'Drag & Drop FIND Log CSV Here';
      }
      if (gtFileDropzoneText) {
        gtFileDropzoneText.textContent = 'Drag & Drop GT Coords CSV Here';
      }
      if (dataTextbox) dataTextbox.value = '';

      localStorage.removeItem('lastLogFile');
      localStorage.removeItem('lastGtFile');

      pauseAnimation();
      if (minSlider) {
        minSlider.value = 0;
        minSlider.max = 100;
        minSlider.disabled = true;
      }
      if (maxSlider) {
        maxSlider.value = 100;
        maxSlider.max = 100;
        maxSlider.disabled = true;
      }
      if (sliderRangeFill) {
        sliderRangeFill.style.left = '0%';
        sliderRangeFill.style.width = '100%';
      }
      if (sliderValText) sliderValText.innerText = 'Step: 0 - 100';

      const btnAnimate = document.getElementById('btn-animate');
      const btnReset = document.getElementById('btn-reset');
      const btnIncrement = document.getElementById('btn-increment');
      const btnCancel = document.getElementById('btn-cancel');
      const btnDecrement = document.getElementById('btn-decrement');
      if (btnAnimate) btnAnimate.disabled = true;
      if (btnReset) btnReset.disabled = true;
      if (btnIncrement) btnIncrement.disabled = true;
      if (btnCancel) btnCancel.disabled = true;
      if (btnDecrement) btnDecrement.disabled = true;

      const windowSlider = document.getElementById('window-steps-slider');
      if (windowSlider) {
        windowSlider.value = 100;
        windowSlider.max = 100;
        windowSlider.disabled = true;
      }
      const windowValSpan = document.getElementById('window-steps-val');
      if (windowValSpan) windowValSpan.innerText = 'All';

      const autoRangeBiasVal = document.getElementById('auto-range-bias-val');
      if (autoRangeBiasVal) autoRangeBiasVal.value = '---';
      const enhancedRmsPosVal =
          document.getElementById('enhanced-rms-pos-val');
      if (enhancedRmsPosVal) enhancedRmsPosVal.value = '---';
      const autoStepVal = document.getElementById('auto-step-val');
      if (autoStepVal) autoStepVal.value = '';

      // Clear right panel canvas to solid white
      if (canvas) {
        canvas._plotData = null;
        canvas._zoomFactor = 1.0;
        canvas._panX = 0;
        canvas._panY = 0;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }
      }
    });
  }

  // --- Animation Playback Logic ---
  let animInterval = null;

  /**
   * Sets the playback animation to a specific step index.
   *
   * <p>
   * Clamps the target step within slider limits, updates slider positions,
   * and triggers visual updates.
   * </p>
   *
   * @param {number} step Target step index to display.
   */
  function setAnimationStep(step) {
    if (!maxSlider) return;
    const maxVal = parseInt(maxSlider.max, 10) || 100;
    const targetStep = Math.max(0, Math.min(step, maxVal));
    maxSlider.value = targetStep;
    
    if (minSlider && parseInt(minSlider.value, 10) > targetStep) {
      minSlider.value = targetStep;
    }
    updateDualSliderUI();
  }

  // --- Canvas Recording Logic ---
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStream = null;

  /**
   * Initiates canvas video capture and recording via MediaRecorder.
   *
   * <p>
   * Captures a 30 FPS stream from the plot canvas and stores video chunks
   * using MP4 or WebM encoding.
   * </p>
   */
  function startRecording() {
    if (!canvas) return;
    recordedChunks = [];
    
    recordingStream = canvas.captureStream(30);
    
    let options = { mimeType: 'video/mp4; codecs=avc1' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/mp4' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm; codecs=vp9' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options = { mimeType: 'video/webm' };
        }
      }
    }

    console.log("Recording canvas with mimeType:", options.mimeType);

    try {
      mediaRecorder = new MediaRecorder(recordingStream, options);
    } catch (e) {
      console.error("Failed to create MediaRecorder:", e);
      return;
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      downloadRecording();
    };

    mediaRecorder.start();
  }

  /**
   * Stops active media recording and releases canvas capture stream tracks.
   */
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (recordingStream) {
      recordingStream.getTracks().forEach(track => track.stop());
      recordingStream = null;
    }
  }

  /**
   * Compiles recorded video chunks into a Blob and triggers browser download.
   */
  function downloadRecording() {
    if (recordedChunks.length === 0) return;
    
    const mimeType = mediaRecorder.mimeType;
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    
    const filename = `rtt-ranging-tool-anim-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
  }

  const btnAnimate = document.getElementById('btn-animate');
  const animDelayInput = document.getElementById('anim-delay');

  /**
   * Begins automatic step increment animation across the trajectory dataset.
   *
   * <p>
   * Starts recording if requested, configures interval timer based on delay
   * setting, and steps through sequential slider positions.
   * </p>
   */
  function startAnimation() {
    if (!minSlider || !maxSlider) return;
    pauseAnimation();

    if (btnAnimate) {
      btnAnimate.innerText = 'Pause';
      btnAnimate.classList.remove('green');
      btnAnimate.classList.add('purple');
    }

    const recordCheckbox = document.getElementById('record-checkbox');
    if (recordCheckbox && recordCheckbox.checked) {
      startRecording();
    }

    const delay = parseInt(animDelayInput.value, 10) || 250;
    
    if (parseInt(maxSlider.value, 10) >= parseInt(maxSlider.max, 10)) {
      setAnimationStep(0);
    }

    animInterval = setInterval(() => {
      const cur = parseInt(maxSlider.value, 10);
      const maxLimit = parseInt(maxSlider.max, 10);
      if (cur < maxLimit) {
        setAnimationStep(cur + 1);
      } else {
        pauseAnimation();
      }
    }, delay);
  }

  /**
   * Pauses active trajectory playback animation and clears timer interval.
   */
  function pauseAnimation() {
    if (animInterval) {
      clearInterval(animInterval);
      animInterval = null;
    }
    if (btnAnimate) {
      btnAnimate.innerText = 'Animate';
      btnAnimate.classList.remove('purple');
      btnAnimate.classList.add('green');
    }
    stopRecording();
  }
  window.pauseAnimation = pauseAnimation;

  if (btnAnimate) {
    btnAnimate.addEventListener('click', () => {
      if (btnAnimate.classList.contains('green')) {
        startAnimation();
      } else {
        pauseAnimation();
      }
    });
  }

  const btnReset = document.getElementById('btn-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      pauseAnimation();
      setAnimationStep(0);
      if (minSlider) {
        minSlider.value = 0;
      }
      updateDualSliderUI();
    });
  }

  const btnIncrement = document.getElementById('btn-increment');
  if (btnIncrement) {
    btnIncrement.addEventListener('click', () => {
      pauseAnimation();
      if (maxSlider) {
        const cur = parseInt(maxSlider.value, 10);
        setAnimationStep(cur + 1);
      }
    });
  }

  const btnDecrement = document.getElementById('btn-decrement');
  if (btnDecrement) {
    btnDecrement.addEventListener('click', () => {
      pauseAnimation();
      if (maxSlider) {
        const cur = parseInt(maxSlider.value, 10);
        setAnimationStep(cur - 1);
      }
    });
  }

  const btnCancel = document.getElementById('btn-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      pauseAnimation();
      if (minSlider && maxSlider) {
        minSlider.value = 0;
        maxSlider.value = maxSlider.max;
        updateDualSliderUI();
      }
    });
  }
  const btnScreenshot = document.getElementById('btn-screenshot');
  if (btnScreenshot) {
    btnScreenshot.addEventListener('click', () => {
      const plotCanvas = document.getElementById('plot-canvas');
      if (!plotCanvas) {
        alert('Canvas not found!');
        return;
      }
      try {
        const url = plotCanvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.download = `rtt-ranging-tool-snapshot-${timestamp}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (e) {
        console.error('Failed to take screenshot:', e);
        alert('Failed to take screenshot.');
      }
    });
  }
  /**
   * Resets enhanced algorithm and filter parameters to defaults.
   *
   * @param {boolean=} skipRedraw Whether to skip redrawing the display.
   */
  function resetEnhancedInputParams(skipRedraw = false) {
    if (enhancedStepLengthInput) enhancedStepLengthInput.value = 0.67;
    if (enhancedDiversityInput) enhancedDiversityInput.value = 0.8;
    if (enhancedRssiInput) enhancedRssiInput.value = -95;
    if (enhancedSuccessInput) enhancedSuccessInput.value = 5;
    if (enhancedStdDevInput) enhancedStdDevInput.value = 2.0;

    const limitGtCheckbox = document.getElementById('limit-gt-checkbox');
    if (limitGtCheckbox) limitGtCheckbox.checked = true;

    const windowStepsSlider = document.getElementById('window-steps-slider');
    const windowStepsVal = document.getElementById('window-steps-val');
    if (windowStepsSlider) {
      windowStepsSlider.value = windowStepsSlider.max || 100;
      const val = windowStepsSlider.value;
      if (windowStepsVal) windowStepsVal.innerText = 'All (' + val + ')';
    }
    window.windowStepsLimit = Infinity;

    const rangeBiasNoneRadio = document.querySelector('input[name="range-bias-mode"][value="none"]');
    if (rangeBiasNoneRadio) rangeBiasNoneRadio.checked = true;

    const manualBiasInput = document.getElementById('manual-bias');
    if (manualBiasInput) manualBiasInput.value = 0.5;

    const scaleRangeInput = document.getElementById('scale-range');
    if (scaleRangeInput) scaleRangeInput.value = 0.93;

    const biasInput = document.getElementById('auto-range-bias-val');
    if (biasInput) biasInput.value = '---';

    window.rangeBiasMode = 'none';
    window.manualBias = 0.5;
    window.scaleRange = 0.93;

    if (!skipRedraw) updateDisplay();
  }

  /**
   * Resets Gauss-Newton solver initialization and weights to defaults.
   *
   * @param {boolean=} skipRedraw Whether to skip redrawing the display.
   */
  function resetNgSolverParams(skipRedraw = false) {
    const initFirstRadio = document.querySelector('input[name="ng-init"][value="first"]');
    if (initFirstRadio) initFirstRadio.checked = true;

    const rssiNoneRadio = document.querySelector('input[name="rssi-weight"][value="none"]');
    if (rssiNoneRadio) rssiNoneRadio.checked = true;
    
    const rangeNoneRadio = document.querySelector('input[name="range-weight"][value="none"]');
    if (rangeNoneRadio) rangeNoneRadio.checked = true;

    const successCheckbox = document.getElementById('weight-success');
    if (successCheckbox) successCheckbox.checked = false;
    
    const sdCheckbox = document.getElementById('weight-sd');
    if (sdCheckbox) sdCheckbox.checked = false;

    window.ngInitMode = 'first';
    window.rssiWeightMode = 'none';
    window.rangeWeightMode = 'none';
    window.weightSuccess = false;
    window.weightSd = false;

    if (!skipRedraw) updateDisplay();
  }

  /**
   * Resets spatial optimization and RANSAC parameters to defaults.
   *
   * @param {boolean=} skipRedraw Whether to skip redrawing the display.
   */
  function resetSpatialOptimizationParams(skipRedraw = false) {
    const noneRansacRadio = document.querySelector('input[name="ransac-mode"][value="none"]');
    if (noneRansacRadio) noneRansacRadio.checked = true;

    const autoStepValInput = document.getElementById('auto-step-val');
    if (autoStepValInput) autoStepValInput.value = '---';

    const autoStepCheckbox = document.getElementById('auto-step-checkbox');
    if (autoStepCheckbox) autoStepCheckbox.checked = false;
    const spatialRansacCheckbox = document.getElementById('spatial-ransac-checkbox');
    if (spatialRansacCheckbox) spatialRansacCheckbox.checked = false;

    window.ransacMode = 'none';

    if (!skipRedraw) updateDisplay();
  }

  /**
   * Ensures the subpanel containing the specified button is expanded.
   *
   * @param {?HTMLElement} btn The button element within the target subpanel.
   */
  function ensureSubpanelShown(btn) {
    if (!btn) return;
    const subpanel = btn.closest('.subpanel');
    if (!subpanel) return;
    const showCb = subpanel.querySelector('.subpanel-show-checkbox');
    if (showCb && !showCb.checked) {
      showCb.checked = true;
      const body = subpanel.querySelector('.subpanel-body');
      if (body) body.style.display = '';
      subpanel.classList.remove('collapsed');
    }
  }

  // AP Location Defaults Buttons
  const btnApDataDefaults = document.getElementById('btn-ap-data-defaults');
  if (btnApDataDefaults) {
    btnApDataDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnApDataDefaults);
      if (showDataCheckbox) {
        showDataCheckbox.checked = false;
        if (dataTextbox) dataTextbox.style.display = 'none';
      }
    });
  }

  const btnPlaybackDefaults = document.getElementById('btn-playback-defaults');
  if (btnPlaybackDefaults) {
    btnPlaybackDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnPlaybackDefaults);
      const btnCancel = document.getElementById('btn-cancel');
      if (btnCancel && !btnCancel.disabled) {
        btnCancel.click();
      }
      if (animDelayInput) animDelayInput.value = 250;
      const recordCheckbox = document.getElementById('record-checkbox');
      if (recordCheckbox) recordCheckbox.checked = false;
      const limitGtCheckbox = document.getElementById('limit-gt-checkbox');
      if (limitGtCheckbox) limitGtCheckbox.checked = true;
      updatePlaySliderLimits(true);
      if (minSlider && maxSlider) {
        minSlider.value = 0;
        maxSlider.value = maxSlider.max || 100;
        updateDualSliderUI();
      }
    });
  }

  const btnEnhancedInputReset = document.getElementById('btn-enhanced-input-reset');
  if (btnEnhancedInputReset) {
    btnEnhancedInputReset.addEventListener('click', () => {
      ensureSubpanelShown(btnEnhancedInputReset);
      resetEnhancedInputParams(false);
    });
  }

  const btnNgSolverReset = document.getElementById('btn-ng-solver-reset');
  if (btnNgSolverReset) {
    btnNgSolverReset.addEventListener('click', () => {
      ensureSubpanelShown(btnNgSolverReset);
      resetNgSolverParams(false);
    });
  }

  const btnSpatialOptReset = document.getElementById('btn-spatial-opt-reset');
  if (btnSpatialOptReset) {
    btnSpatialOptReset.addEventListener('click', () => {
      ensureSubpanelShown(btnSpatialOptReset);
      resetSpatialOptimizationParams(false);
    });
  }

  const btnOptimizeReset = document.getElementById('btn-optimize-reset');
  if (btnOptimizeReset) {
    btnOptimizeReset.addEventListener('click', () => {
      ensureSubpanelShown(btnOptimizeReset);
    });
  }

  const btnMetricsDefaults = document.getElementById('btn-metrics-defaults');
  if (btnMetricsDefaults) {
    btnMetricsDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnMetricsDefaults);
      const cdfModal = document.getElementById('cdf-modal');
      if (cdfModal) cdfModal.style.display = 'none';
      const stepsModal = document.getElementById('steps-modal');
      if (stepsModal) stepsModal.style.display = 'none';
    });
  }

  // Generic handler for all subpanel show/hide checkboxes across both tabs
  document.querySelectorAll('.subpanel-show-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const subpanel = e.target.closest('.subpanel');
      if (!subpanel) return;
      const body = subpanel.querySelector('.subpanel-body');
      if (body) {
        body.style.display = e.target.checked ? '' : 'none';
      }
      if (e.target.checked) {
        subpanel.classList.remove('collapsed');
      } else {
        subpanel.classList.add('collapsed');
      }
    });
  });

  /**
   * Resets all AP Location algorithm, solver, filter, and playback parameters.
   *
   * <p>
   * Restores initial slider bounds, weights, biases, and optimizer defaults,
   * then updates the canvas display.
   * </p>
   */
  function resetApParams() {
    if (canvas) {
      canvas._zoomFactor = 1.0;
      canvas._panX = 0;
      canvas._panY = 0;
    }
    // 1. Reset Playback
    if (animDelayInput) animDelayInput.value = 250;
    const recordCheckbox = document.getElementById('record-checkbox');
    if (recordCheckbox) recordCheckbox.checked = false;

    const limitGtCheckbox = document.getElementById('limit-gt-checkbox');
    if (limitGtCheckbox) limitGtCheckbox.checked = true;
    updatePlaySliderLimits(true);

    // 2. Reset Enhanced Alg & Filters
    resetEnhancedInputParams(true);

    // 3. Reset Solver Init & Weights
    resetNgSolverParams(true);

    // 4. Reset Spatial Optimization
    resetSpatialOptimizationParams(true);

    // 5. Trigger redraw
    updateDisplay();
  }

  // Toggle Show[] button: toggles all subpanel show parameters to first
  // true and then false
  let apToggleShowState = false; // Next toggle is true
  if (apToggleShowBtn) {
    apToggleShowBtn.addEventListener('click', () => {
      apToggleShowState = !apToggleShowState;
      const targetState = apToggleShowState;

      const apContent = document.getElementById('tab-content-ap-location');
      if (!apContent) return;

      // Toggle all subpanels except Files (which hosts this toggle button)
      apContent.querySelectorAll('.subpanel').forEach(sp => {
        if (sp.contains(apToggleShowBtn)) return;

        const cb = sp.querySelector('.subpanel-show-checkbox');
        if (cb) cb.checked = targetState;
        const body = sp.querySelector('.subpanel-body');
        if (body) body.style.display = targetState ? '' : 'none';
        if (targetState) {
          sp.classList.remove('collapsed');
        } else {
          sp.classList.add('collapsed');
        }
      });
    });
  }

  const btnApAllDefaults = document.getElementById('btn-ap-all-defaults');
  if (btnApAllDefaults) {
    btnApAllDefaults.addEventListener('click', () => {
      // 1. Reset subpanels on AP Location tab to defaults (Data collapsed).
      const apContent = document.getElementById('tab-content-ap-location');
      if (apContent) {
        apContent.querySelectorAll('.subpanel').forEach(sp => {
          const cb = sp.querySelector('.subpanel-show-checkbox');
          const isData = sp.classList.contains('subpanel-orange') ||
              (cb && cb.id === 'ap-data-show');
          const shouldShow = !isData;
          if (cb) cb.checked = shouldShow;
          const body = sp.querySelector('.subpanel-body');
          if (body) body.style.display = shouldShow ? '' : 'none';
          if (shouldShow) {
            sp.classList.remove('collapsed');
          } else {
            sp.classList.add('collapsed');
          }
        });
      }
      // 2. Reset Data subpanel
      const btnApData = document.getElementById('btn-ap-data-defaults');
      if (btnApData) btnApData.click();
      // 3. Reset file drag checkbox to default (unchecked)
      if (apFileDrag && apFileDrag.checked) {
        apFileDrag.checked = false;
        apFileDrag.dispatchEvent(new Event('change'));
      }
      // 4. Reset all params (functionality previously served by Reset Params)
      resetApParams();
    });
  }
  // --- Zoom Controls ---
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomReset = document.getElementById('btn-zoom-reset');

  /**
   * Redraws the main plot canvas using cached plot data.
   */
  function redrawPlotOnly() {
    if (canvas && canvas._plotData) {
      const d = canvas._plotData;
      if (typeof window.drawPlot === 'function') {
        window.drawPlot(canvas, d.pdrData, d.targetData, d.gtInterpolated, d.minStep, d.maxStep, d.enhancedPdrData);
      }
    }
  }

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      if (canvas) {
        canvas._zoomFactor = (canvas._zoomFactor || 1.0) * 1.2;
        redrawPlotOnly();
      }
    });
  }

  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      if (canvas) {
        canvas._zoomFactor = (canvas._zoomFactor || 1.0) / 1.2;
        redrawPlotOnly();
      }
    });
  }

  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', () => {
      if (canvas) {
        canvas._zoomFactor = 1.0;
        canvas._panX = 0;
        canvas._panY = 0;
        redrawPlotOnly();
      }
    });
  }
  window.updateDisplay = updateDisplay;
  window.redrawPlotOnly = redrawPlotOnly;
});
