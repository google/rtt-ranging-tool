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
 * @fileoverview WRS Range Analysis parsing and chart generation.
 * Implements the algorithms from the WiFi RTT Analyser Colab notebook.
 */

// --- IndexedDB for Range Analysis ---
const WRS_DB_NAME = 'WrsRangeAnalysisDB';
const WRS_STORE_NAME = 'range_handles';

/**
 * Opens or initializes the IndexedDB database for WRS file caching.
 *
 * @return {!Promise<!IDBDatabase>} Promise resolving to the database instance.
 */
function openWrsDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WRS_DB_NAME, 1);
    request.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(WRS_STORE_NAME)) {
        db.createObjectStore(WRS_STORE_NAME);
      }
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
 * Caches the most recently loaded WRS range log in IndexedDB.
 *
 * @param {string} filename The name of the loaded log file.
 * @param {string} content The raw text content of the log file.
 * @return {!Promise<void>} Promise resolving when caching completes.
 */
async function saveWrsFileCache(filename, content) {
  try {
    const db = await openWrsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WRS_STORE_NAME, 'readwrite');
      const store = tx.objectStore(WRS_STORE_NAME);
      store.put({ filename, content, timestamp: Date.now() }, 'last_range_file');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to save WRS file cache to IndexedDB:', err);
  }
}

/**
 * Retrieves the cached WRS range log from IndexedDB.
 *
 * @return {!Promise<?Object>} Promise resolving to cached entry or null.
 */
async function getWrsFileCache() {
  try {
    const db = await openWrsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WRS_STORE_NAME, 'readonly');
      const store = tx.objectStore(WRS_STORE_NAME);
      const req = store.get('last_range_file');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to retrieve WRS file cache:', err);
    return null;
  }
}

/**
 * Clears any cached WRS range log from IndexedDB.
 *
 * @return {!Promise<void>} Promise resolving when cache is cleared.
 */
async function clearWrsFileCache() {
  try {
    const db = await openWrsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WRS_STORE_NAME, 'readwrite');
      const store = tx.objectStore(WRS_STORE_NAME);
      store.delete('last_range_file');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to clear WRS file cache:', err);
  }
}

/**
 * Parses CSV text of a WRS range log into structured row records.
 *
 * @param {string} csvContent Raw CSV text content from log file.
 * @return {?Object} Parsed dataset containing rows and channel, or null.
 */
function parseWrsRangeLog(csvContent) {
  const lines = csvContent.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) {
    return null;
  }

  // Find header line: looks for True Range or similar
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('Range') || l.includes('True Range') || l.includes('Est. Range')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    console.error('Header line containing Range columns not found in WRS file.');
    return null;
  }

  let headerLine = lines[headerIndex];
  if (headerLine.startsWith('#')) {
    headerLine = headerLine.substring(1);
  }

  const rawHeaders = headerLine.split(',').map(h => h.trim());
  // Standardize column keys (stripping enclosing angle brackets and trimming)
  const normKey = (s) => s.replace(/^[<#\s]+|[>\s]+$/g, '').toLowerCase();

  const colMap = {};
  rawHeaders.forEach((h, idx) => {
    const k = normKey(h);
    if (k.includes('true range')) colMap.trueRange = idx;
    else if (k.includes('est. range') || k.includes('est range')) colMap.estRange = idx;
    else if (k.includes('std dev') || k.includes('std. dev') || k.includes('stddev')) colMap.stdDev = idx;
    else if (k.includes('rssi')) colMap.rssi = idx;
    else if (k.includes('ch-mhz') || k.includes('peer-id') || k.includes('channel')) colMap.channel = idx;
    else if (k.includes('time') || k.includes('timestamp') || k === 't' || k.includes('(ms)')) colMap.time = idx;
  });

  if (colMap.trueRange === undefined || colMap.estRange === undefined) {
    console.error('Could not map required columns (<True Range(m)>, <Est. Range(m)>).');
    return null;
  }

  const rows = [];
  let startTimeMs = null;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#')) continue;
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < rawHeaders.length) continue;

    const trueDist = parseFloat(parts[colMap.trueRange]);
    const estDist = parseFloat(parts[colMap.estRange]);
    const stdDev = colMap.stdDev !== undefined ? parseFloat(parts[colMap.stdDev]) : 0.0;
    const rssi = colMap.rssi !== undefined ? parseFloat(parts[colMap.rssi]) : -50.0;
    const channel = colMap.channel !== undefined ? parts[colMap.channel] : '1';
    let rawTimeMs = colMap.time !== undefined ? parseFloat(parts[colMap.time]) : NaN;

    if (!isNaN(trueDist) && !isNaN(estDist)) {
      if (!isNaN(rawTimeMs) && startTimeMs === null) {
        startTimeMs = rawTimeMs;
      }
      const timeSec = (startTimeMs !== null && !isNaN(rawTimeMs)) ? (rawTimeMs - startTimeMs) / 1000.0 : rows.length;

      rows.push({
        rawTimeMs: !isNaN(rawTimeMs) ? rawTimeMs : null,
        timeSec,
        trueDist,
        estDist,
        stdDev: isNaN(stdDev) ? 0.0 : stdDev,
        rssi: isNaN(rssi) ? -50.0 : rssi,
        channel: channel
      });
    }
  }

  if (rows.length === 0) {
    return null;
  }

  const defaultChannel = rows.length > 1 ? rows[1].channel : rows[0].channel;
  return {
    rows,
    channel: defaultChannel,
    bandwidth: getWifiDefaultBandwidth(defaultChannel),
    device: 'Pixel/OS'
  };
}

// --- WiFi Frequency-to-Channel & Bandwidth Utilities ---
// Formula reference:
// • 2.4 GHz Band: Channels 1 to 14: Channel = (frequency - 2407) / 5
//   (Exception: Channel 14 is 2484 MHz)
// • 5 GHz Band: Channels 32 to 177: Channel = (frequency - 5000) / 5
// • 6 GHz Band (Wi-Fi 6E/7): Channels 1 to 233:
//   Channel = (frequency - 5940) / 5 (Exception: Channel 2 is 5935 MHz)

// IEEE 802.11ax/be standard 160 MHz channel bonding blocks in 6 GHz spectrum.
// The 6 GHz spectrum defines 7 immutable 160 MHz blocks, each binding 8
// contiguous 20 MHz primary channels.
// Example: Channel 77 is uniquely part of Block 3 [65, 69, 73, 77, 81, 85, 89,
// 93], center Channel 79 (6345 MHz).
const WLAN_6GHZ_160MHZ_BLOCKS = [
  { block: 1, centerCh: 15, centerFreq: 6025, freqRange: [5945, 6105], primaryChannels: [1, 5, 9, 13, 17, 21, 25, 29] },
  { block: 2, centerCh: 47, centerFreq: 6185, freqRange: [6105, 6265], primaryChannels: [33, 37, 41, 45, 49, 53, 57, 61] },
  { block: 3, centerCh: 79, centerFreq: 6345, freqRange: [6265, 6425], primaryChannels: [65, 69, 73, 77, 81, 85, 89, 93] },
  { block: 4, centerCh: 111, centerFreq: 6505, freqRange: [6425, 6585], primaryChannels: [97, 101, 105, 109, 113, 117, 121, 125] },
  { block: 5, centerCh: 143, centerFreq: 6665, freqRange: [6585, 6745], primaryChannels: [129, 133, 137, 141, 145, 149, 153, 157] },
  { block: 6, centerCh: 175, centerFreq: 6825, freqRange: [6745, 6905], primaryChannels: [161, 165, 169, 173, 177, 181, 185, 189] },
  { block: 7, centerCh: 207, centerFreq: 6985, freqRange: [6905, 7065], primaryChannels: [193, 197, 201, 205, 209, 213, 217, 221] }
];

// Set of valid 5 GHz channels (20 MHz and bonded centers)
const CHANNELS_5GHZ = new Set([
  32, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 68, 70, 72, 74, 76, 78, 80,
  82, 84, 86, 88, 90, 92, 94, 96, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122,
  124, 126, 128, 132, 134, 136, 138, 140, 142, 144, 149, 151, 153, 155, 157, 159, 161, 163,
  165, 167, 169, 171, 173, 175, 177
]);

/**
 * Finds the 6 GHz 160 MHz bonding block for a channel or frequency.
 *
 * @param {number|string} chOrFreq Channel number or frequency in MHz.
 * @return {?Object} Matching 160 MHz block descriptor or null.
 */
function find6Ghz160MhzBlock(chOrFreq) {
  if (chOrFreq === undefined || chOrFreq === null) return null;
  const num = parseFloat(String(chOrFreq).replace(/[^\d.]/g, ''));
  if (isNaN(num) || num <= 0) return null;

  if (num > 233) {
    for (const b of WLAN_6GHZ_160MHZ_BLOCKS) {
      if (num >= b.freqRange[0] && num <= b.freqRange[1]) {
        return b;
      }
    }
    return null;
  }

  const ch = Math.round(num);
  for (const b of WLAN_6GHZ_160MHZ_BLOCKS) {
    if (b.primaryChannels.includes(ch) || b.centerCh === ch) {
      return b;
    }
    const minCh = b.primaryChannels[0];
    const maxCh = b.primaryChannels[b.primaryChannels.length - 1];
    if (ch >= minCh && ch <= maxCh) {
      return b;
    }
  }
  return null;
}

/**
 * Calculates the WiFi channel number from a frequency in MHz.
 *
 * @param {number|string} val Frequency in MHz or channel number.
 * @return {?number} Standard channel number or null if unknown.
 */
function getChannelFromFrequency(val) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
  if (isNaN(num) || num <= 0) return null;

  // Already a channel number (<= 233)
  if (num <= 233) {
    return Math.round(num);
  }

  // 2.4 GHz Band: Channels 1 to 14 (Exception: Channel 14 is 2484 MHz)
  if (Math.abs(num - 2484) < 3) return 14;
  if (num >= 2400 && num <= 2500) {
    return Math.round((num - 2407) / 5);
  }

  // 5 GHz Band: Channels 32 to 177
  if (num >= 4900 && num < 5925) {
    return Math.round((num - 5000) / 5);
  }

  // 6 GHz Band (Wi-Fi 6E/7): Channels 1 to 233
  // (Exception: Channel 2 is 5935 MHz)
  if (Math.abs(num - 5935) < 3) return 2;
  if (num >= 5925 && num <= 7125) {
    return Math.round((num - 5940) / 5);
  }

  return null;
}

/**
 * Formats a channel or frequency value into a readable label.
 *
 * @param {number|string} val Channel or frequency value to format.
 * @return {string} Formatted channel string with frequency info if applicable.
 */
function formatChannelDisplay(val) {
  if (val === undefined || val === null) return '';
  const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
  if (isNaN(num) || num <= 0) return String(val);

  if (num <= 233) {
    return `${Math.round(num)}`;
  }
  const ch = getChannelFromFrequency(num);
  if (ch !== null) {
    return `${ch} (${num} MHz)`;
  }
  return String(val);
}

/**
 * Determines the default WiFi bandwidth for a channel or frequency.
 *
 * @param {number|string} channelOrFreq Channel number or frequency in MHz.
 * @return {string} Default bandwidth string (e.g., '20MHz', '80MHz', '160MHz').
 */
function getWifiDefaultBandwidth(channelOrFreq) {
  if (channelOrFreq === undefined || channelOrFreq === null) return '80MHz';
  const cleaned = String(channelOrFreq).replace(/[^\d.]/g, '');
  const val = parseFloat(cleaned);
  if (isNaN(val) || val <= 0) return '80MHz';

  // 1. If given as a frequency in MHz (from Android logging, e.g. 6135, 6325):
  if (val > 233) {
    // 6 GHz Band (Wi-Fi 6E/7): Channels 1 to 233, Freq: 5925 to 7125 MHz
    // Channel = (val - 5940) / 5 (Exception: Channel 2 is 5935 MHz)
    // Default bandwidth for 6GHz is 160MHz (e.g. 6135 MHz -> Ch 39 -> 160MHz).
    if (val >= 5925 && val <= 7125) {
      return '160MHz';
    }

    // 5 GHz Band: Channels 32 to 177, Freq: 4900 to 5924 MHz
    // Channel = (val - 5000) / 5
    // Default bandwidth for 5GHz is 80MHz (e.g. 5180 MHz -> Ch 36 -> 80MHz).
    if (val >= 4900 && val < 5925) {
      return '80MHz';
    }

    // 2.4 GHz Band: Channels 1 to 14, Freq: 2400 to 2500 MHz
    // Channel = (val - 2407) / 5 (Exception: Channel 14 is 2484 MHz)
    // Default bandwidth for 2.4GHz is 20MHz (e.g. 2412 MHz -> Ch 1 -> 20MHz).
    if (val >= 2400 && val <= 2500) {
      return '20MHz';
    }
  }

  // 2. If given directly as a Channel Number (<= 233):
  const ch = Math.round(val);

  // Channels 1 to 14 default to 2.4 GHz 20MHz
  if (ch >= 1 && ch <= 14) {
    return '20MHz';
  }

  // Check 6 GHz 160 MHz bonding blocks (e.g. Channel 77 -> 160MHz).
  const block6 = find6Ghz160MhzBlock(ch);
  if (block6 && !CHANNELS_5GHZ.has(ch)) {
    return '160MHz';
  }

  // Standard 5 GHz channels (32 to 177)
  if (CHANNELS_5GHZ.has(ch) || (ch >= 32 && ch <= 177)) {
    return '80MHz';
  }

  // Upper 6 GHz channels beyond Block 7 (225 to 233)
  if (ch > 177 && ch <= 233) {
    return '160MHz';
  }

  return '80MHz';
}

/**
 * Calculates linear regression slope and bias for paired coordinates.
 *
 * @param {!Array<number>} xArr Array of independent variable values.
 * @param {!Array<number>} yArr Array of dependent variable values.
 * @return {{slope: number, bias: number}} Fitted slope and intercept.
 */
