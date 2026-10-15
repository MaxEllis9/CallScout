'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { walkOutgoing } = require('./graph');
function item(name) { return { name, uri: { toString: () => 'file:///test.cpp' }, range: { start: { line: name.charCodeAt(0), character: 0 } } }; }
test('walks recursively and handles cycles', async () => {
  const a = item('a'), b = item('b'), c = item('c');
  const graph = { a: [b], b: [c], c: [a] };
  const result = await walkOutgoing(a, async n => graph[n.name].map(to => ({to})), 10, 100);
  assert.deepEqual(result.nodes.map(n => n.item.name), ['a', 'b', 'c']);
  assert.deepEqual(result.nodes.map(n => n.depth), [0, 1, 2]);
});
test('respects depth', async () => {
  const a = item('a'), b = item('b');
  const result = await walkOutgoing(a, async () => [{to:b}], 0, 100);
  assert.equal(result.nodes.length, 1);
});
test('enforces traversal limits even for invalid settings', async () => {
  const a = item('a');
  let queries = 0;
  const shallow = await walkOutgoing(a, async () => { queries++; return []; }, -10, Infinity);
  assert.equal(shallow.nodes.length, 1);
  assert.equal(queries, 0);
  const limited = await walkOutgoing(a, async n => [{ to: item(String.fromCharCode(n.name.charCodeAt(0) + 1)) }], 8, -2);
  assert.equal(limited.nodes.length, 1);
  assert.equal(limited.truncated, true);
});
test('reports provider errors without crashing', async () => {
  const result = await walkOutgoing(item('a'), async () => {throw Error('provider failed');}, 3, 100);
  assert.equal(result.errors.length, 1);
});

test('publishes each visited node before awaiting its outgoing scan', async () => {
  const a = item('a'), b = item('b');
  const published = [];
  const result = await walkOutgoing(a, async node => {
    assert.ok(published.includes(node.name));
    return node === a ? [{ to: b }] : [];
  }, 2, 10, async node => { published.push(node.item.name); });
  assert.deepEqual(published, ['a', 'b']);
  assert.equal(result.nodes.length, 2);
});
test('keeps shared and recursive edges while scanning every function only once', async () => {
  const a = item('a'), b = item('b'), c = item('c'), d = item('d');
  const graph = { a: [b, c], b: [d], c: [d], d: [a] };
  let queries = 0;
  const published = [];
  const result = await walkOutgoing(a, async node => { queries++; return graph[node.name].map(to => ({ to })); }, 10, 100,
    async () => {}, (caller, calls) => published.push([caller.name, calls.map(call => call.to.name)]));
  assert.equal(queries, 4);
  assert.equal(result.nodes.length, 4);
  assert.equal(published.reduce((sum, row) => sum + row[1].length, 0), 5);
  assert.deepEqual(published, [['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', ['a']]]);
});
