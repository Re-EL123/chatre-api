'use strict';

/**
 * Server-side unified diff helpers.
 */

function unifiedDiff(previous, current, path) {
  const aLines = String(previous == null ? '' : previous).split('\n');
  const bLines = String(current == null ? '' : current).split('\n');
  const label = path || 'file';
  const out = ['--- a/' + label.replace(/^\//, ''), '+++ b/' + label.replace(/^\//, '')];

  // Myers-lite: LCS hunks for reasonable file sizes; fall back to line scan.
  if (aLines.length + bLines.length > 4000) {
    return simpleLineDiff(aLines, bLines, out);
  }
  return lcsDiff(aLines, bLines, out);
}

function simpleLineDiff(aLines, bLines, out) {
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    const left = aLines[i];
    const right = bLines[i];
    if (left === right) {
      if (left !== undefined) out.push(' ' + left);
    } else {
      if (left !== undefined) out.push('-' + left);
      if (right !== undefined) out.push('+' + right);
    }
  }
  return out.join('\n');
}

function lcsDiff(aLines, bLines, out) {
  const n = aLines.length;
  const m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push(' ' + aLines[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('-' + aLines[i]);
      i += 1;
    } else {
      out.push('+' + bLines[j]);
      j += 1;
    }
  }
  while (i < n) {
    out.push('-' + aLines[i]);
    i += 1;
  }
  while (j < m) {
    out.push('+' + bLines[j]);
    j += 1;
  }
  return out.join('\n');
}

module.exports = { unifiedDiff };
