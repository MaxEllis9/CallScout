'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callOffsets } = require('./calls');
test('finds member, chained, qualified and template calls while excluding comments and literals', () => {
  const source = `obj.save(); ptr->load(); ns::run<int>(); get().finish();
    // fake();
    /* ignored(); */ const char *s = "bad()"; auto raw = R"tag(falseCall())tag";
    if (ready()) work(); sizeof(value); static_cast<int>(count);`;
  assert.deepEqual(callOffsets(source).map(i => source.slice(i).match(/^\w+/)[0]),
    ['save', 'load', 'run', 'get', 'finish', 'ready', 'work']);
});
test('keeps offsets for escaped strings and preprocessor macros', () => {
  const source = '#define CALL fake()\\\n alsoFake()\n"escaped\\\"call()"; real();';
  assert.deepEqual(callOffsets(source), [source.indexOf('real')]);
});
test('unfinished block comments and raw strings consume the rest without exposing false calls', () => {
  for (const suffix of ['/*a'.repeat(40000), 'R"x('.repeat(40000)]) {
    const source = 'real(); ' + suffix + ' fake();';
    assert.deepEqual(callOffsets(source), [0]);
  }
});
test('accepts macOS and Windows local paths and rejects network/remote resources', () => {
  const { isLocalFile } = require('./calls');
  assert.equal(isLocalFile({ scheme: 'file', authority: '', fsPath: '/Users/dev/project/a.cpp' }), true);
  assert.equal(isLocalFile({ scheme: 'file', authority: '', fsPath: 'C:\\Work\\a.cpp' }), true);
  for (const resource of [
    { scheme: 'https', authority: 'example.com', fsPath: '/a.cpp' },
    { scheme: 'vscode-remote', authority: 'ssh-remote+work', fsPath: '/a.cpp' },
    { scheme: 'file', authority: 'server', fsPath: '\\\\server\\share\\a.cpp' },
    { scheme: 'file', authority: '', fsPath: '\\\\server\\share\\a.cpp' }
  ]) assert.equal(isLocalFile(resource), false);
});
test('concurrent lookups keep source order and repeated calls, and reuse the scan', async () => {
  const { createCallResolver } = require('./calls');
  const uri = { scheme: 'file', authority: '', fsPath: '/project/test.cpp', toString: () => 'file:///project/test.cpp' };
  const source = 'void entry() { first(); second(); first(); }';
  const root = { name: 'entry', uri, selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: source.length } } };
  const targets = Object.fromEntries(['first', 'second'].map((name, i) => [name,
    { name, uri, selectionRange: { start: { line: i + 1, character: 0 } } }]));
  let requests = 0;
  const finished = [];
  const vscode = {
    SymbolKind: { Function: 1, Method: 2, Constructor: 3 },
    workspace: { openTextDocument: async () => ({ getText: () => source,
      offsetAt: position => position.character, positionAt: character => ({ line: 0, character }) }) },
    commands: { executeCommand: async (_command, _uri, position) => {
      requests++;
      await new Promise(resolve => setTimeout(resolve, position.character === source.indexOf('first') ? 30 : 0));
      finished.push(position.character);
      return [];
    } }
  };
  const resolver = createCallResolver(vscode, () => true, () => {}, {}, () => true,
    async ({ name }) => [{ to: targets[name] }]);
  const calls = await resolver.outgoing(root);
  assert.deepEqual(calls.map(call => call.to.name), ['first', 'second', 'first']);
  assert.deepEqual(calls.map(call => call.callSite.character), [source.indexOf('first'), source.indexOf('second'), source.lastIndexOf('first')]);
  assert.notEqual(finished[0], source.indexOf('first'));
  assert.equal(await resolver.outgoing(root), calls);
  assert.equal(requests, 3);
});
