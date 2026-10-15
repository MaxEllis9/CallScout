'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CallTreeProvider } = require('./call-tree');
const { itemKey } = require('./graph');
const vscode = {
  EventEmitter: class { event = () => {}; fire() {} },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }
};
function item(name, line) {
  return { name, uri: { fsPath: '/project/source.cpp', toString: () => 'file:///project/source.cpp' },
    selectionRange: { start: { line, character: 0 } } };
}
test('retains call occurrence order, filenames and stable distinct IDs without querying a server', () => {
  const tree = new CallTreeProvider(vscode);
  const root = item('entry', 0), a = item('save', 20), b = item('load', 10);
  const calls = new Map([[itemKey(root), [a, b, a].map((to, index) => ({ to,
    callSite: { line: index + 2, character: 4 }, fromUri: root.uri }))]]);
  tree.update(root, calls, 8);
  const parent = tree.getChildren()[0];
  const children = tree.getChildren(parent);
  assert.deepEqual(children.map(child => tree.getTreeItem(child).label), ['1. save', '2. load', '3. save']);
  assert.equal(new Set(children.map(child => child.id)).size, 3);
  const row = tree.getTreeItem(children[0]);
  assert.equal(row.description, 'source.cpp · call L3');
  assert.match(row.tooltip, /Called from \/project\/source.cpp:3/);
  assert.equal(row.command.command, 'callScout.selectCall');
  assert.deepEqual(row.command.arguments, [children[0]]);
  assert.equal(tree.getParent(children[0]), parent);
  assert.equal(row.contextValue, 'callOccurrence');
  tree.update(root, calls, 8);
  assert.deepEqual(tree.getChildren(tree.getChildren()[0]).map(child => child.id), children.map(child => child.id));
  assert.equal(tree.getTreeItem(parent).collapsibleState, 2);
});
test('expands shared callees under each parent and terminates recursion', () => {
  const tree = new CallTreeProvider(vscode);
  const root = item('entry', 0), a = item('a', 10), b = item('b', 20), shared = item('shared', 30);
  tree.update(root, new Map([
    [itemKey(root), [{ to: a }, { to: b }]],
    [itemKey(a), [{ to: shared }]], [itemKey(b), [{ to: shared }]],
    [itemKey(shared), [{ to: root }]]
  ]), 8);
  const branches = tree.getChildren(tree.getChildren()[0]);
  const left = tree.getChildren(branches[0])[0], right = tree.getChildren(branches[1])[0];
  assert.equal(left.key, right.key);
  assert.notEqual(left.id, right.id);
  const recursive = tree.getChildren(left)[0];
  assert.equal(recursive.recursive, true);
  assert.deepEqual(tree.getChildren(recursive), []);
  assert.match(tree.getTreeItem(recursive).description, /recursive/);
  assert.equal(tree.getTreeItem(recursive).collapsibleState, 0);
});
test('honours the depth limit and clears stale results', () => {
  const tree = new CallTreeProvider(vscode), root = item('entry', 0), child = item('child', 1);
  tree.update(root, new Map([[itemKey(root), [{ to: child, kind: 'qt' }]], [itemKey(child), [{ to: root }]]]), 1);
  const leaf = tree.getChildren(tree.getChildren()[0])[0];
  assert.deepEqual(tree.getChildren(leaf), []);
  assert.match(tree.getTreeItem(leaf).description, /depth limit · Qt slot/);
  tree.clear();
  assert.deepEqual(tree.getChildren(), []);
});
