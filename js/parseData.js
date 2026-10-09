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
 * Parses raw CSV log content containing RTT ranging and PDR measurements.
 *
 * <p>
 * Extracts header metadata, configuration parameters, measurement records,
 * and ground truth rows from the CSV string.
 * </p>
 *
 * @param {string} csvContent The raw CSV text content to parse.
 * @return {!Object} An object containing headers, params, data, gtData, and
 *     targetData arrays.
 */
function parseCsvData(csvContent) {
  const lines = csvContent.split('\n').filter(line => line.trim() !== '');
  if (lines.length === 0) {
    return { headers: [], params: {}, data: [], gtData: [] };
  }

  const headerLine = lines.find(line => line.startsWith('#flabel'));
  if (!headerLine) {
    console.error("Header line starting with #flabel not found.");
    return { headers: [], params: {}, data: [], gtData: [] };
  }

  const headers = headerLine.substring(1).split(',').map(h => h.trim());
  const data = [];
  const gtData = [];
  const targetData = [];
  const params = {};

  const columnParsers = {
    'flabel': val => val,
    'Time(ms)': val => parseInt(val, 10),
    'GtNum(int)': val => parseInt(val, 10),
    'findState(int)': val => parseInt(val, 10),
    'Steps(int)': val => parseInt(val, 10),
    'phoneAngle(deg)': val => parseFloat(val),
    'RSSI': val => parseFloat(val),
    'Range(m)': val => parseFloat(val),
    'RangeStdDev(m)': val => parseFloat(val),
    'SuccessRatio': val => parseFloat(val),
    'Sided': val => isNaN(parseInt(val, 10)) ? val : parseInt(val, 10),
    'PdrX(m)': val => parseFloat(val),
    'PdrY(m)': val => parseFloat(val),
    'TargetX(m)': val => parseFloat(val),
    'TargetY(m)': val => parseFloat(val),
    'TargetErr(m)': val => parseFloat(val),
    'Direction(deg)': val => parseFloat(val),
    'DirectionErr(deg)': val => parseFloat(val)
  };

  for (const line of lines) {
    if (line.startsWith('#flabel')) continue; // Already processed
    if (line.startsWith('#')) {
      continue; // Other comments
    }
    if (line.startsWith('PARAM')) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        const paramName = parts[1].trim();
        const paramVal = parts[2].trim();
        const numVal = parseFloat(paramVal);
        params[paramName] = isNaN(numVal) ? paramVal : numVal;
      }
      continue;
    }

    const values = line.split(',');
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((header, index) => {
        const rawVal = values[index].trim();
        if (columnParsers[header]) {
          row[header] = columnParsers[header](rawVal);
        } else {
          const numVal = parseFloat(rawVal);
          row[header] = isNaN(numVal) ? rawVal : numVal;
        }
      });

      if (row['flabel'] !== 'FIND1' && row['flabel'] !== 'GT') {
        continue; // Only process FIND1 and GT records
      }

      if ('PdrX(m)' in row && 'PdrY(m)' in row) {
        const pdrX = row['PdrX(m)'];
        const pdrY = row['PdrY(m)'];
        if ((!isNaN(pdrX) && Math.abs(pdrX) > 100) || (!isNaN(pdrY) && Math.abs(pdrY) > 100)) {
          continue; // Ignore record completely
        }
      }

      if ('TargetX(m)' in row && 'TargetY(m)' in row) {
        const targetX = row['TargetX(m)'];
        const targetY = row['TargetY(m)'];
        if ((!isNaN(targetX) && Math.abs(targetX) > 100) || (!isNaN(targetY) && Math.abs(targetY) > 100)) {
          continue; // Ignore record completely
        }
        if (row['flabel'] === 'FIND1' && !isNaN(targetX) && !isNaN(targetY)) {
          targetData.push({
            'Time(ms)': row['Time(ms)'],
            'Steps(int)': row['Steps(int)'],
            'TargetErr(m)': row['TargetErr(m)'],
            x: targetX,
            y: targetY
          });
        }
      }

      if (row['flabel'] === 'GT') {
        gtData.push(row);
      } else if (row['flabel'] === 'FIND1') {
        data.push(row);
      }
    }
  }  return { headers, params, data, gtData, targetData };
}

/**
 * Parses a CSV string containing ground truth marker coordinates.
 *
 * <p>
 * Reads GT lines with format GT,gtNum,x,y and returns a map keyed by
 * ground truth marker ID.
 * </p>
 *
 * @param {string} csvContent The raw CSV text containing GT coordinates.
 * @return {!Object<number, {x: number, y: number}>} Mapping from GT number to
 *     coordinate object.
 */