function calculateLinearFit(xArr, yArr) {
  const n = xArr.length;
  if (n === 0) return { slope: 1, bias: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xArr[i];
    sumY += yArr[i];
    sumXY += xArr[i] * yArr[i];
    sumXX += xArr[i] * xArr[i];
  }
  const denom = (n * sumXX - sumX * sumX);
  if (Math.abs(denom) < 1e-12) return { slope: 1, bias: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const bias = (sumY - slope * sumX) / n;
  return { slope, bias };
}

/**
 * Calculates a percentile value from a pre-sorted numeric array.
 *
 * @param {!Array<number>} sortedArr Pre-sorted array of numeric values.
 * @param {number} p Percentile rank to compute (0 to 100).
 * @return {number} Calculated value at the specified percentile rank.
 */
function calculatePercentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (p <= 0) return sortedArr[0];
  if (p >= 100) return sortedArr[sortedArr.length - 1];
  const index = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}

/**
 * Calculates responsive canvas dimensions based on aspect ratio.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object=} options Optional rendering options with aspectRatio.
 * @return {{width: number, height: number}} Calculated canvas width and height.
 */
function getCanvasDimensions(canvas, options) {
  const parent = canvas.parentElement;
  const width = (parent && parent.clientWidth) ? parent.clientWidth : 700;
  let height = (parent && parent.clientHeight) ? parent.clientHeight : 380;

  if (options && options.aspectRatio) {
    if (options.aspectRatio === '4x3') {
      height = Math.round(width * 3 / 4);
    } else if (options.aspectRatio === '16x9') {
      height = Math.round(width * 9 / 16);
    } else if (options.aspectRatio === 'best-fit') {
      height = 380;
    }
  }
  return { width, height };
}

// --- Chart Drawing Functions ---
/**
 * Renders the distribution spread histogram modal for a distance.
 *
 * @param {!HTMLCanvasElement} canvas Canvas element for modal plot.
 * @param {number} targetTrueDist True distance value in meters.
 * @param {!Array<!Object>} matchingRows Rows matching the true distance.
 * @param {number} normalize Bias normalization offset in meters.
 * @param {!Object} options Active chart rendering options.
 * @param {!Object} data Overall parsed range dataset.
 */
