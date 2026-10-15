'use strict';

// Only include discovered function ranges, preserving source line numbers.
function previewLines(document, ranges) {
  const text = document.getText().split(/\r?\n/);
  const intervals = ranges.map(range => [range.start.line, range.end.line + (range.end.character > 0 ? 1 : 0)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  const lines = [];
  let characters = 0;
  for (const [start, end] of merged) {
    if (lines.length) lines.push({ line: null, text: '' });
    for (let line = start; line < Math.min(end, text.length); line++) {
      characters += text[line].length;
      if (lines.length >= 2000 || characters > 256 * 1024) { lines.truncated = true; return lines; }
      lines.push({ line, text: text[line] });
    }
  }
  return lines;
}
module.exports = { previewLines };
