'use strict';

/**
 * Simple CSV helpers for agent tools (no external deps).
 */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      /* skip */
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function escapeCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return (rows || [])
    .map((r) => (Array.isArray(r) ? r : [r]).map(escapeCell).join(','))
    .join('\n');
}

function rowsToObjects(rows) {
  if (!rows || !rows.length) return [];
  const headers = rows[0].map((h, i) => String(h || 'col' + (i + 1)).trim() || 'col' + (i + 1));
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = r[i] != null ? r[i] : '';
    });
    return o;
  });
}

function csvRead(content, params) {
  const p = params || {};
  const rows = parseCsv(content);
  const asObjects = p.as_objects !== false;
  const limit = Math.min(Number(p.limit) || 200, 2000);
  if (asObjects) {
    const objects = rowsToObjects(rows).slice(0, limit);
    return {
      ok: true,
      tool: 'csv_read',
      headers: rows[0] || [],
      rows: objects,
      rowCount: Math.max(0, rows.length - 1),
      truncated: rows.length - 1 > limit,
    };
  }
  return {
    ok: true,
    tool: 'csv_read',
    rows: rows.slice(0, limit + 1),
    rowCount: rows.length,
    truncated: rows.length > limit + 1,
  };
}

function csvWrite(rowsOrObjects, params) {
  const p = params || {};
  let rows = rowsOrObjects;
  if (rows && !Array.isArray(rows) && typeof rows === 'object' && rows.rows) {
    rows = rows.rows;
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'rows array required' };
  }
  if (rows.length && !Array.isArray(rows[0]) && typeof rows[0] === 'object') {
    const headers =
      (p.headers && Array.isArray(p.headers) && p.headers.length
        ? p.headers
        : Object.keys(rows[0])) || [];
    const matrix = [headers].concat(
      rows.map((o) => headers.map((h) => (o && o[h] != null ? o[h] : ''))),
    );
    return { ok: true, tool: 'csv_write', content: toCsv(matrix), rowCount: rows.length };
  }
  return {
    ok: true,
    tool: 'csv_write',
    content: toCsv(rows),
    rowCount: rows.length,
  };
}

function csvQuery(content, params) {
  const p = params || {};
  const read = csvRead(content, { as_objects: true, limit: 5000 });
  if (!read.ok) return read;
  let rows = read.rows || [];
  const column = p.column || p.col;
  const value = p.value != null ? String(p.value) : null;
  const contains = p.contains != null ? String(p.contains).toLowerCase() : null;
  if (column && value != null) {
    rows = rows.filter((r) => String(r[column]) === value);
  } else if (column && contains != null) {
    rows = rows.filter((r) =>
      String(r[column] || '')
        .toLowerCase()
        .includes(contains),
    );
  } else if (p.where && typeof p.where === 'object') {
    rows = rows.filter((r) =>
      Object.entries(p.where).every(([k, v]) => String(r[k]) === String(v)),
    );
  }
  const limit = Math.min(Number(p.limit) || 100, 1000);
  return {
    ok: true,
    tool: 'csv_query',
    headers: read.headers,
    rows: rows.slice(0, limit),
    matchCount: rows.length,
    truncated: rows.length > limit,
  };
}

module.exports = { parseCsv, toCsv, csvRead, csvWrite, csvQuery, rowsToObjects };