function drawSpreadModalChart(canvas, targetTrueDist, matchingRows, normalize, options, data) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = 880;
  const height = 380;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const estDists = matchingRows.map(r => r.estDist - normalize).sort((a, b) => a - b);
  const n = estDists.length;
  if (n === 0) {
    drawNoDataMessage(ctx, width, height, 'No points at this actual distance.');
    return;
  }

  const minVal = estDists[0];
  const maxVal = estDists[n - 1];
  const spread = maxVal - minVal;
  const meanVal = estDists.reduce((a, b) => a + b, 0) / n;
  const variance = estDists.reduce((a, b) => a + (b - meanVal) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const rmsErr = Math.sqrt(matchingRows.reduce((a, r) => a + ((r.estDist - normalize) - targetTrueDist) ** 2, 0) / n);

  const binCount = Math.min(20, Math.max(5, Math.floor(Math.sqrt(n))));
  const binWidth = (maxVal - minVal) / binCount || 0.05;
  const bins = new Array(binCount).fill(0);
  estDists.forEach(d => {
    let b = Math.floor((d - minVal) / binWidth);
    if (b >= binCount) b = binCount - 1;
    bins[b]++;
  });
  const maxBin = Math.max(1, ...bins);

  const margin = { top: 40, right: 230, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = Math.min(targetTrueDist, minVal) - binWidth * 0.6;
  const maxX = Math.max(targetTrueDist, maxVal) + binWidth * 0.6;
  const minY = 0;
  const maxY = Math.ceil(maxBin * 1.25);

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'Estimated Range (m)', 'Sample Count', 5, options.minorGrid);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Estimated Range Distribution Spread at Actual Dist: ${targetTrueDist.toFixed(2)}m [${options.device}]`,
    width / 2, 22
  );

  // Draw Histogram Bars
  ctx.fillStyle = 'rgba(66, 133, 244, 0.6)';
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 1;
  for (let i = 0; i < binCount; i++) {
    const bLeft = minVal + i * binWidth;
    const bRight = bLeft + binWidth;
    const x0 = getX(bLeft);
    const x1 = getX(bRight);
    const y0 = getY(bins[i]);
    const yBaseline = getY(0);
    const barW = Math.max(1, (x1 - x0) * 0.85);
    const barX = x0 + ((x1 - x0) - barW) / 2;

    ctx.fillRect(barX, y0, barW, yBaseline - y0);
    ctx.strokeRect(barX, y0, barW, yBaseline - y0);
  }

  // Draw individual points strip plot along baseline
  const stripY = getY(0) - 6;
  ctx.fillStyle = '#1a73e8';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  estDists.forEach(d => {
    ctx.beginPath();
    ctx.arc(getX(d), stripY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  // Vertical Reference Line: True Distance (red dashed)
  const trueX = getX(targetTrueDist);
  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(trueX, margin.top);
  ctx.lineTo(trueX, margin.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Vertical Reference Line: Mean Estimated Distance (solid dark blue)
  const meanX = getX(meanVal);
  ctx.strokeStyle = '#1557b0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(meanX, margin.top);
  ctx.lineTo(meanX, margin.top + plotH);
  ctx.stroke();

  // Dedicated Right Margin Area for Legend and Statistics Summary
  const sideX = margin.left + plotW + 15;
  const sideW = 200;

  // Series Legend (top of right area)
  const legX = sideX;
  const legY = margin.top;
  const legW = sideW;
  const legH = 75;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 1;
  ctx.fillRect(legX, legY, legW, legH);
  ctx.strokeRect(legX, legY, legW, legH);

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';

  // Red dashed: True Distance
  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(legX + 8, legY + 18);
  ctx.lineTo(legX + 24, legY + 18);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#202124';
  ctx.fillText(`Actual Dist: ${targetTrueDist.toFixed(2)}m`, legX + 30, legY + 22);

  // Blue solid: Mean Est Distance
  ctx.strokeStyle = '#1557b0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(legX + 8, legY + 38);
  ctx.lineTo(legX + 24, legY + 38);
  ctx.stroke();
  ctx.fillStyle = '#202124';
  ctx.fillText(`Mean Est: ${meanVal.toFixed(2)}m`, legX + 30, legY + 42);

  // Blue dot: Sample points
  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.arc(legX + 16, legY + 58, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#202124';
  ctx.fillText('Sample Data Points', legX + 30, legY + 62);

  // Statistics Summary Box (below legend in right area)
  const boxX = sideX;
  const boxY = margin.top + 85;
  const boxW = sideW;
  const boxH = 175;

  ctx.fillStyle = 'rgba(230, 230, 230, 0.9)';
  ctx.strokeStyle = '#9aa0a6';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('Spread Statistics', boxX + 10, boxY + 18);

  ctx.font = '11px monospace';
  ctx.fillText(`Actual Dist  = ${targetTrueDist.toFixed(2)} m`, boxX + 10, boxY + 36);
  ctx.fillText(`Samples      = ${n}`, boxX + 10, boxY + 53);
  ctx.fillText(`Min Est Dist = ${minVal.toFixed(3)} m`, boxX + 10, boxY + 70);
  ctx.fillText(`Max Est Dist = ${maxVal.toFixed(3)} m`, boxX + 10, boxY + 87);
  ctx.fillText(`Spread       = ${spread.toFixed(3)} m`, boxX + 10, boxY + 104);
  ctx.fillText(`Mean Est     = ${meanVal.toFixed(3)} m`, boxX + 10, boxY + 121);
  ctx.fillText(`Std.Dev      = ${stdDev.toFixed(3)} m`, boxX + 10, boxY + 138);
  ctx.fillText(`RMS Error    = ${rmsErr.toFixed(3)} m`, boxX + 10, boxY + 155);
}

let currentModalData = null;

/**
 * Displays the spread distribution modal for a selected true distance.
 *
 * @param {number} targetTrueDist True distance in meters to inspect.
 * @param {!Object} data Active range analysis data payload.
 * @param {!Object} options Active chart rendering options.
 */
function showSpreadModal(targetTrueDist, data, options) {
  const overlay = document.getElementById('range-spread-modal-overlay');
  const title = document.getElementById('range-spread-modal-title');
  const canvas = document.getElementById('range-spread-modal-canvas');
  if (!overlay || !canvas) return;

  const { filteredRows, normalize } = data;
  const matchingRows = filteredRows.filter(r => Math.abs(r.trueDist - targetTrueDist) < 1e-4);
  if (matchingRows.length === 0) return;

  currentModalData = {
    targetTrueDist,
    matchingRows,
    normalize,
    options,
    data
  };

  if (title) {
    title.textContent = `Estimated Range Distribution Spread at Actual Distance: ${targetTrueDist.toFixed(2)}m (N = ${matchingRows.length})`;
  }

  overlay.style.display = 'flex';
  drawSpreadModalChart(canvas, targetTrueDist, matchingRows, normalize, options, data);
}

/**
 * Closes the spread distribution modal dialog.
 */
function closeSpreadModal() {
  const overlay = document.getElementById('range-spread-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  currentModalData = null;
}


/**
 * Renders estimated versus actual distance scatter chart.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload with trendline params.
 * @param {!Object} options Rendering options including trendline toggles.
 */
function drawEstVsActualChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows, normalize, slope, bias } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available matching filter.');
    return;
  }

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let minX = 0;
  let maxX = Math.max(1, ...filteredRows.map(r => r.trueDist));
  let rawMinY = Math.min(0, ...filteredRows.map(r => r.estDist - normalize));
  let rawMaxY = Math.max(1, ...filteredRows.map(r => r.estDist - normalize));

  maxX = Math.ceil(maxX * 1.05);
  let minY = Math.floor(rawMinY);
  let maxY = Math.ceil(rawMaxY * 1.05);
  if (maxY <= minY) maxY = minY + 1;

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'True Distance (m)', 'Estimated Distance (m)', 5, options.minorGrid, 1);

  // Title
  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Estimated vs Actual Distance: [${options.device}]: CH:${data.channel}, BW:${options.bandwidth}`,
    width / 2, 22
  );

  // Scatter points
  ctx.fillStyle = '#1a73e8';
  filteredRows.forEach(r => {
    const sx = getX(r.trueDist);
    const sy = getY(r.estDist - normalize);
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Trendline (if enabled)
  if (options.showTrendline !== false) {
    const x1 = minX;
    const y1 = (slope * x1 + bias) - normalize;
    const x2 = maxX;
    const y2 = (slope * x2 + bias) - normalize;

    ctx.strokeStyle = '#d93025';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(getX(x1), getY(y1));
    ctx.lineTo(getX(x2), getY(y2));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Perfect Estimated Distance (dashed green line: y = x, if enabled)
  if (options.showPerfectDist !== false) {
    const pX1 = Math.max(minX, minY);
    const pX2 = Math.min(maxX, maxY);
    if (pX2 > pX1) {
      ctx.strokeStyle = '#1e8e3e';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(getX(pX1), getY(pX1));
      ctx.lineTo(getX(pX2), getY(pX2));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Legend / Stats
  if (options.showStats !== false) {
    const legX = margin.left + 15;
    const legY = margin.top + 15;

    const items = [
      { type: 'point', label: 'Ranging Data', color: '#1a73e8' }
    ];
    if (options.showTrendline !== false) {
      items.push({ type: 'line', label: `Trendline: ${slope.toFixed(2)}*x + ${bias.toFixed(2)}`, color: '#d93025', dash: [4, 4] });
    }
    if (options.showPerfectDist !== false) {
      items.push({ type: 'line', label: 'Perfect Distance (y = x)', color: '#1e8e3e', dash: [4, 4] });
    }
    if (options.removeBias) {
      items.push({ type: 'text', label: `Normalized by: ${normalize.toFixed(2)}`, color: '#5f6368' });
    }

    const legH = items.length * 20 + 10;
    const legW = 230;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = '#dadce0';
    ctx.lineWidth = 1;
    ctx.fillRect(legX, legY, legW, legH);
    ctx.strokeRect(legX, legY, legW, legH);

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';

    items.forEach((item, idx) => {
      const rowY = legY + 14 + idx * 20;
      if (item.type === 'point') {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(legX + 15, rowY - 4, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#202124';
        ctx.fillText(item.label, legX + 30, rowY);
      } else if (item.type === 'line') {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(item.dash || []);
        ctx.beginPath();
        ctx.moveTo(legX + 7, rowY - 4);
        ctx.lineTo(legX + 23, rowY - 4);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#202124';
        ctx.fillText(item.label, legX + 30, rowY);
      } else if (item.type === 'text') {
        ctx.fillStyle = item.color;
        ctx.fillText(item.label, legX + 30, rowY);
      }
    });
  }

  // Store point coordinates for mouse click interaction
  canvas._estVsActualPoints = filteredRows.map(r => ({
    trueDist: r.trueDist,
    estDist: r.estDist,
    sx: getX(r.trueDist),
    sy: getY(r.estDist - normalize)
  }));

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hoveredPoint = null;
    if (canvas._estVsActualPoints) {
      for (const p of canvas._estVsActualPoints) {
        const d2 = (mx - p.sx) ** 2 + (my - p.sy) ** 2;
        if (d2 <= 8 * 8) {
          hoveredPoint = p;
          break;
        }
      }
    }
    if (hoveredPoint) {
      canvas.style.cursor = 'pointer';
      canvas.title = `Actual: ${hoveredPoint.trueDist.toFixed(2)}m (Click to view spread distribution)`;
    } else {
      canvas.style.cursor = 'default';
      canvas.title = '';
    }
  };

  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (!canvas._estVsActualPoints) return;
    let closest = null;
    let minD2 = Infinity;
    for (const p of canvas._estVsActualPoints) {
      const d2 = (mx - p.sx) ** 2 + (my - p.sy) ** 2;
      if (d2 < minD2) {
        minD2 = d2;
        closest = p;
      }
    }
    if (closest && minD2 <= 12 * 12) {
      showSpreadModal(closest.trueDist, data, options);
    }
  };
}

/**
 * Renders cumulative distribution function (CDF) of range errors.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including minor grid mode.
 */
function drawCdfChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows, normalize } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  const isSigned = options.signedDistribution !== false;
  const signedStr = isSigned ? 'signed' : 'unsigned';

  const errors = filteredRows.map(r => {
    const err = (r.estDist - normalize) - r.trueDist;
    return isSigned ? err : Math.abs(err);
  }).sort((a, b) => a - b);
  const n = errors.length;

  const meanErr = errors.reduce((acc, v) => acc + v, 0) / n;
  const cdf50 = calculatePercentile(errors, 50);
  const cdf68 = calculatePercentile(errors, 68);
  const cdf90 = calculatePercentile(errors, 90);
  const cdf95 = calculatePercentile(errors, 95);
  const cdf99 = calculatePercentile(errors, 99);
  const minErr = errors[0];
  const maxErr = errors[errors.length - 1];

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let minX, maxX;
  if (isSigned) {
    const span = (maxErr - minErr) || 1;
    const padding = span * 0.05;
    minX = (minErr >= 0 && minErr > span * 2) ? (minErr - padding) : Math.min(0, minErr - padding);
    maxX = (maxErr <= 0 && Math.abs(maxErr) > span * 2) ? (maxErr + padding) : Math.max(0, maxErr + padding);
  } else {
    minX = 0;
    maxX = Math.max(1, maxErr * 1.05);
  }
  const minY = 0;
  const maxY = 100;

  const getX = x => margin.left + ((x - minX) / (maxX - minX || 1)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'Range Error (m)', 'CDF (%)', 10, options.minorGrid);

  // Title
  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `CDF of Range Errors (${signedStr}): [${options.device}]: CH:${data.channel}, BW:${options.bandwidth}`,
    width / 2, 22
  );

  // CDF Line
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  errors.forEach((err, i) => {
    const cdfVal = ((i + 1) / n) * 100;
    const sx = getX(err);
    const sy = getY(cdfVal);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.stroke();

  // Statistics Box
  if (options.showStats !== false) {
    const rmsErr = Math.sqrt(errors.reduce((acc, v) => acc + v * v, 0) / n);
    const boxW = 140;
    const boxH = 190;
    const boxX = margin.left + plotW - boxW - 15;
    const boxY = margin.top + plotH - boxH - 20;

    ctx.fillStyle = 'rgba(230, 230, 230, 0.85)';
    ctx.strokeStyle = '#9aa0a6';
    ctx.lineWidth = 1;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = '#202124';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Statistics', boxX + 10, boxY + 18);
    ctx.font = '11px monospace';
    ctx.fillText(`mean  = ${meanErr.toFixed(2)}`, boxX + 10, boxY + 36);
    ctx.fillText(`RMS   = ${rmsErr.toFixed(2)}`, boxX + 10, boxY + 54);
    ctx.fillText(`cdf50 = ${cdf50.toFixed(2)}`, boxX + 10, boxY + 72);
    ctx.fillText(`cdf68 = ${cdf68.toFixed(2)}`, boxX + 10, boxY + 90);
    ctx.fillText(`cdf90 = ${cdf90.toFixed(2)}`, boxX + 10, boxY + 108);
    ctx.fillText(`cdf95 = ${cdf95.toFixed(2)}`, boxX + 10, boxY + 126);
    ctx.fillText(`cdf99 = ${cdf99.toFixed(2)}`, boxX + 10, boxY + 144);
    ctx.fillText(`max   = ${maxErr.toFixed(2)}`, boxX + 10, boxY + 162);
  }
}

/**
 * Renders range estimate spread versus actual distance chart.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including stats box toggle.
 */
function drawSpreadChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  // Calculate spread per unique true distance
  const mapByTrue = {};
  filteredRows.forEach(r => {
    if (!mapByTrue[r.trueDist]) {
      mapByTrue[r.trueDist] = [];
    }
    mapByTrue[r.trueDist].push(r.estDist);
  });

  const spreadPoints = Object.keys(mapByTrue).map(k => {
    const tDist = parseFloat(k);
    const arr = mapByTrue[k];
    const minD = Math.min(...arr);
    const maxD = Math.max(...arr);
    return { trueDist: tDist, spread: maxD - minD };
  }).sort((a, b) => a.trueDist - b.trueDist);

  const spreadValues = spreadPoints.map(p => p.spread);
  const minSpr = Math.min(...spreadValues);
  const maxSpr = Math.max(...spreadValues);
  const meanSpr = spreadValues.reduce((a, b) => a + b, 0) / spreadValues.length;

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = 0;
  const maxX = Math.max(1, ...spreadPoints.map(p => p.trueDist)) * 1.05;
  const minY = 0;
  const maxY = Math.max(1, maxSpr * 1.25, ...filteredRows.map(r => r.stdDev * 1.25));

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'True Distance (m)', 'Spread (m)', 5, options.minorGrid);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Spread vs Actual Distance: [${options.device}]: CH:${data.channel}, BW:${options.bandwidth}`,
    width / 2, 22
  );

  // Line for Spread of Range Estimates
  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 2;
  ctx.beginPath();
  spreadPoints.forEach((p, i) => {
    const sx = getX(p.trueDist);
    const sy = getY(p.spread);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.stroke();

  // Scatter of Std.dev
  ctx.fillStyle = '#1a73e8';
  filteredRows.forEach(r => {
    const sx = getX(r.trueDist);
    const sy = getY(r.stdDev);
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legend
  const legX = margin.left + 15;
  const legY = margin.top + 6;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 1;
  ctx.fillRect(legX, legY, 210, 55);
  ctx.strokeRect(legX, legY, 210, 55);

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';

  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(legX + 8, legY + 16);
  ctx.lineTo(legX + 24, legY + 16);
  ctx.stroke();
  ctx.fillStyle = '#202124';
  ctx.fillText('Spread of Range Estimates', legX + 30, legY + 20);

  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.arc(legX + 16, legY + 36, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#202124';
  ctx.fillText('Spread of Std.dev', legX + 30, legY + 40);

  // Statistics Box: 2 Columns (one for each dataset), justified to top right
  if (options.showStats !== false) {
    const spreadOfSpr = maxSpr - minSpr;
    const rmsSpr = Math.sqrt(spreadValues.reduce((a, b) => a + b * b, 0) / (spreadValues.length || 1));
    const stdDevValues = filteredRows.map(r => r.stdDev);
    const minStd = Math.min(...stdDevValues);
    const maxStd = Math.max(...stdDevValues);
    const spreadOfStd = maxStd - minStd;
    const meanStd = stdDevValues.reduce((a, b) => a + b, 0) / (stdDevValues.length || 1);
    const rmsStd = Math.sqrt(stdDevValues.reduce((a, b) => a + b * b, 0) / (stdDevValues.length || 1));

    const boxW = 280;
    const boxH = 130;
    const boxX = margin.left + plotW - boxW - 8;
    const boxY = margin.top + 6;

    ctx.fillStyle = 'rgba(230, 230, 230, 0.85)';
    ctx.strokeStyle = '#9aa0a6';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = '#202124';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Statistics', boxX + 10, boxY + 18);

    // Column 1: Range Spread (m)
    const col1X = boxX + 10;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillStyle = '#d93025';
    ctx.fillText('Range Spread (m):', col1X, boxY + 34);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#202124';
    ctx.fillText(`min    = ${minSpr.toFixed(2)}`, col1X, boxY + 49);
    ctx.fillText(`max    = ${maxSpr.toFixed(2)}`, col1X, boxY + 64);
    ctx.fillText(`spread = ${spreadOfSpr.toFixed(2)}`, col1X, boxY + 79);
    ctx.fillText(`mean   = ${meanSpr.toFixed(2)}`, col1X, boxY + 94);
    ctx.fillText(`RMS    = ${rmsSpr.toFixed(2)}`, col1X, boxY + 109);

    // Column 2: Std.Dev (m)
    const col2X = boxX + 145;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillStyle = '#1a73e8';
    ctx.fillText('Std.Dev (m):', col2X, boxY + 34);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#202124';
    ctx.fillText(`min    = ${minStd.toFixed(2)}`, col2X, boxY + 49);
    ctx.fillText(`max    = ${maxStd.toFixed(2)}`, col2X, boxY + 64);
    ctx.fillText(`spread = ${spreadOfStd.toFixed(2)}`, col2X, boxY + 79);
    ctx.fillText(`mean   = ${meanStd.toFixed(2)}`, col2X, boxY + 94);
    ctx.fillText(`RMS    = ${rmsStd.toFixed(2)}`, col2X, boxY + 109);
  }
}

/**
 * Renders error distribution histogram (signed or unsigned).
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including signed error flag.
 */
function drawDistributionChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows, normalize } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  const isSigned = options.signedDistribution !== false;
  const distErrs = filteredRows.map(r => {
    const err = (r.estDist - normalize) - r.trueDist;
    return isSigned ? err : Math.abs(err);
  }).sort((a, b) => a - b);
  const n = distErrs.length;

  const meanErr = distErrs.reduce((a, b) => a + b, 0) / n;
  const cdf50 = calculatePercentile(distErrs, 50);
  const cdf68 = calculatePercentile(distErrs, 68);
  const cdf90 = calculatePercentile(distErrs, 90);
  const cdf95 = calculatePercentile(distErrs, 95);
  const cdf99 = calculatePercentile(distErrs, 99);

  // Binning
  const binCount = Math.min(30, Math.max(10, Math.floor(Math.sqrt(n))));
  const minVal = distErrs[0];
  const maxVal = distErrs[distErrs.length - 1];
  const binWidth = (maxVal - minVal) / binCount || 0.1;

  const bins = new Array(binCount).fill(0);
  distErrs.forEach(err => {
    let bIdx = Math.floor((err - minVal) / binWidth);
    if (bIdx >= binCount) bIdx = binCount - 1;
    bins[bIdx]++;
  });

  const maxBinCount = Math.max(...bins);

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = isSigned ? (minVal - binWidth * 0.5) : Math.max(0, minVal - binWidth * 0.5);
  const maxX = maxVal + binWidth * 0.5;
  const minY = 0;
  const maxY = Math.ceil(maxBinCount * 1.15);

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  const signedStr = isSigned ? 'signed' : 'unsigned';
  const xLabel = `Distance Error (${signedStr}, m)`;
  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, xLabel, 'Count', 5, options.minorGrid);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Distribution of Range Error (${signedStr}): [${options.device}]: CH:${data.channel}, BW:${options.bandwidth}`,
    width / 2, 22
  );

  // Draw Bars
  ctx.fillStyle = 'rgba(128, 0, 128, 0.7)';
  ctx.strokeStyle = '#4a148c';
  ctx.lineWidth = 1;
  for (let i = 0; i < binCount; i++) {
    const bLeft = minVal + i * binWidth;
    const bRight = bLeft + binWidth;
    const x0 = getX(bLeft);
    const x1 = getX(bRight);
    const y0 = getY(bins[i]);
    const yBaseline = getY(0);
    const barW = Math.max(1, (x1 - x0) * 0.85);
    const barX = x0 + ((x1 - x0) - barW) / 2;

    ctx.fillRect(barX, y0, barW, yBaseline - y0);
    ctx.strokeRect(barX, y0, barW, yBaseline - y0);
  }

  // Statistics Box & Overlap Avoidance
  if (options.showStats !== false) {
    const rmsErr = Math.sqrt(distErrs.reduce((acc, v) => acc + v * v, 0) / n);
    const boxW = 145;
    const boxH = 190;
    const boxY = margin.top + 20;
    const leftBoxX = margin.left + 15;
    const rightBoxX = margin.left + plotW - boxW - 15;

    let leftOverlapCount = 0;
    let rightOverlapCount = 0;
    for (let i = 0; i < binCount; i++) {
      const bLeft = minVal + i * binWidth;
      const bRight = bLeft + binWidth;
      const x0 = getX(bLeft);
      const x1 = getX(bRight);
      const y0 = getY(bins[i]);

      if (x1 >= leftBoxX && x0 <= leftBoxX + boxW && y0 < boxY + boxH + 10) {
        leftOverlapCount += bins[i];
      }
      if (x1 >= rightBoxX && x0 <= rightBoxX + boxW && y0 < boxY + boxH + 10) {
        rightOverlapCount += bins[i];
      }
    }

    const boxX = (leftOverlapCount <= rightOverlapCount) ? leftBoxX : rightBoxX;

    ctx.fillStyle = 'rgba(230, 230, 230, 0.85)';
    ctx.strokeStyle = '#9aa0a6';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = '#202124';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Statistics', boxX + 10, boxY + 18);
    ctx.font = '11px monospace';
    ctx.fillText(`mean  = ${meanErr.toFixed(2)}`, boxX + 10, boxY + 36);
    ctx.fillText(`RMS   = ${rmsErr.toFixed(2)}`, boxX + 10, boxY + 54);
    ctx.fillText(`cdf50 = ${cdf50.toFixed(2)}`, boxX + 10, boxY + 72);
    ctx.fillText(`cdf68 = ${cdf68.toFixed(2)}`, boxX + 10, boxY + 90);
    ctx.fillText(`cdf90 = ${cdf90.toFixed(2)}`, boxX + 10, boxY + 108);
    ctx.fillText(`cdf95 = ${cdf95.toFixed(2)}`, boxX + 10, boxY + 126);
    ctx.fillText(`cdf99 = ${cdf99.toFixed(2)}`, boxX + 10, boxY + 144);
    ctx.fillText(`max   = ${maxVal.toFixed(2)}`, boxX + 10, boxY + 162);
  }
}

/**
 * Renders dual-axis chart of true distance versus std dev and RSSI.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including minor grid mode.
 */
function drawCrossSpreadChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  const margin = { top: 40, right: 65, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = 0;
  const maxX = Math.max(1, ...filteredRows.map(r => r.trueDist)) * 1.05;

  const minStd = 0;
  const maxStd = Math.max(0.5, ...filteredRows.map(r => r.stdDev)) * 1.15;

  const minRssi = Math.min(-90, ...filteredRows.map(r => r.rssi)) - 5;
  const maxRssi = Math.max(-20, ...filteredRows.map(r => r.rssi)) + 5;

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getYLeft = y => margin.top + plotH - ((y - minStd) / (maxStd - minStd)) * plotH;
  const getYRight = y => margin.top + plotH - ((y - minRssi) / (maxRssi - minRssi)) * plotH;

  const xSpan = maxX - minX || 1;
  const xStep = Number((xSpan / 8).toPrecision(1)) || 1;
  const sSpan = maxStd - minStd || 1;
  const sStep = Number((sSpan / 5).toPrecision(1)) || 0.1;

  // Minor Grid Lines
  if (options.minorGrid && options.minorGrid !== 'none') {
    let fraction = 0;
    if (options.minorGrid === '50%') fraction = 0.5;
    else if (options.minorGrid === '25%') fraction = 0.25;
    else if (options.minorGrid === '10%') fraction = 0.1;

    if (fraction > 0) {
      ctx.save();
      ctx.strokeStyle = '#f1f3f4';
      ctx.lineWidth = 0.5;

      const minorXStep = xStep * fraction;
      const startMinorX = Math.ceil(minX / minorXStep) * minorXStep;
      for (let x = startMinorX; x <= maxX + minorXStep * 0.01; x += minorXStep) {
        const sx = getX(x);
        ctx.beginPath();
        ctx.moveTo(sx, margin.top);
        ctx.lineTo(sx, margin.top + plotH);
        ctx.stroke();
      }

      const minorSStep = sStep * fraction;
      const startMinorS = Math.ceil(minStd / minorSStep) * minorSStep;
      for (let s = startMinorS; s <= maxStd + minorSStep * 0.01; s += minorSStep) {
        const sy = getYLeft(s);
        ctx.beginPath();
        ctx.moveTo(margin.left, sy);
        ctx.lineTo(margin.left + plotW, sy);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Major X-axis and Grid
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 0.75;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#5f6368';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const startX = Math.ceil(minX / xStep) * xStep;
  for (let x = startX; x <= maxX; x += xStep) {
    const sx = getX(x);
    ctx.beginPath();
    ctx.moveTo(sx, margin.top);
    ctx.lineTo(sx, margin.top + plotH);
    ctx.stroke();
    ctx.fillText(x.toFixed(xStep < 1 ? 1 : 0), sx, margin.top + plotH + 5);
  }

  // Left Y-axis Grid and Labels (Std.Dev in blue)
  const startS = Math.ceil(minStd / sStep) * sStep;
  for (let s = startS; s <= maxStd; s += sStep) {
    const sy = getYLeft(s);
    ctx.beginPath();
    ctx.moveTo(margin.left, sy);
    ctx.lineTo(margin.left + plotW, sy);
    ctx.stroke();
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a73e8';
  for (let s = startS; s <= maxStd; s += sStep) {
    const sy = getYLeft(s);
    ctx.fillText(s.toFixed(sStep < 1 ? 2 : 1), margin.left - 5, sy);
  }

  // Right Y-axis (RSSI in red)
  ctx.textAlign = 'left';
  ctx.fillStyle = '#d93025';
  for (let r = minRssi; r <= maxRssi; r += (maxRssi - minRssi) / 5) {
    const sy = getYRight(r);
    ctx.fillText(r.toFixed(0), margin.left + plotW + 5, sy);
  }

  // Axis Labels
  ctx.fillStyle = '#202124';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('True Distance (m)', margin.left + plotW / 2, height - 15);

  ctx.save();
  ctx.translate(margin.left - 42, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#1a73e8';
  ctx.fillText('Std.Dev (m)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(margin.left + plotW + 48, margin.top + plotH / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#d93025';
  ctx.fillText('RSSI (dBm)', 0, 0);
  ctx.restore();

  // Title
  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Distance vs Std.Dev (Left) & RSSI (Right): [${options.device}]`, width / 2, 22);

  // Scatter Blue (Std.Dev)
  ctx.fillStyle = '#1a73e8';
  filteredRows.forEach(r => {
    ctx.beginPath();
    ctx.arc(getX(r.trueDist), getYLeft(r.stdDev), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Scatter Red (RSSI)
  ctx.fillStyle = '#d93025';
  filteredRows.forEach(r => {
    ctx.beginPath();
    ctx.arc(getX(r.trueDist), getYRight(r.rssi), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legend
  const legX = margin.left + 15;
  const legY = margin.top + 15;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = '#dadce0';
  ctx.fillRect(legX, legY, 150, 48);
  ctx.strokeRect(legX, legY, 150, 48);

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.arc(legX + 15, legY + 16, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#202124';
  ctx.fillText('Std.Dev (m)', legX + 28, legY + 20);

  ctx.fillStyle = '#d93025';
  ctx.beginPath();
  ctx.arc(legX + 15, legY + 34, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#202124';
  ctx.fillText('RSSI (dBm)', legX + 28, legY + 38);
}

/**
 * Renders standard deviation versus RSSI scatter chart.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including aspect ratio.
 */
function drawStdDevVsRssiChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = Math.min(-90, ...filteredRows.map(r => r.rssi)) - 5;
  const maxX = Math.max(-20, ...filteredRows.map(r => r.rssi)) + 5;
  const minY = 0;
  const maxY = Math.max(0.5, ...filteredRows.map(r => r.stdDev)) * 1.15;

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'RSSI (dBm)', 'Std.Dev (m)', 5, options.minorGrid);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Std.Dev vs RSSI: [${options.device}]`, width / 2, 22);

  // Scatter points in Gold/Amber
  ctx.fillStyle = '#f9a825';
  ctx.strokeStyle = '#f57f17';
  ctx.lineWidth = 1;
  filteredRows.forEach(r => {
    const sx = getX(r.rssi);
    const sy = getY(r.stdDev);
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  // Legend
  const legX = margin.left + plotW - 130;
  const legY = margin.top + 15;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = '#dadce0';
  ctx.fillRect(legX, legY, 115, 30);
  ctx.strokeRect(legX, legY, 115, 30);

  ctx.fillStyle = '#f9a825';
  ctx.beginPath();
  ctx.arc(legX + 15, legY + 15, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#202124';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Std.Dev (m)', legX + 28, legY + 19);
}

/**
 * Renders estimated distance versus elapsed time chart.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} data Filtered range data payload.
 * @param {!Object} options Rendering options including interval stats.
 */
function drawEstDistVsTimeChart(canvas, data, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const { filteredRows, normalize } = data;
  if (filteredRows.length === 0) {
    drawNoDataMessage(ctx, width, height, 'No data available.');
    return;
  }

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const minX = 0;
  const maxTimeVal = Math.max(1, ...filteredRows.map(r => r.timeSec || 0));
  const maxX = Math.ceil(maxTimeVal * 1.05);

  let rawMinY = Math.min(0, ...filteredRows.map(r => r.estDist - normalize), ...filteredRows.map(r => r.trueDist));
  let rawMaxY = Math.max(1, ...filteredRows.map(r => r.estDist - normalize), ...filteredRows.map(r => r.trueDist));

  let minY = Math.floor(rawMinY);
  let maxY = Math.ceil(rawMaxY * 1.05);
  if (maxY <= minY) maxY = minY + 1;

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, 'Time (s)', 'Estimated Distance (m)', 5, options.minorGrid, 1);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Estimated Distance vs Time (s): [${options.device}]: CH:${data.channel}, BW:${options.bandwidth}`,
    width / 2, 22
  );

  // Plot True Distance (dotted/dashed red)
  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  filteredRows.forEach((r, idx) => {
    const sx = getX(r.timeSec || 0);
    const sy = getY(r.trueDist);
    if (idx === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Plot Estimated Distance (blue connected line + points)
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  filteredRows.forEach((r, idx) => {
    const sx = getX(r.timeSec || 0);
    const sy = getY(r.estDist - normalize);
    if (idx === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.stroke();

  ctx.fillStyle = '#1a73e8';
  filteredRows.forEach(r => {
    const sx = getX(r.timeSec || 0);
    const sy = getY(r.estDist - normalize);
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Line Legend (top left)
  const legW = 190;
  const legH = 55;
  const legX = margin.left + 15;
  const legY = margin.top + 15;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 1;
  ctx.fillRect(legX, legY, legW, legH);
  ctx.strokeRect(legX, legY, legW, legH);

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.arc(legX + 15, legY + 18, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(legX + 7, legY + 18);
  ctx.lineTo(legX + 23, legY + 18);
  ctx.stroke();
  ctx.fillStyle = '#202124';
  ctx.fillText('Estimated Distance', legX + 30, legY + 22);

  ctx.strokeStyle = '#d93025';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(legX + 7, legY + 38);
  ctx.lineTo(legX + 23, legY + 38);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#202124';
  ctx.fillText('True Distance', legX + 30, legY + 42);

  // Statistics Box (bottom right, 2 columns)
  if (options.showStats !== false) {
    const meanEst = filteredRows.reduce((a, r) => a + (r.estDist - normalize), 0) / (filteredRows.length || 1);
    const rmsEst = Math.sqrt(filteredRows.reduce((a, r) => a + (r.estDist - normalize) * (r.estDist - normalize), 0) / (filteredRows.length || 1));

    // Calculate intervals between ranges of the same actual distance
    // (excluding transitions).
    const intervals = [];
    for (let i = 1; i < filteredRows.length; i++) {
      const prev = filteredRows[i - 1];
      const curr = filteredRows[i];
      // Do not include ranges which are in transition between two actual ranges
      if (Math.abs(curr.trueDist - prev.trueDist) < 0.001) {
        let dt;
        if (curr.rawTimeMs !== null && curr.rawTimeMs !== undefined &&
            prev.rawTimeMs !== null && prev.rawTimeMs !== undefined) {
          dt = (curr.rawTimeMs - prev.rawTimeMs) / 1000.0;
        } else {
          dt = (curr.timeSec || 0) - (prev.timeSec || 0);
        }
        if (dt > 0) {
          intervals.push(dt);
        }
      }
    }

    const meanInterval = intervals.length > 0 ? (intervals.reduce((a, b) => a + b, 0) / intervals.length) : 0;
    const freqHz = meanInterval > 0 ? (1.0 / meanInterval) : 0;
    const minInterval = intervals.length > 0 ? Math.min(...intervals) : 0;
    const maxInterval = intervals.length > 0 ? Math.max(...intervals) : 0;

    const boxW = 325;
    const boxH = 105;
    const boxX = margin.left + plotW - boxW - 15;
    const boxY = margin.top + plotH - boxH - 15;

    ctx.fillStyle = 'rgba(230, 230, 230, 0.85)';
    ctx.strokeStyle = '#9aa0a6';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Column 1: Overall distance statistics
    const col1X = boxX + 10;
    ctx.fillStyle = '#202124';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Statistics', col1X, boxY + 18);

    ctx.font = '11px monospace';
    ctx.fillText(`duration  = ${maxTimeVal.toFixed(1)} s`, col1X, boxY + 36);
    ctx.fillText(`samples   = ${filteredRows.length}`, col1X, boxY + 53);
    ctx.fillText(`mean dist = ${meanEst.toFixed(2)} m`, col1X, boxY + 70);
    ctx.fillText(`RMS dist  = ${rmsEst.toFixed(2)} m`, col1X, boxY + 87);

    // Column 2: Intervals between ranges of same actual distance
    // (3 decimal places)
    const col2X = boxX + 160;
    ctx.fillStyle = '#1a73e8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('Intervals (same dist):', col2X, boxY + 18);

    const meanStr = intervals.length > 0 ? `${meanInterval.toFixed(3)} s` : 'N/A';
    const freqStr = (intervals.length > 0 && meanInterval > 0) ? `${freqHz.toFixed(3)} Hz` : 'N/A';
    const minStr = intervals.length > 0 ? `${minInterval.toFixed(3)} s` : 'N/A';
    const maxStr = intervals.length > 0 ? `${maxInterval.toFixed(3)} s` : 'N/A';

    ctx.font = '11px monospace';
    ctx.fillStyle = '#202124';
    ctx.fillText(`mean int  = ${meanStr}`, col2X, boxY + 36);
    ctx.fillText(`mean freq = ${freqStr}`, col2X, boxY + 53);
    ctx.fillText(`min int   = ${minStr}`, col2X, boxY + 70);
    ctx.fillText(`max int   = ${maxStr}`, col2X, boxY + 87);
  }
}

/**
 * Computes a rounded upper limit for CRLB chart vertical axis.
 *
 * @param {number} val Maximum CRLB value to bound.
 * @return {number} Rounded nice upper axis limit.
 */
function getNiceMaxY(val) {
  if (!isFinite(val) || val <= 0) return 1.0;
  const target = val * 1.06;
  const exp = Math.floor(Math.log10(target));
  const frac = target / Math.pow(10, exp);
  let niceFrac;
  if (frac <= 1.0) niceFrac = 1.0;
  else if (frac <= 1.2) niceFrac = 1.2;
  else if (frac <= 1.5) niceFrac = 1.5;
  else if (frac <= 2.0) niceFrac = 2.0;
  else if (frac <= 2.5) niceFrac = 2.5;
  else if (frac <= 3.0) niceFrac = 3.0;
  else if (frac <= 4.0) niceFrac = 4.0;
  else if (frac <= 5.0) niceFrac = 5.0;
  else if (frac <= 6.0) niceFrac = 6.0;
  else if (frac <= 8.0) niceFrac = 8.0;
  else niceFrac = 10.0;
  return Number((niceFrac * Math.pow(10, exp)).toPrecision(4));
}

/**
 * Renders Cramer-Rao Lower Bound curves against SNR or RSSI.
 *
 * @param {!HTMLCanvasElement} canvas Target canvas element.
 * @param {!Object} options CRLB options including noise floor and bandwidths.
 */
function drawCrlbChart(canvas, options) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = getCanvasDimensions(canvas, options);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const c_mps = 3e8;
  const noise_dbm = options.crlbNoiseFloor !== undefined ? options.crlbNoiseFloor : -90;
  const rssiMin = options.crlbRssiMin !== undefined ? options.crlbRssiMin : -90;
  const rssiMax = options.crlbRssiMax !== undefined ? options.crlbRssiMax : -30;
  const useSnr = options.crlbUseSnr !== false;

  const CRLB_ALL_BWS = [20e6, 40e6, 80e6, 160e6, 320e6];
  const CRLB_ALL_COLORS = ['#e91e63', '#9c27b0', '#2196f3', '#4caf50', '#ff9800'];
  const bwMinIdx = Math.max(0, Math.min(4, options.crlbBwMinIdx !== undefined ? options.crlbBwMinIdx : 0));
  const bwMaxIdx = Math.max(0, Math.min(4, options.crlbBwMaxIdx !== undefined ? options.crlbBwMaxIdx : 4));
  const minIdx = Math.min(bwMinIdx, bwMaxIdx);
  const maxIdx = Math.max(bwMinIdx, bwMaxIdx);

  const bws = [];
  const colors = [];
  for (let i = minIdx; i <= maxIdx; i++) {
    bws.push(CRLB_ALL_BWS[i]);
    colors.push(CRLB_ALL_COLORS[i]);
  }

  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let minX, maxX, xLabel, titleText;
  if (useSnr) {
    minX = Math.round(rssiMin - noise_dbm);
    maxX = Math.round(rssiMax - noise_dbm);
    xLabel = 'SNR (dB)';
    titleText = `ToA Cramer Rao Lower Bound against SNR (Noise: ${noise_dbm} dBm)`;
  } else {
    minX = rssiMin;
    maxX = rssiMax;
    xLabel = 'RSSI (dBm)';
    titleText = `ToA Cramer Rao Lower Bound against RSSI (Noise: ${noise_dbm} dBm)`;
  }

  let minSnrLinear;
  if (useSnr) {
    minSnrLinear = Math.pow(10, minX / 10);
  } else {
    minSnrLinear = Math.pow(10, (minX - noise_dbm) / 10);
  }
  const minBw = bws.length > 0 ? Math.min(...bws) : 20e6;
  const maxCrlbVal = c_mps / (2 * Math.PI * Math.SQRT2 * minBw * Math.sqrt(Math.max(1e-12, minSnrLinear)));

  const minY = 0;
  const maxY = getNiceMaxY(maxCrlbVal);

  const getX = x => margin.left + ((x - minX) / (maxX - minX)) * plotW;
  const getY = y => margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, xLabel, 'Std Error (m)', 5, options.minorGrid);

  ctx.fillStyle = '#202124';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(titleText, width / 2, 22);

  // Draw curves for each bandwidth
  bws.forEach((bw, idx) => {
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (let xVal = minX; xVal <= maxX; xVal += 0.5) {
      let snrLinear;
      if (useSnr) {
        snrLinear = Math.pow(10, xVal / 10);
      } else {
        snrLinear = Math.pow(10, (xVal - noise_dbm) / 10);
      }
      const crlb = c_mps / (2 * Math.PI * Math.SQRT2 * bw * Math.sqrt(Math.max(1e-12, snrLinear)));
      const sx = getX(xVal);
      const sy = getY(Math.min(crlb, maxY));
      if (first) {
        ctx.moveTo(sx, sy);
        first = false;
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();
  });

  // Legend (respects showStats)
  if (options.showStats !== false) {
    const legX = margin.left + plotW - 120;
    const legY = margin.top + 15;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = '#dadce0';
    ctx.fillRect(legX, legY, 105, bws.length * 18 + 10);
    ctx.strokeRect(legX, legY, 105, bws.length * 18 + 10);

    bws.forEach((bw, idx) => {
      const yPos = legY + 14 + idx * 18;
      ctx.strokeStyle = colors[idx % colors.length];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(legX + 8, yPos);
      ctx.lineTo(legX + 24, yPos);
      ctx.stroke();

      ctx.fillStyle = '#202124';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${bw / 1e6}MHz`, legX + 30, yPos + 3);
    });
  }
}

/**
 * Draws chart axes, grid lines, and tick labels on a canvas context.
 *
 * @param {!CanvasRenderingContext2D} ctx 2D rendering context.
 * @param {!Object} margin Margin offsets for top, right, bottom, left.
 * @param {number} plotW Plot area width in CSS pixels.
 * @param {number} plotH Plot area height in CSS pixels.
 * @param {number} minX Minimum X-axis domain value.
 * @param {number} maxX Maximum X-axis domain value.
 * @param {number} minY Minimum Y-axis domain value.
 * @param {number} maxY Maximum Y-axis domain value.
 * @param {string} xLabel Label text for the X axis.
 * @param {string} yLabel Label text for the Y axis.
 * @param {number=} yDivisions Number of vertical divisions.
 * @param {string=} minorGrid Minor grid interval mode.
 * @param {?number=} yStepOverride Optional step override for Y axis ticks.
 */
function drawAxesAndGrid(ctx, margin, plotW, plotH, minX, maxX, minY, maxY, xLabel, yLabel, yDivisions = 5, minorGrid = 'none', yStepOverride = null) {
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#5f6368';

  // X Grid & Labels
  const xSpan = maxX - minX || 1;
  const xStep = Number((xSpan / 8).toPrecision(1)) || 1;
  const startX = Math.ceil(minX / xStep) * xStep;

  // Y Grid & Labels
  const ySpan = maxY - minY || 1;
  const yStep = yStepOverride ? yStepOverride : (Number((ySpan / yDivisions).toPrecision(1)) || 1);
  const startY = Math.ceil(minY / yStep) * yStep;

  // Minor Grid Lines
  if (minorGrid && minorGrid !== 'none') {
    let fraction = 0;
    if (minorGrid === '50%') fraction = 0.5;
    else if (minorGrid === '25%') fraction = 0.25;
    else if (minorGrid === '10%') fraction = 0.1;

    if (fraction > 0) {
      ctx.save();
      ctx.strokeStyle = '#f1f3f4';
      ctx.lineWidth = 0.5;

      const minorXStep = xStep * fraction;
      const startMinorX = Math.ceil(minX / minorXStep) * minorXStep;
      for (let x = startMinorX; x <= maxX + minorXStep * 0.01; x += minorXStep) {
        const sx = margin.left + ((x - minX) / (maxX - minX)) * plotW;
        ctx.beginPath();
        ctx.moveTo(sx, margin.top);
        ctx.lineTo(sx, margin.top + plotH);
        ctx.stroke();
      }

      const minorYStep = yStep * fraction;
      const startMinorY = Math.ceil(minY / minorYStep) * minorYStep;
      for (let y = startMinorY; y <= maxY + minorYStep * 0.01; y += minorYStep) {
        const sy = margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;
        ctx.beginPath();
        ctx.moveTo(margin.left, sy);
        ctx.lineTo(margin.left + plotW, sy);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Major X Grid & Labels
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 0.75;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const xDecimals = xStep < 0.01 ? 3 : (xStep < 0.1 ? 2 : (xStep < 1 ? 1 : 0));
  for (let x = startX; x <= maxX; x += xStep) {
    const sx = margin.left + ((x - minX) / (maxX - minX)) * plotW;
    ctx.beginPath();
    ctx.moveTo(sx, margin.top);
    ctx.lineTo(sx, margin.top + plotH);
    ctx.stroke();
    ctx.fillText(x.toFixed(xDecimals), sx, margin.top + plotH + 6);
  }

  // Major Y Grid & Labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yDecimals = yStep < 0.01 ? 3 : (yStep < 0.1 ? 2 : (yStep < 1 ? 1 : 0));
  for (let y = startY; y <= maxY + 0.0001; y += yStep) {
    const sy = margin.top + plotH - ((y - minY) / (maxY - minY)) * plotH;
    ctx.beginPath();
    ctx.moveTo(margin.left, sy);
    ctx.lineTo(margin.left + plotW, sy);
    ctx.stroke();
    ctx.fillText(y.toFixed(yDecimals), margin.left - 6, sy);
  }

  // Axis lines
  ctx.strokeStyle = '#5f6368';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  // Zero lines if in range
  if (minX <= 0 && maxX >= 0) {
    const zx = margin.left + ((0 - minX) / (maxX - minX)) * plotW;
    ctx.strokeStyle = '#bdc1c6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zx, margin.top);
    ctx.lineTo(zx, margin.top + plotH);
    ctx.stroke();
  }
  if (minY <= 0 && maxY >= 0) {
    const zy = margin.top + plotH - ((0 - minY) / (maxY - minY)) * plotH;
    ctx.strokeStyle = '#bdc1c6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, zy);
    ctx.lineTo(margin.left + plotW, zy);
    ctx.stroke();
  }

  // Titles
  ctx.fillStyle = '#202124';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(xLabel, margin.left + plotW / 2, margin.top + plotH + 28);

  ctx.save();
  ctx.translate(margin.left - 42, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

/**
 * Draws an empty-state message centered within a canvas.
 *
 * @param {!CanvasRenderingContext2D} ctx 2D rendering context.
 * @param {number} width Canvas width in CSS pixels.
 * @param {number} height Canvas height in CSS pixels.
 * @param {string} msg Informational message to display.
 */
function drawNoDataMessage(ctx, width, height, msg) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#70757a';
  ctx.textAlign = 'center';
  ctx.fillText(msg, width / 2, height / 2);
}

// --- Range Analysis Controller ---
window.rangeAnalysisData = null;

/**
 * Reads UI controls and returns active range analysis configuration.
 *
 * @return {!Object} Current filter and rendering configuration options.
 */
function getRangeOptions() {
  const deviceInput = document.getElementById('range-device-input');
  const bandwidthInput = document.getElementById('range-bandwidth-input');
  const autoBwCheck = document.getElementById('range-bandwidth-auto');
  let bwVal = (bandwidthInput && bandwidthInput.value.trim()) || '80MHz';
  if (autoBwCheck && autoBwCheck.checked && window.rangeAnalysisData) {
    bwVal = getWifiDefaultBandwidth(window.rangeAnalysisData.channel);
    if (bandwidthInput && bandwidthInput.value !== bwVal) {
      bandwidthInput.value = bwVal;
    }
  }
  const removeBiasCheck = document.getElementById('range-remove-bias');
  const filterDataCheck = document.getElementById('range-filter-data');
  const distMinInput = document.getElementById('range-dist-min');
  const distMaxInput = document.getElementById('range-dist-max');
  const minorGridRadio = document.querySelector('input[name="range-chart-minor-grid"]:checked');
  const aspectRatioRadio = document.querySelector('input[name="range-chart-aspect-ratio"]:checked');
  const includeFilenameCheck = document.getElementById('range-chart-include-filename');
  const signedDistCheck = document.getElementById('range-signed-distribution');
  const timeMinInput = document.getElementById('range-time-min');
  const timeMaxInput = document.getElementById('range-time-max');

  return {
    device: (deviceInput && deviceInput.value.trim()) || 'Pixel/OS',
    bandwidth: bwVal,
    removeBias: removeBiasCheck ? removeBiasCheck.checked : true,
    filterData: filterDataCheck ? filterDataCheck.checked : true,
    distMin: distMinInput ? (parseFloat(distMinInput.value) || -1.0) : -1.0,
    distMax: distMaxInput ? (parseFloat(distMaxInput.value) || 11.0) : 11.0,
    timeMin: (timeMinInput && !isNaN(parseFloat(timeMinInput.value))) ? parseFloat(timeMinInput.value) : 0,
    timeMax: (timeMaxInput && !isNaN(parseFloat(timeMaxInput.value))) ? parseFloat(timeMaxInput.value) : Infinity,
    minorGrid: (minorGridRadio && minorGridRadio.value) || '25%',
    aspectRatio: (aspectRatioRadio && aspectRatioRadio.value) || '4x3',
    includeFilename: includeFilenameCheck ? includeFilenameCheck.checked : false,
    signedDistribution: signedDistCheck ? signedDistCheck.checked : true,
    crlbNoiseFloor: document.getElementById('crlb-noise-slider') ? parseFloat(document.getElementById('crlb-noise-slider').value) : -90,
    crlbRssiMin: document.getElementById('crlb-rssi-min') ? parseFloat(document.getElementById('crlb-rssi-min').value) : -90,
    crlbRssiMax: document.getElementById('crlb-rssi-max') ? parseFloat(document.getElementById('crlb-rssi-max').value) : -30,
    crlbBwMinIdx: document.getElementById('crlb-bw-min') ? parseInt(document.getElementById('crlb-bw-min').value, 10) : 0,
    crlbBwMaxIdx: document.getElementById('crlb-bw-max') ? parseInt(document.getElementById('crlb-bw-max').value, 10) : 4,
    crlbUseSnr: document.getElementById('crlb-use-snr') ? document.getElementById('crlb-use-snr').checked : true,
    showTrendline: document.getElementById('range-show-trendline') ? document.getElementById('range-show-trendline').checked : true,
    showPerfectDist: document.getElementById('range-show-perfect-dist') ? document.getElementById('range-show-perfect-dist').checked : false
  };
}

/**
 * Renders all selected range analysis charts into the grid container.
 */
function renderAllSelectedRangeCharts() {
  const container = document.getElementById('range-analysis-container');
  if (!container) return;

  const data = window.rangeAnalysisData;
  if (!data || !data.rows || data.rows.length === 0) {
    container.innerHTML = '';
    container.style.backgroundColor = '#ffffff';
    return;
  }

  container.style.backgroundColor = '#f8f9fa';

  const options = getRangeOptions();

  // Filter dataset based on options and time window
  const filteredRows = data.rows.filter(r => {
    if (options.filterData) {
      if (r.estDist <= options.distMin || r.estDist >= (options.distMax - 1)) return false;
    }
    const t = r.timeSec !== undefined ? r.timeSec : 0;
    if (t < options.timeMin || t > options.timeMax) return false;
    return true;
  });

  const xVals = filteredRows.map(r => r.trueDist);
  const yVals = filteredRows.map(r => r.estDist);
  const { slope, bias } = calculateLinearFit(xVals, yVals);
  const normalize = options.removeBias ? bias : 0;

  const chartPayload = {
    channel: data.channel,
    filteredRows,
    slope,
    bias,
    normalize
  };

  const signedStr = options.signedDistribution !== false ? 'signed' : 'unsigned';
  const labelDist = document.getElementById('label-check-distribution');
  if (labelDist) {
    labelDist.textContent = `Distribution of Range Error (${signedStr})`;
  }
  const labelCdf = document.getElementById('label-check-cdf');
  if (labelCdf) {
    labelCdf.textContent = `CDF of Range Errors (${signedStr})`;
  }

  const chartConfigs = [
    { id: 'chart-check-est-dist', title: 'Estimated vs Actual Distance', render: (c, opt) => drawEstVsActualChart(c, chartPayload, opt || options) },
    { id: 'chart-check-cdf', title: `CDF of Range Errors (${signedStr})`, render: (c, opt) => drawCdfChart(c, chartPayload, opt || options) },
    { id: 'chart-check-spread', title: 'Spread vs Actual Distance', render: (c, opt) => drawSpreadChart(c, chartPayload, opt || options) },
    { id: 'chart-check-distribution', title: `Distribution of Range Error (${signedStr})`, render: (c, opt) => drawDistributionChart(c, chartPayload, opt || options) },
    { id: 'chart-check-cross-spread', title: 'Distance vs Std.Dev & RSSI', render: (c, opt) => drawCrossSpreadChart(c, chartPayload, opt || options) },
    { id: 'chart-check-stddev-rssi', title: 'Std.Dev vs RSSI', render: (c, opt) => drawStdDevVsRssiChart(c, chartPayload, opt || options) },
    { id: 'chart-check-est-dist-time', title: 'Estimated Distance vs Time', render: (c, opt) => drawEstDistVsTimeChart(c, chartPayload, opt || options) },
    { id: 'chart-check-crlb', title: 'Cramer Rao Lower Bound (CRLB)', render: (c, opt) => drawCrlbChart(c, opt || options) }
  ];

/**
 * Generates and triggers download of CSV data for a specific chart.
 *
 * @param {string} chartId Identifier of the chart to export.
 * @param {?Object} chartPayload Active chart data payload.
 * @param {!Object} options Active chart rendering options.
 */
function generateChartCsv(chartId, chartPayload, options) {
  let filename = `${chartId}.csv`;
  let csvContent = '';

  const { filteredRows, normalize, slope, bias } = chartPayload || {};

  switch (chartId) {
    case 'chart-check-est-dist': {
      filename = 'estimated_vs_actual_distance.csv';
      csvContent = 'Index,True Distance (m),Estimated Distance (m),Normalized Estimated Distance (m),Channel\n';
      if (filteredRows) {
        filteredRows.forEach((r, i) => {
          csvContent += `${i + 1},${r.trueDist},${r.estDist},${(r.estDist - normalize).toFixed(4)},${r.channel}\n`;
        });
      }
      break;
    }
    case 'chart-check-cdf': {
      const isSigned = options.signedDistribution !== false;
      filename = isSigned ? 'cdf_range_errors_signed.csv' : 'cdf_range_errors_unsigned.csv';
      csvContent = 'Percentile (%),Range Error (m)\n';
      if (filteredRows && filteredRows.length > 0) {
        const errors = filteredRows.map(r => {
          const err = (r.estDist - normalize) - r.trueDist;
          return isSigned ? err : Math.abs(err);
        }).sort((a, b) => a - b);
        const n = errors.length;
        errors.forEach((err, i) => {
          const pct = ((i + 1) / n * 100).toFixed(2);
          csvContent += `${pct},${err.toFixed(4)}\n`;
        });
      }
      break;
    }
    case 'chart-check-spread': {
      filename = 'spread_vs_actual_distance.csv';
      csvContent = 'True Distance (m),Spread (m),Min Est Distance (m),Max Est Distance (m),Sample Count\n';
      if (filteredRows) {
        const mapByTrue = {};
        filteredRows.forEach(r => {
          if (!mapByTrue[r.trueDist]) mapByTrue[r.trueDist] = [];
          mapByTrue[r.trueDist].push(r.estDist);
        });
        const keys = Object.keys(mapByTrue).map(Number).sort((a, b) => a - b);
        keys.forEach(k => {
          const arr = mapByTrue[k];
          const minD = Math.min(...arr);
          const maxD = Math.max(...arr);
          csvContent += `${k},${(maxD - minD).toFixed(4)},${minD.toFixed(4)},${maxD.toFixed(4)},${arr.length}\n`;
        });
      }
      break;
    }
    case 'chart-check-distribution': {
      const isSigned = options.signedDistribution !== false;
      filename = isSigned ? 'distribution_of_range_error_signed.csv' : 'distribution_of_range_error_unsigned.csv';
      csvContent = 'Bin Start (m),Bin Center (m),Bin End (m),Count\n';
      if (filteredRows && filteredRows.length > 0) {
        const distErrs = filteredRows.map(r => {
          const err = (r.estDist - normalize) - r.trueDist;
          return isSigned ? err : Math.abs(err);
        }).sort((a, b) => a - b);
        const n = distErrs.length;
        const binCount = Math.min(30, Math.max(10, Math.floor(Math.sqrt(n))));
        const minVal = distErrs[0];
        const maxVal = distErrs[distErrs.length - 1];
        const binWidth = (maxVal - minVal) / binCount || 0.1;
        const bins = new Array(binCount).fill(0);
        distErrs.forEach(err => {
          let bIdx = Math.floor((err - minVal) / binWidth);
          if (bIdx >= binCount) bIdx = binCount - 1;
          bins[bIdx]++;
        });
        bins.forEach((count, i) => {
          const bStart = (minVal + i * binWidth).toFixed(4);
          const bCenter = (minVal + (i + 0.5) * binWidth).toFixed(4);
          const bEnd = (minVal + (i + 1) * binWidth).toFixed(4);
          csvContent += `${bStart},${bCenter},${bEnd},${count}\n`;
        });
      }
      break;
    }
    case 'chart-check-cross-spread': {
      filename = 'distance_vs_stddev_rssi.csv';
      csvContent = 'True Distance (m),Estimated Distance (m),Std.Dev (m),RSSI (dBm)\n';
      if (filteredRows) {
        filteredRows.forEach(r => {
          csvContent += `${r.trueDist},${r.estDist},${r.stdDev},${r.rssi}\n`;
        });
      }
      break;
    }
    case 'chart-check-stddev-rssi': {
      filename = 'stddev_vs_rssi.csv';
      csvContent = 'RSSI (dBm),Std.Dev (m),True Distance (m)\n';
      if (filteredRows) {
        filteredRows.forEach(r => {
          csvContent += `${r.rssi},${r.stdDev},${r.trueDist}\n`;
        });
      }
      break;
    }
    case 'chart-check-est-dist-time': {
      filename = 'estimated_distance_vs_time.csv';
      csvContent = 'Index,Time (s),Estimated Distance (m),Normalized Estimated Distance (m),True Distance (m),Channel\n';
      if (filteredRows) {
        filteredRows.forEach((r, i) => {
          csvContent += `${i + 1},${(r.timeSec || 0).toFixed(3)},${r.estDist},${(r.estDist - normalize).toFixed(4)},${r.trueDist},${r.channel}\n`;
        });
      }
      break;
    }
    case 'chart-check-crlb': {
      const useSnr = options.crlbUseSnr !== false;
      const noise_dbm = options.crlbNoiseFloor !== undefined ? options.crlbNoiseFloor : -90;
      const rMin = options.crlbRssiMin !== undefined ? options.crlbRssiMin : -90;
      const rMax = options.crlbRssiMax !== undefined ? options.crlbRssiMax : -30;
      const allBws = [20, 40, 80, 160, 320];
      const bwMinIdx = Math.max(0, Math.min(4, options.crlbBwMinIdx !== undefined ? options.crlbBwMinIdx : 0));
      const bwMaxIdx = Math.max(0, Math.min(4, options.crlbBwMaxIdx !== undefined ? options.crlbBwMaxIdx : 4));
      const minIdx = Math.min(bwMinIdx, bwMaxIdx);
      const maxIdx = Math.max(bwMinIdx, bwMaxIdx);
      const bws = allBws.slice(minIdx, maxIdx + 1);
      const c_mps = 3e8;

      if (useSnr) {
        filename = 'crlb_vs_snr.csv';
        csvContent = 'SNR (dB),Bandwidth (MHz),CRLB Std Error (m)\n';
        const snrMin = Math.round(rMin - noise_dbm);
        const snrMax = Math.round(rMax - noise_dbm);
        for (let snr_db = snrMin; snr_db <= snrMax; snr_db += 1) {
          const snr = Math.pow(10, snr_db / 10);
          bws.forEach(bwMhz => {
            const crlb = c_mps / (2 * Math.PI * Math.SQRT2 * (bwMhz * 1e6) * Math.sqrt(snr));
            csvContent += `${snr_db},${bwMhz},${crlb.toFixed(6)}\n`;
          });
        }
      } else {
        filename = 'crlb_vs_rssi.csv';
        csvContent = 'RSSI (dBm),Bandwidth (MHz),CRLB Std Error (m)\n';
        for (let r = rMin; r <= rMax; r += 1) {
          const snr = Math.pow(10, (r - noise_dbm) / 10);
          bws.forEach(bwMhz => {
            const crlb = c_mps / (2 * Math.PI * Math.SQRT2 * (bwMhz * 1e6) * Math.sqrt(snr));
            csvContent += `${r},${bwMhz},${crlb.toFixed(6)}\n`;
          });
        }
      }
      break;
    }
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

  // Re-build container HTML
  container.innerHTML = '';
  const gridFormat = document.querySelector('input[name="range-chart-grid-format"]:checked')?.value || '2';
  const grid = document.createElement('div');
  grid.className = `range-charts-grid cols-${gridFormat}`;

  let hasAnyChecked = false;
  chartConfigs.forEach((cfg, idx) => {
    const chk = document.getElementById(cfg.id);
    if (chk && chk.checked) {
      hasAnyChecked = true;
      const card = document.createElement('div');
      card.className = 'range-chart-card';

      window.chartStatsVisibility = window.chartStatsVisibility || {};
      const isStatsVisible = window.chartStatsVisibility[cfg.id] !== false;
      const statsBtnLabel = isStatsVisible ? 'Hide Stats' : 'Show Stats';
      const statsBtnStyle = isStatsVisible ? 'background-color: #4285f4; color: white;' : 'background-color: #f1f3f4; color: #3c4043; border: 1px solid #dadce0;';

      const header = document.createElement('div');
      header.className = 'range-chart-card-header';
      header.innerHTML = `
        <span class="range-chart-title">${cfg.title}</span>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="browse-button" style="padding: 2px 8px; font-size: 0.75em;" data-csv-chart-id="${cfg.id}">Save CSV</button>
          <button class="browse-button btn-toggle-stats" style="padding: 2px 8px; font-size: 0.75em; ${statsBtnStyle}" data-stats-chart-id="${cfg.id}" title="Toggle Statistics Box">${statsBtnLabel}</button>
          <button class="browse-button" style="padding: 2px 8px; font-size: 0.75em;" data-canvas-id="range-canvas-${idx}" data-chart-title="${cfg.title}">Save PNG</button>
        </div>
      `;

      const canvasContainer = document.createElement('div');
      canvasContainer.className = `range-chart-canvas-container ratio-${options.aspectRatio || 'best-fit'}`;
      const canvas = document.createElement('canvas');
      canvas.id = `range-canvas-${idx}`;
      canvasContainer.appendChild(canvas);

      card.appendChild(header);
      card.appendChild(canvasContainer);

      if (options.includeFilename) {
        const fname = (data && data.filename) || (document.getElementById('range-file-text')?.value) || '';
        if (fname) {
          const filenameEl = document.createElement('div');
          filenameEl.className = 'range-chart-filename';
          filenameEl.style.fontSize = '0.75em';
          filenameEl.style.color = '#000000';
          filenameEl.style.textAlign = 'left';
          filenameEl.style.marginTop = '6px';
          filenameEl.textContent = fname;
          card.appendChild(filenameEl);
        }
      }

      grid.appendChild(card);

      // Render chart with stats visibility option
      const chartOptions = { ...options, showStats: window.chartStatsVisibility[cfg.id] !== false };
      setTimeout(() => {
        cfg.render(canvas, chartOptions);
      }, 0);
    }
  });

  if (!hasAnyChecked) {
    container.innerHTML = `
      <div class="range-analysis-placeholder">
        <div style="font-size: 2em; margin-bottom: 8px;">☑️</div>
        <div>No charts selected. Check one or more chart boxes in the left panel.</div>
      </div>
    `;
    return;
  }

  container.appendChild(grid);

  // Wire Show Stats toggle buttons
  grid.querySelectorAll('button[data-stats-chart-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const chartId = btn.getAttribute('data-stats-chart-id');
      const current = window.chartStatsVisibility[chartId] !== false;
      window.chartStatsVisibility[chartId] = !current;
      renderAllSelectedRangeCharts();
    });
  });

  // Wire Save CSV buttons
  grid.querySelectorAll('button[data-csv-chart-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const chartId = btn.getAttribute('data-csv-chart-id');
      generateChartCsv(chartId, chartPayload, options);
    });
  });

  // Wire Save PNG buttons
  grid.querySelectorAll('button[data-canvas-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cId = btn.getAttribute('data-canvas-id');
      const c = document.getElementById(cId);
      if (!c) return;

      // Composite over solid white background to guarantee white background
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = c.width;
      tempCanvas.height = c.height;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.fillStyle = '#ffffff';
      tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      tCtx.drawImage(c, 0, 0);

      const fname = (data && data.filename) || (document.getElementById('range-file-text')?.value) || '';
      if (options.includeFilename && fname) {
        tCtx.fillStyle = '#000000';
        tCtx.font = '11px sans-serif';
        tCtx.textAlign = 'left';
        tCtx.textBaseline = 'bottom';
        tCtx.fillText(fname, 10, tempCanvas.height - 10);
      }

      const chartTitle = btn.getAttribute('data-chart-title') || cId;
      const safeTitle = chartTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const link = document.createElement('a');
      link.download = `${safeTitle}.png`;
      link.href = tempCanvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  });
}

// --- Wire Event Handlers ---
window.addEventListener('load', () => {
  // Modal event wiring
  const modalClose = document.getElementById('range-spread-modal-close');
  const modalCloseBtn = document.getElementById('range-spread-modal-close-btn');
  const modalOverlay = document.getElementById('range-spread-modal-overlay');
  const modalSavePng = document.getElementById('range-spread-modal-save-png');
  const modalCanvas = document.getElementById('range-spread-modal-canvas');

  if (modalClose) modalClose.addEventListener('click', closeSpreadModal);
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeSpreadModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeSpreadModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSpreadModal();
  });

  if (modalSavePng && modalCanvas) {
    modalSavePng.addEventListener('click', () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = modalCanvas.width;
      tempCanvas.height = modalCanvas.height;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.fillStyle = '#ffffff';
      tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      tCtx.drawImage(modalCanvas, 0, 0);

      const targetDistStr = currentModalData ? currentModalData.targetTrueDist.toFixed(2) : 'dist';
      const link = document.createElement('a');
      link.download = `estimated_range_spread_actual_${targetDistStr}m.png`;
      link.href = tempCanvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  const fileInput = document.getElementById('range-file-input');
  const fileText = document.getElementById('range-file-text');
  const browseBtn = document.getElementById('range-browse-button');
  const reloadBtn = document.getElementById('range-reload-button');
  const toggleShowBtn = document.getElementById('range-toggle-show-button');
  const btnRangeFileReset = document.getElementById('btn-range-file-reset');

  // Trigger file selection
  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', async () => {
      if (window.showOpenFilePicker) {
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'WRS Log Files', accept: { 'text/*': ['.csv', '.txt', '.log'] } }]
          });
          if (handle) {
            const file = await handle.getFile();
            const text = await file.text();
            processWrsFile(file.name, text);
            saveWrsFileCache(file.name, text);
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.warn('showOpenFilePicker failed, falling back to input:', err);
            fileInput.click();
          }
        }
      } else {
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        processWrsFile(file.name, text);
        saveWrsFileCache(file.name, text);
      };
      reader.readAsText(file);
    });
  }

  /**
   * Formats parsed WRS dataset records into a tab-delimited text summary.
   *
   * @param {?Object} parsed Parsed WRS range log object.
   * @return {string} Multi-line formatted text summary.
   */
  function formatParsedWrsData(parsed) {
    if (!parsed || !parsed.rows) return '';
    const header = `WRS Parsed Summary:\n` +
      `Total Rows: ${parsed.rows.length}\n` +
      `Device: ${parsed.device} | Bandwidth: ${parsed.bandwidth} | Channel: ${formatChannelDisplay(parsed.channel)}\n` +
      `--------------------------------------------------------------------------------\n` +
      `Index\tTime(s)\tTrueDist(m)\tEstDist(m)\tStdDev(m)\tRSSI(dBm)\tChannel\n`;
    const rowLines = parsed.rows.map((r, i) =>
      `${i + 1}\t${r.timeSec !== undefined ? r.timeSec.toFixed(2) : '-'}\t\t${r.trueDist.toFixed(2)}\t\t${r.estDist.toFixed(2)}\t\t${r.stdDev.toFixed(2)}\t\t${r.rssi.toFixed(1)}\t\t${formatChannelDisplay(r.channel)}`
    );
    return header + rowLines.join('\n');
  }

  const rawDataTextbox = document.getElementById('range-raw-data-textbox');
  const parsedDataTextbox = document.getElementById('range-parsed-data-textbox');
  const showRawDataCheckbox = document.getElementById('range-show-raw-data');
  const showParsedDataCheckbox = document.getElementById('range-show-parsed-data');

  if (showRawDataCheckbox && rawDataTextbox) {
    showRawDataCheckbox.addEventListener('change', () => {
      rawDataTextbox.style.display = showRawDataCheckbox.checked ? 'block' : 'none';
    });
  }

  if (showParsedDataCheckbox && parsedDataTextbox) {
    showParsedDataCheckbox.addEventListener('change', () => {
      parsedDataTextbox.style.display = showParsedDataCheckbox.checked ? 'block' : 'none';
    });
  }

  // --- Distance Dual Slider (-5m to 50m) ---
  const distSliderMin = document.getElementById('range-dist-slider-min');
  const distSliderMax = document.getElementById('range-dist-slider-max');
  const distSliderFill = document.getElementById('range-dist-slider-fill');
  const distSliderVal = document.getElementById('range-dist-slider-val');
  const distMinInput = document.getElementById('range-dist-min');
  const distMaxInput = document.getElementById('range-dist-max');

  /**
   * Updates distance dual-slider track fill and bound input values.
   *
   * @param {string} source Trigger source ('slider' or 'input').
   */
  function updateDistSliderUI(source) {
    if (!distSliderMin || !distSliderMax || !distSliderFill || !distMinInput || !distMaxInput) return;
    let vMin, vMax;
    if (source === 'input') {
      vMin = parseFloat(distMinInput.value);
      vMax = parseFloat(distMaxInput.value);
      if (isNaN(vMin)) vMin = -5;
      if (isNaN(vMax)) vMax = 100;
      if (vMin > vMax) { const tmp = vMin; vMin = vMax; vMax = tmp; }
      vMin = Math.max(-5, Math.min(100, vMin));
      vMax = Math.max(-5, Math.min(100, vMax));
      distSliderMin.value = vMin;
      distSliderMax.value = vMax;
    } else {
      let val1 = parseFloat(distSliderMin.value);
      let val2 = parseFloat(distSliderMax.value);
      vMin = Math.min(val1, val2);
      vMax = Math.max(val1, val2);
      distMinInput.value = vMin;
      distMaxInput.value = vMax;
    }
    const totalRange = 105; // 100 - (-5)
    const leftPct = ((vMin - (-5)) / totalRange) * 100;
    const widthPct = ((vMax - vMin) / totalRange) * 100;
    distSliderFill.style.left = leftPct + '%';
    distSliderFill.style.width = widthPct + '%';
    if (distSliderVal) {
      distSliderVal.textContent = `${vMin}m - ${vMax}m`;
    }
  }

  if (distSliderMin && distSliderMax) {
    const handleDistSliderChange = () => {
      updateDistSliderUI('slider');
      renderAllSelectedRangeCharts();
    };
    distSliderMin.addEventListener('input', handleDistSliderChange);
    distSliderMax.addEventListener('input', handleDistSliderChange);
  }

  if (distMinInput && distMaxInput) {
    const handleDistInputChange = () => {
      updateDistSliderUI('input');
      renderAllSelectedRangeCharts();
    };
    distMinInput.addEventListener('input', handleDistInputChange);
    distMaxInput.addEventListener('input', handleDistInputChange);
    distMinInput.addEventListener('change', handleDistInputChange);
    distMaxInput.addEventListener('change', handleDistInputChange);
  }

  // --- Time Window Dual Slider (0s to max time) ---
  const timeSliderMin = document.getElementById('range-time-slider-min');
  const timeSliderMax = document.getElementById('range-time-slider-max');
  const timeSliderFill = document.getElementById('range-time-slider-fill');
  const timeSliderVal = document.getElementById('range-time-slider-val');
  const timeMinInput = document.getElementById('range-time-min');
  const timeMaxInput = document.getElementById('range-time-max');
  const timeSliderMinLabel = document.getElementById('range-time-slider-min-label');
  const timeSliderMaxLabel = document.getElementById('range-time-slider-max-label');

  /**
   * Updates time window dual-slider fill and bound input values.
   *
   * @param {string} source Trigger source ('slider' or 'input').
   */
  function updateTimeSliderUI(source) {
    if (!timeSliderMin || !timeSliderMax || !timeSliderFill || !timeMinInput || !timeMaxInput) return;
    const maxLimit = parseFloat(timeSliderMax.max) || 100;
    let vMin, vMax;
    if (source === 'input') {
      vMin = parseFloat(timeMinInput.value);
      vMax = parseFloat(timeMaxInput.value);
      if (isNaN(vMin)) vMin = 0;
      if (isNaN(vMax)) vMax = maxLimit;
      if (vMin > vMax) { const tmp = vMin; vMin = vMax; vMax = tmp; }
      vMin = Math.max(0, Math.min(maxLimit, vMin));
      vMax = Math.max(0, Math.min(maxLimit, vMax));
      timeSliderMin.value = vMin;
      timeSliderMax.value = vMax;
    } else {
      let val1 = parseFloat(timeSliderMin.value);
      let val2 = parseFloat(timeSliderMax.value);
      vMin = Math.min(val1, val2);
      vMax = Math.max(val1, val2);
      timeMinInput.value = vMin.toFixed(1);
      timeMaxInput.value = vMax.toFixed(1);
    }
    const totalRange = maxLimit > 0 ? maxLimit : 1;
    const leftPct = (vMin / totalRange) * 100;
    const widthPct = ((vMax - vMin) / totalRange) * 100;
    timeSliderFill.style.left = leftPct + '%';
    timeSliderFill.style.width = widthPct + '%';
    if (timeSliderVal) {
      timeSliderVal.textContent = `${vMin.toFixed(1)}s - ${vMax.toFixed(1)}s`;
    }
  }

  /**
   * Updates maximum limits and labels for time window sliders.
   *
   * @param {number} maxTime Maximum elapsed time in seconds.
   */
  function setTimeSliderMaxLimit(maxTime) {
    const ceilMax = Math.max(1, Math.ceil(maxTime));
    if (timeSliderMin) {
      timeSliderMin.max = ceilMax;
      timeSliderMin.value = 0;
    }
    if (timeSliderMax) {
      timeSliderMax.max = ceilMax;
      timeSliderMax.value = ceilMax;
    }
    if (timeMinInput) {
      timeMinInput.max = ceilMax;
      timeMinInput.value = 0;
    }
    if (timeMaxInput) {
      timeMaxInput.max = ceilMax;
      timeMaxInput.value = ceilMax;
    }
    if (timeSliderMinLabel) timeSliderMinLabel.textContent = '0s';
    if (timeSliderMaxLabel) timeSliderMaxLabel.textContent = `${ceilMax}s`;
    updateTimeSliderUI('slider');
  }

  if (timeSliderMin && timeSliderMax) {
    const handleTimeSliderChange = () => {
      updateTimeSliderUI('slider');
      renderAllSelectedRangeCharts();
    };
    timeSliderMin.addEventListener('input', handleTimeSliderChange);
    timeSliderMax.addEventListener('input', handleTimeSliderChange);
  }

  if (timeMinInput && timeMaxInput) {
    const handleTimeInputChange = () => {
      updateTimeSliderUI('input');
      renderAllSelectedRangeCharts();
    };
    timeMinInput.addEventListener('input', handleTimeInputChange);
    timeMaxInput.addEventListener('input', handleTimeInputChange);
    timeMinInput.addEventListener('change', handleTimeInputChange);
    timeMaxInput.addEventListener('change', handleTimeInputChange);
  }

  // --- CRLB Controls Wiring ---
  const crlbNoiseSlider = document.getElementById('crlb-noise-slider');
  const crlbNoiseVal = document.getElementById('crlb-noise-val');
  const crlbRssiMin = document.getElementById('crlb-rssi-min');
  const crlbRssiMax = document.getElementById('crlb-rssi-max');
  const crlbRssiSliderFill = document.getElementById('crlb-rssi-slider-fill');
  const crlbRssiVal = document.getElementById('crlb-rssi-val');
  const crlbBwMin = document.getElementById('crlb-bw-min');
  const crlbBwMax = document.getElementById('crlb-bw-max');
  const crlbBwSliderFill = document.getElementById('crlb-bw-slider-fill');
  const crlbBwVal = document.getElementById('crlb-bw-val');
  const crlbUseSnr = document.getElementById('crlb-use-snr');

  const CRLB_BW_LABELS = ['20', '40', '80', '160', '320'];

  /**
   * Updates CRLB bandwidth dual-slider track fill and text label.
   */
  function updateCrlbBwSliderUI() {
    if (!crlbBwMin || !crlbBwMax || !crlbBwSliderFill) return;
    let idx1 = parseInt(crlbBwMin.value, 10);
    let idx2 = parseInt(crlbBwMax.value, 10);
    const minI = Math.min(idx1, idx2);
    const maxI = Math.max(idx1, idx2);

    const leftPct = (minI / 4) * 100;
    const widthPct = ((maxI - minI) / 4) * 100;

    crlbBwSliderFill.style.left = leftPct + '%';
    crlbBwSliderFill.style.width = widthPct + '%';

    if (crlbBwVal) {
      if (minI === maxI) {
        crlbBwVal.textContent = `${CRLB_BW_LABELS[minI]} MHz`;
      } else {
        crlbBwVal.textContent = `${CRLB_BW_LABELS[minI]} to ${CRLB_BW_LABELS[maxI]} MHz`;
      }
    }
  }

  /**
   * Updates CRLB RSSI dual-slider track fill and text label.
   */
  function updateCrlbRssiSliderUI() {
    if (!crlbRssiMin || !crlbRssiMax || !crlbRssiSliderFill) return;
    let val1 = parseFloat(crlbRssiMin.value);
    let val2 = parseFloat(crlbRssiMax.value);
    const minR = Math.min(val1, val2);
    const maxR = Math.max(val1, val2);

    const minLimit = -110;
    const maxLimit = -10;
    const totalSpan = maxLimit - minLimit; // 100

    const leftPct = ((minR - minLimit) / totalSpan) * 100;
    const widthPct = ((maxR - minR) / totalSpan) * 100;

    crlbRssiSliderFill.style.left = leftPct + '%';
    crlbRssiSliderFill.style.width = widthPct + '%';

    if (crlbRssiVal) {
      crlbRssiVal.textContent = `${minR} to ${maxR} dBm`;
    }
  }

  if (crlbNoiseSlider) {
    crlbNoiseSlider.addEventListener('input', () => {
      if (crlbNoiseVal) crlbNoiseVal.textContent = `${crlbNoiseSlider.value} dBm`;
      renderAllSelectedRangeCharts();
    });
  }

  if (crlbRssiMin && crlbRssiMax) {
    const handleCrlbRssiChange = () => {
      updateCrlbRssiSliderUI();
      renderAllSelectedRangeCharts();
    };
    crlbRssiMin.addEventListener('input', handleCrlbRssiChange);
    crlbRssiMax.addEventListener('input', handleCrlbRssiChange);
  }

  if (crlbBwMin && crlbBwMax) {
    const handleCrlbBwChange = () => {
      updateCrlbBwSliderUI();
      renderAllSelectedRangeCharts();
    };
    crlbBwMin.addEventListener('input', handleCrlbBwChange);
    crlbBwMax.addEventListener('input', handleCrlbBwChange);
  }

  if (crlbUseSnr) {
    crlbUseSnr.addEventListener('change', renderAllSelectedRangeCharts);
  }

  updateCrlbBwSliderUI();

  // --- File Subpanel Drag & Drop ---
  const rangeFileDrag = document.getElementById('range-file-drag');
  const rangeFileInputContainer = document.getElementById('range-file-input-container');
  const rangeFileDropzone = document.getElementById('range-file-dropzone');
  const rangeFileDropzoneText = document.getElementById('range-file-dropzone-text');

  if (rangeFileDrag && rangeFileInputContainer && rangeFileDropzone) {
    rangeFileDrag.addEventListener('change', () => {
      if (rangeFileDrag.checked) {
        rangeFileInputContainer.style.display = 'none';
        rangeFileDropzone.style.display = 'block';
        if (fileText && fileText.value) {
          rangeFileDropzoneText.textContent =
              `Current: ${fileText.value} (Drop file to replace)`;
        } else {
          rangeFileDropzoneText.textContent = 'Drag & Drop Range Log CSV Here';
        }
      } else {
        rangeFileInputContainer.style.display = 'flex';
        rangeFileDropzone.style.display = 'none';
      }
    });

    rangeFileDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rangeFileDropzone.style.background = '#e8f0fe';
      rangeFileDropzone.style.borderColor = '#174ea6';
    });

    rangeFileDropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rangeFileDropzone.style.background = '#f8fafd';
      rangeFileDropzone.style.borderColor = '#1a73e8';
    });

    rangeFileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rangeFileDropzone.style.background = '#f8fafd';
      rangeFileDropzone.style.borderColor = '#1a73e8';
      if (e.dataTransfer && e.dataTransfer.files &&
          e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (evt) => {
          processWrsFile(file.name, evt.target.result);
          saveWrsFileCache(file.name, evt.target.result);
        };
        reader.readAsText(file);
      }
    });

    rangeFileDropzone.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });
  }

  // Purple reset button in File subpanel: clears all loaded data,
  // reestablishes load hint as "Range Log CSV", and clears right panel
  if (btnRangeFileReset) {
    btnRangeFileReset.addEventListener('click', async () => {
      window.rangeAnalysisData = null;
      if (fileText) fileText.value = '';
      if (fileInput) fileInput.value = '';
      if (rangeFileDropzoneText) {
        rangeFileDropzoneText.textContent = 'Drag & Drop Range Log CSV Here';
      }
      if (rawDataTextbox) rawDataTextbox.value = '';
      if (parsedDataTextbox) parsedDataTextbox.value = '';
      await clearWrsFileCache();

      const rangeContainer =
          document.getElementById('range-analysis-container');
      if (rangeContainer) {
        rangeContainer.innerHTML = '';
        rangeContainer.style.backgroundColor = '#ffffff';
      }
    });
  }

  /**
   * Synchronizes bandwidth input with default for the current channel.
   */
  function applyAutoBandwidth() {
    const autoCb = document.getElementById('range-bandwidth-auto');
    const bwInput = document.getElementById('range-bandwidth-input');
    if (!autoCb || !bwInput) return;

    if (autoCb.checked) {
      let ch = window.rangeAnalysisData ? window.rangeAnalysisData.channel : null;
      if (ch === null || ch === undefined) {
        if (rawDataTextbox && rawDataTextbox.value) {
          const parsed = parseWrsRangeLog(rawDataTextbox.value);
          if (parsed) ch = parsed.channel;
        }
      }
      if (ch !== null && ch !== undefined) {
        bwInput.value = getWifiDefaultBandwidth(ch);
      }
      bwInput.readOnly = true;
      bwInput.style.backgroundColor = '#f1f3f4';
    } else {
      bwInput.readOnly = false;
      bwInput.style.backgroundColor = '#ffffff';
    }
  }

  /**
   * Parses WRS log content, updates UI state, and triggers chart redraw.
   *
   * @param {string} name Log file name.
   * @param {string} content Raw text content of the log file.
   */
  function processWrsFile(name, content) {
    if (fileText) fileText.value = name;
    if (rangeFileDropzoneText) rangeFileDropzoneText.textContent = `Loaded: ${name}`;
    if (rawDataTextbox) rawDataTextbox.value = content;
    const parsed = parseWrsRangeLog(content);
    if (!parsed) {
      if (parsedDataTextbox) parsedDataTextbox.value = 'Failed to parse WRS Range Log file.';
      alert('Failed to parse WRS Range Log file. Please check file format.');
      return;
    }
    if (parsedDataTextbox) parsedDataTextbox.value = formatParsedWrsData(parsed);
    parsed.filename = name;
    window.rangeAnalysisData = parsed;
    applyAutoBandwidth();
    const maxTime = Math.max(1, ...parsed.rows.map(r => r.timeSec || 0));
    setTimeSliderMaxLimit(maxTime);
    renderAllSelectedRangeCharts();
  }

  // Reload previous files
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      const cached = await getWrsFileCache();
      if (cached && cached.content) {
        processWrsFile(cached.filename, cached.content);
      } else {
        alert('No previously loaded WRS range file found.');
      }
    });
  }

  // Toggle Show[] button: toggles all subpanel show parameters to first
  // true and then false
  let toggleShowState = false; // Next toggle is true
  if (toggleShowBtn) {
    toggleShowBtn.addEventListener('click', () => {
      toggleShowState = !toggleShowState;
      const targetState = toggleShowState;

      const rangeContent = document.getElementById('tab-content-range-analysis');
      if (!rangeContent) return;

      // 1. Toggle all subpanels except File (which hosts this toggle button)
      rangeContent.querySelectorAll('.subpanel').forEach(sp => {
        if (sp.contains(toggleShowBtn)) return;

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

      // 2. Toggle all parameter sections inside Parameters & Filters
      rangeContent.querySelectorAll('.param-section-show').forEach(cb => {
        cb.checked = targetState;
        const s = cb.closest('.param-section');
        if (s) {
          const b = s.querySelector('.param-section-body');
          if (b) b.style.display = targetState ? '' : 'none';
        }
      });
    });
  }

  /**
   * Ensures the subpanel containing the specified button is expanded.
   *
   * @param {?HTMLElement} btn The button element within the target subpanel.
   */
  function ensureSubpanelShown(btn) {
    const subpanel = btn.closest('.subpanel');
    if (!subpanel) return;
    const showCb = subpanel.querySelector('.subpanel-show-checkbox');
    if (showCb && !showCb.checked) {
      showCb.checked = true;
      const body = subpanel.querySelector('.subpanel-body');
      if (body) body.style.display = '';
    }
  }

  // Range Analysis Defaults Buttons
  const btnRangeAllDefaults = document.getElementById('btn-range-all-defaults');
  if (btnRangeAllDefaults) {
    btnRangeAllDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnRangeAllDefaults);
      toggleShowState = false;
      if (rangeFileDrag) {
        rangeFileDrag.checked = false;
        if (rangeFileInputContainer) rangeFileInputContainer.style.display = 'flex';
        if (rangeFileDropzone) rangeFileDropzone.style.display = 'none';
      }

      if (btnRangeDataDefaults) btnRangeDataDefaults.click();
      if (btnRangeParamsDefaults) btnRangeParamsDefaults.click();
      if (btnRangeChartsDefaults) btnRangeChartsDefaults.click();

      // Reset Show Stats toggles to default (all shown)
      window.chartStatsVisibility = {};
      document.querySelectorAll('.btn-show-stats').forEach(btn => {
        btn.textContent = 'Hide Stats';
        btn.style.backgroundColor = '#f1f3f4';
        btn.style.color = '#3c4043';
      });

      // Reset subpanel visibility to defaults (Data collapsed, others shown)
      const rangeContent = document.getElementById('tab-content-range-analysis');
      if (rangeContent) {
        rangeContent.querySelectorAll('.subpanel').forEach(sp => {
          const cb = sp.querySelector('.subpanel-show-checkbox');
          const isData = sp.classList.contains('subpanel-yellow') || (cb && cb.id === 'range-data-show');
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

      renderAllSelectedRangeCharts();
    });
  }

  const btnRangeDataDefaults = document.getElementById('btn-range-data-defaults');
  if (btnRangeDataDefaults) {
    btnRangeDataDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnRangeDataDefaults);
      if (showRawDataCheckbox) {
        showRawDataCheckbox.checked = false;
        if (rawDataTextbox) rawDataTextbox.style.display = 'none';
      }
      if (showParsedDataCheckbox) {
        showParsedDataCheckbox.checked = false;
        if (parsedDataTextbox) parsedDataTextbox.style.display = 'none';
      }
    });
  }

  const btnRangeParamsDefaults = document.getElementById('btn-range-params-defaults');
  if (btnRangeParamsDefaults) {
    btnRangeParamsDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnRangeParamsDefaults);
      const dev = document.getElementById('range-device-input');
      const autoBw = document.getElementById('range-bandwidth-auto');
      const bias = document.getElementById('range-remove-bias');
      const filt = document.getElementById('range-filter-data');
      const signedDist = document.getElementById('range-signed-distribution');
      const trendCb = document.getElementById('range-show-trendline');
      const perfectCb = document.getElementById('range-show-perfect-dist');
      const minD = document.getElementById('range-dist-min');
      const maxD = document.getElementById('range-dist-max');

      if (dev) dev.value = 'Pixel/OS';
      if (autoBw) autoBw.checked = true;
      applyAutoBandwidth();
      if (bias) bias.checked = true;
      if (filt) filt.checked = true;
      if (signedDist) signedDist.checked = true;
      if (trendCb) trendCb.checked = true;
      if (perfectCb) perfectCb.checked = false;
      if (minD) minD.value = '-1';
      if (maxD) maxD.value = '11';

      if (crlbNoiseSlider) {
        crlbNoiseSlider.value = -90;
        if (crlbNoiseVal) crlbNoiseVal.textContent = '-90 dBm';
      }
      if (crlbRssiMin) crlbRssiMin.value = -90;
      if (crlbRssiMax) crlbRssiMax.value = -30;
      updateCrlbRssiSliderUI();
      if (crlbBwMin) crlbBwMin.value = 0;
      if (crlbBwMax) crlbBwMax.value = 4;
      updateCrlbBwSliderUI();
      if (crlbUseSnr) crlbUseSnr.checked = true;
      updateDistSliderUI('input');

      // Restore parameter section show checkboxes to defaults (CRLB defaults
      // to false, others true)
      const paramsSubpanel = btnRangeParamsDefaults.closest('.subpanel');
      if (paramsSubpanel) {
        paramsSubpanel.querySelectorAll('.param-section-show').forEach(cb => {
          const isCrlb = (cb.id === 'show-params-crlb');
          cb.checked = !isCrlb;
          const s = cb.closest('.param-section');
          if (s) {
            const b = s.querySelector('.param-section-body');
            if (b) b.style.display = isCrlb ? 'none' : '';
          }
        });
      }

      const maxTime = window.rangeAnalysisData ? Math.max(1, ...window.rangeAnalysisData.rows.map(r => r.timeSec || 0)) : 100;
      setTimeSliderMaxLimit(maxTime);

      renderAllSelectedRangeCharts();
    });
  }

  // Wire show/hide checkboxes for each parameter section
  document.querySelectorAll('.param-section-show').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const section = e.target.closest('.param-section');
      if (!section) return;
      const body = section.querySelector('.param-section-body');
      if (body) {
        body.style.display = e.target.checked ? '' : 'none';
      }
    });
  });

  const allChartCbs = [
    'chart-check-est-dist',
    'chart-check-cdf',
    'chart-check-spread',
    'chart-check-distribution',
    'chart-check-cross-spread',
    'chart-check-stddev-rssi',
    'chart-check-est-dist-time',
    'chart-check-crlb'
  ];

  const btnRangeChartsDefaults = document.getElementById('btn-range-charts-defaults');
  if (btnRangeChartsDefaults) {
    btnRangeChartsDefaults.addEventListener('click', () => {
      ensureSubpanelShown(btnRangeChartsDefaults);
      const defFormat = document.querySelector('input[name="range-chart-grid-format"][value="2"]');
      if (defFormat) defFormat.checked = true;
      const defAspect = document.querySelector('input[name="range-chart-aspect-ratio"][value="4x3"]');
      if (defAspect) defAspect.checked = true;
      const defMinor = document.querySelector('input[name="range-chart-minor-grid"][value="25%"]');
      if (defMinor) defMinor.checked = true;
      const defIncludeFilename = document.getElementById('range-chart-include-filename');
      if (defIncludeFilename) defIncludeFilename.checked = false;
      allChartCbs.forEach(id => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = true;
      });
      renderAllSelectedRangeCharts();
    });
  }

  const btnRangeChartsSelectAll = document.getElementById('btn-range-charts-select-all');
  if (btnRangeChartsSelectAll) {
    btnRangeChartsSelectAll.addEventListener('click', () => {
      allChartCbs.forEach(id => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = true;
      });
      renderAllSelectedRangeCharts();
    });
  }

  const btnRangeChartsUnselectAll = document.getElementById('btn-range-charts-unselect-all');
  if (btnRangeChartsUnselectAll) {
    btnRangeChartsUnselectAll.addEventListener('click', () => {
      allChartCbs.forEach(id => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = false;
      });
      renderAllSelectedRangeCharts();
    });
  }


  // Wire format, aspect ratio, and minor grid radio buttons
  document.querySelectorAll('input[name="range-chart-grid-format"], input[name="range-chart-aspect-ratio"], input[name="range-chart-minor-grid"]').forEach(radio => {
    radio.addEventListener('change', renderAllSelectedRangeCharts);
  });

  // Wire chart checkboxes and filter inputs
  const chartCheckboxIds = [
    'chart-check-est-dist',
    'chart-check-cdf',
    'chart-check-spread',
    'chart-check-distribution',
    'chart-check-cross-spread',
    'chart-check-stddev-rssi',
    'chart-check-est-dist-time',
    'chart-check-crlb',
    'range-chart-include-filename',
    'range-remove-bias',
    'range-filter-data',
    'range-signed-distribution',
    'range-show-trendline',
    'range-show-perfect-dist',
    'range-bandwidth-auto'
  ];

  chartCheckboxIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        if (id === 'range-bandwidth-auto') applyAutoBandwidth();
        renderAllSelectedRangeCharts();
      });
    }
  });

  applyAutoBandwidth();

  const filterInputIds = [
    'range-device-input',
    'range-bandwidth-input',
    'range-dist-min',
    'range-dist-max'
  ];

  filterInputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderAllSelectedRangeCharts);
  });

  // Re-render when window resizes
  window.addEventListener('resize', () => {
    const rangeContainer = document.getElementById('range-analysis-container');
    if (rangeContainer && rangeContainer.style.display !== 'none') {
      renderAllSelectedRangeCharts();
    }
  });

  // Check for auto-reload on launch
  setTimeout(async () => {
    const cached = await getWrsFileCache();
    if (cached && cached.content) {
      processWrsFile(cached.filename, cached.content);
    } else {
      renderAllSelectedRangeCharts();
    }
  }, 100);
});

window.renderRangeAnalysisCharts = renderAllSelectedRangeCharts;
