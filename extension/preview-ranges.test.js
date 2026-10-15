'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewLines } = require('./preview');
const range = (start, end) => ({ start: { line: start, character: 0 }, end: { line: end, character: 1 } });
test('file preview includes only reachable ranges with original source line numbers', () => {
  const doc = { getText: () => ['UNRELATED', 'first() {', '}', 'HIDDEN', 'second() {', '}', 'ALSO_HIDDEN'].join('\n') };
  const lines = previewLines(doc, [range(4, 5), range(1, 2)]);
  assert.deepEqual(lines.map(line => line.line), [1, 2, null, 4, 5]);
  assert.doesNotMatch(lines.map(line => line.text).join('\n'), /UNRELATED|HIDDEN/);
});
test('merges overlapping function ranges without duplicated source lines', () => {
  assert.deepEqual(previewLines({ getText: () => 'a\nb\nc\nd' }, [range(0, 2), range(1, 3)]).map(line => line.line), [0, 1, 2, 3]);
});
test('declaration-only file with no reachable bodies has an empty preview', () => {
  assert.deepEqual(previewLines({ getText: () => 'void declaration();' }, []), []);
});