function parseGtCoordsData(csvContent) {
  const lines = csvContent.split('\n').filter(line => line.trim() !== '');
  const gtCoords = {}; // map from Gt-Num to {x, y}

  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const parts = line.split(',').map(p => p.trim());
    if (parts.length >= 4 && parts[0] === 'GT') {
      const gtNum = parseInt(parts[1], 10);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      if (!isNaN(gtNum) && !isNaN(x) && !isNaN(y)) {
        gtCoords[gtNum] = { x, y };
      }
    }
  }
  return gtCoords;
}

/**
 * Associates parsed ground truth coordinates with measurement records.
 *
 * <p>
 * Assigns known coordinates to GT markers and interpolates positions for
 * intermediate measurement timestamps assuming constant speed between anchors.
 * </p>
 *
 * @param {!Object} parsedData Parsed measurement dataset containing data and
 *     gtData.
 * @param {!Object<number, {x: number, y: number}>} gtCoords Coordinate mapping
 *     keyed by ground truth marker number.
 */
function matchGtCoords(parsedData, gtCoords) {
  if (!parsedData || !parsedData.gtData || !gtCoords) return;

  // 1. Match known GT coords with gtData
  for (const row of parsedData.gtData) {
    const gtNum = row['GtNum(int)'];
    if (gtNum !== undefined && gtCoords[gtNum]) {
      row['TargetX(m)'] = gtCoords[gtNum].x;
      row['TargetY(m)'] = gtCoords[gtNum].y;
      row.x = gtCoords[gtNum].x;
      row.y = gtCoords[gtNum].y;
    }
  }

  // 2. Create gtInterpolated array
  parsedData.gtInterpolated = [];
  const find1Data = parsedData.data || [];
  const validGtPoints = parsedData.gtData.filter(row => row.x !== undefined && row.y !== undefined && !isNaN(row['Time(ms)']));
  validGtPoints.sort((a, b) => a['Time(ms)'] - b['Time(ms)']);

  if (find1Data.length === 0 || validGtPoints.length < 2) {
    return;
  }

  // Find closest FIND1 record for each valid GT point
  const anchorPoints = validGtPoints.map(gt => {
    const targetTime = gt['Time(ms)'];
    let closestRecord = find1Data[0];
    let minDiff = Math.abs(closestRecord['Time(ms)'] - targetTime);
    for (let i = 1; i < find1Data.length; i++) {
      const diff = Math.abs(find1Data[i]['Time(ms)'] - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestRecord = find1Data[i];
      }
    }
    return {
      gtNum: gt['GtNum(int)'],
      gtTime: targetTime,
      find1Time: closestRecord['Time(ms)'],
      x: gt.x,
      y: gt.y
    };
  });
  anchorPoints.sort((a, b) => a.find1Time - b.find1Time);

  // Interpolate FIND1 timestamps between anchor points assuming constant
  // walking speed.
  const gtInterpolated = [];

  for (let i = 0; i < anchorPoints.length - 1; i++) {
    const pA = anchorPoints[i];
    const pB = anchorPoints[i + 1];
    const tA = pA.find1Time;
    const tB = pB.find1Time;

    if (tB <= tA) continue;

    // Filter FIND1 records that fall in the current interval [tA, tB].
    // To avoid duplicate boundary points between consecutive intervals, we
    // use tA <= t < tB for i < anchorPoints.length - 2, and tA <= t <= tB for
    // the final interval.
    const isLastInterval = (i === anchorPoints.length - 2);
    const recordsInInterval = find1Data.filter(r => {
      const t = r['Time(ms)'];
      return isLastInterval ? (t >= tA && t <= tB) : (t >= tA && t < tB);
    });

    recordsInInterval.forEach(r => {
      const t = r['Time(ms)'];
      const ratio = (t - tA) / (tB - tA);
      const xInterp = pA.x + ratio * (pB.x - pA.x);
      const yInterp = pA.y + ratio * (pB.y - pA.y);
      const isDefinedGt = (t === tA) || (isLastInterval && t === tB);
      gtInterpolated.push({
        'Time(ms)': t,
        'Steps(int)': r['Steps(int)'],
        'TargetX(m)': xInterp,
        'TargetY(m)': yInterp,
        x: xInterp,
        y: yInterp,
        isDefinedGt: isDefinedGt
      });
    });
  }

  parsedData.gtInterpolated = gtInterpolated;
}
