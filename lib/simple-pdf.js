'use strict';

/**
 * Minimal Latin-text PDF builder (no native deps).
 * Enough for agent create_pdf deliverables.
 */

function escapePdfText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLines(text, maxChars) {
  const lines = [];
  String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines.push('');
        return;
      }
      let cur = '';
      words.forEach((w) => {
        const next = cur ? cur + ' ' + w : w;
        if (next.length > maxChars && cur) {
          lines.push(cur);
          cur = w;
        } else {
          cur = next;
        }
      });
      if (cur) lines.push(cur);
    });
  return lines;
}

/**
 * @param {{ title?: string, content?: string }} opts
 * @returns {Buffer}
 */
function buildSimplePdf(opts) {
  const title = String((opts && opts.title) || 'Document').slice(0, 180);
  const body = String((opts && opts.content) || '');
  const lines = [title, ''].concat(wrapLines(body, 90)).slice(0, 220);

  // Helvetica 11pt ≈ 14 leading; start near top of letter page.
  let y = 750;
  const contentLines = ['BT', '/F1 14 Tf', '50 ' + y + ' Td', '16 TL'];
  lines.forEach((line, idx) => {
    const t = escapePdfText(line);
    if (idx === 0) {
      contentLines.push('/F1 18 Tf', '(' + t + ') Tj', '/F1 11 Tf', 'T*');
    } else {
      contentLines.push('(' + t + ') Tj', 'T*');
    }
  });
  contentLines.push('ET');
  const stream = contentLines.join('\n');

  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push(
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n',
  );
  objects.push(
    '4 0 obj<< /Length ' +
      Buffer.byteLength(stream, 'utf8') +
      ' >>stream\n' +
      stream +
      '\nendstream\nendobj\n',
  );
  objects.push(
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
  );

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  });
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf +=
    'trailer<< /Size ' +
    (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' +
    xrefPos +
    '\n%%EOF';
  return Buffer.from(pdf, 'utf8');
}

module.exports = { buildSimplePdf };
