'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(trusted = true) {
  const commands = new Map();
  const documents = new Map();
  let preview;
  let receive;
  const opened = [];
  const events = {};
  const revealed = [];
  let tree;
  const disposable = () => ({ dispose() {} });
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
    DecorationRangeBehavior: { ClosedClosed: 0 },
    EventEmitter: class { event() {} fire() {} },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } contains(p) { return p.character >= this.start.character && p.character <= this.end.character; } isEqual(r) { return this.start.character === r.start.character && this.end.character === r.end.character; } },
    extensions: { all: [] },
    workspace: {
      isTrusted: trusted,
      createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback) => key === 'autoUpdate' ? false : fallback, inspect: () => undefined }),
      getWorkspaceFolder: resource => ({ uri: { fsPath: '/project', path: '/project' } }),
      asRelativePath: resource => resource.toString(),
      openTextDocument: async resource => documents.get(resource.toString()),
      onDidChangeTextDocument: handler => { events.edit = handler; return disposable(); }, onDidChangeConfiguration: disposable
    },
    window: {
      visibleTextEditors: [],
      showTextDocument: async (uri, options) => { opened.push({ uri, options }); },
      createTextEditorDecorationType: disposable,
      showInformationMessage: () => {},
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerTreeDataProvider: disposable,
      createTreeView: (_id, options) => { tree = options.treeDataProvider; return { dispose() {}, reveal: async (element, options) => { revealed.push({ element, options }); } }; },
      registerWebviewViewProvider: (id, provider) => { preview = provider; return disposable(); },
      onDidChangeTextEditorSelection: handler => { events.selection = handler; return disposable(); }, onDidChangeActiveTextEditor: handler => { events.editor = handler; return disposable(); },
      onDidChangeActiveColorTheme: disposable,
      onDidChangeVisibleTextEditors: disposable
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); },
      executeCommand: async id => id === 'callScout.preview.focus' ? undefined : []
    }
  };
  const context = { __dirname, require: id => id === 'vscode' ? vscode : require(id), module: { exports: {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(__dirname + '/main.js', 'utf8') + ';module.exports.setRanges = ranges => { active = ranges; }; module.exports.migrateSettings = migrateSettings; module.exports.pinned = () => pinned; module.exports.timer = () => timer; module.exports.enable = () => { enabled = true; }; module.exports.analyze = analyze;', context);
  context.module.exports.activate({ subscriptions: [] });
  const view = { webview: { onDidReceiveMessage: handler => { receive = handler; return disposable(); } }, onDidDispose() {} };
  preview?.resolveWebviewView(view);
  const resource = name => ({ scheme: 'file', authority: '', fsPath: name, path: name, toString: () => name });
  return { preview, documents, view, resource, commands, events, tree, revealed, pinned: context.module.exports.pinned, timer: context.module.exports.timer, enable: context.module.exports.enable, analyze: context.module.exports.analyze, setRanges: context.module.exports.setRanges, vscode, opened, migrateSettings: context.module.exports.migrateSettings, receive: message => receive(message) };
}
test('previews the entire selected function and excludes neighbouring code', async () => {
  const { preview, documents, view, resource, setRanges } = setup();
  const lines = ['BEFORE', 'void selected() {', ...Array.from({length: 100}, (_, i) => `  work${i}();`), '}', 'AFTER'];
  documents.set('selected.cpp', { getText: () => lines.join('\n') });
  setRanges(new Map([['selected.cpp', [{ start: { line: 1, character: 0 }, end: { line: 102, character: 1 } }]]]));
  await preview.show(resource('selected.cpp'), { line: 1, character: 5 }, { start: { line: 1, character: 0 }, end: { line: 102, character: 1 } });
  assert.match(view.webview.html, /work99/);
  assert.doesNotMatch(view.webview.html, /BEFORE|AFTER/);
});
test('a slow earlier preview cannot overwrite a newer selection', async () => {
  const { preview, documents, view, resource, setRanges } = setup();
  let finish;
  documents.set('old.cpp', new Promise(resolve => { finish = resolve; }));
  documents.set('new.cpp', { getText: () => 'NEW_SELECTION' });
  setRanges(new Map(['old.cpp', 'new.cpp'].map(key => [key, [{ start: { line: 0, character: 0 }, end: { line: 0, character: 100 } }]])));
  const older = preview.show(resource('old.cpp'));
  await preview.show(resource('new.cpp'));
  finish({ getText: () => 'OLD_SELECTION' });
  await older;
  assert.match(view.webview.html, /NEW_SELECTION/);
  assert.doesNotMatch(view.webview.html, /OLD_SELECTION/);
});
test('escapes source markup and restricts scripts to the navigation nonce', async () => {
  const { preview, documents, view, resource, setRanges } = setup();
  documents.set('safe.cpp', { getText: () => '<script>alert(1)</script><img src="https://example.com/leak">' });
  setRanges(new Map([['safe.cpp', [{ start: { line: 0, character: 0 }, end: { line: 0, character: 100 } }]]]));
  await preview.show(resource('safe.cpp'));
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.webview.options.enableCommandUris, false);
  assert.equal(view.webview.options.localResourceRoots.length, 0);
  assert.match(view.webview.html, /script-src 'nonce-[A-Za-z0-9+/]+'/);
  assert.match(view.webview.html, /<script nonce="[A-Za-z0-9+/]+"/);
  assert.match(view.webview.html, /default-src 'none'/);
  assert.doesNotMatch(view.webview.html, /<script>|<img/);
  assert.match(view.webview.html, /&lt;script&gt;/);
});
test('bounds large previews and rejects network resources before opening', async () => {
  const { preview, documents, view, resource, setRanges } = setup();
  documents.set('large.cpp', { getText: () => Array(3000).fill('line').join('\n') });
  setRanges(new Map([['large.cpp', [{ start: { line: 0, character: 0 }, end: { line: 2999, character: 4 } }]]]));
  await preview.show(resource('large.cpp'));
  assert.match(view.webview.html, /Preview limited/);
  const before = view.webview.html;
  await preview.show({ scheme: 'https', authority: 'example.com' });
  assert.equal(view.webview.html, before);
});
test('selecting a file renders only reachable definitions rather than the whole document', async () => {
  const { preview, documents, view, resource, setRanges } = setup();
  documents.set('mixed.cpp', { getText: () => 'UNREACHABLE\nvoid first() {}\nHIDDEN\nvoid second() {}\nALSO_HIDDEN' });
  setRanges(new Map([['mixed.cpp', [
    { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
    { start: { line: 3, character: 0 }, end: { line: 3, character: 16 } }
  ]]]));
  await preview.show(resource('mixed.cpp'));
  assert.match(view.webview.html, /first/);
  assert.match(view.webview.html, /second/);
  assert.match(view.webview.html, /omitted unreachable code/);
  assert.doesNotMatch(view.webview.html, /UNREACHABLE|HIDDEN/);
});
function navigationFixture() {
  const f = setup();
  const lines = ['HIDDEN', 'void run() {', '  target();', '}'];
  const doc = { version: 1, getText: () => lines.join('\n'), lineAt: line => ({ text: lines[line] }) };
  f.documents.set('source.cpp', doc);
  f.setRanges(new Map([['source.cpp', [{ start: { line: 1, character: 0 }, end: { line: 3, character: 1 } }]]]));
  return { ...f, doc };
}
test('definition navigation resolves the clicked original source position and opens its target', async () => {
  const f = navigationFixture();
  const calls = [];
  const target = { uri: f.resource('target.cpp'), range: { start: { line: 8, character: 2 }, end: { line: 8, character: 8 } } };
  f.vscode.commands.executeCommand = async (command, uri, position) => { calls.push({ command, uri, position }); return [target]; };
  await f.preview.show(f.resource('source.cpp'));
  await f.receive({ type: 'definition', request: f.preview.request, line: 2, character: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'vscode.executeDefinitionProvider');
  assert.equal(calls[0].uri.toString(), 'source.cpp');
  assert.equal(calls[0].position.line, 2);
  assert.equal(calls[0].position.character, 3);
  assert.equal(f.opened[0].uri.toString(), 'target.cpp');
  assert.equal(f.opened[0].options.selection.start.line, 8);
});
test('rejects stale, hidden-line, invalid-coordinate and arbitrary-command navigation requests', async () => {
  const f = navigationFixture();
  let queries = 0;
  f.vscode.commands.executeCommand = async () => { queries++; return []; };
  await f.preview.show(f.resource('source.cpp'));
  const good = { type: 'definition', request: f.preview.request, line: 2, character: 3 };
  for (const message of [
    { ...good, request: good.request - 1 }, { ...good, line: 0 }, { ...good, line: 9000 },
    { ...good, character: -1 }, { ...good, character: 999 }, { ...good, character: 1.5 },
    { ...good, type: 'executeCommand', command: 'workbench.action.terminal.new' }
  ]) await f.receive(message);
  f.doc.version = 2;
  await f.receive(good);
  assert.equal(queries, 0);
  assert.equal(f.opened.length, 0);
});
test('rejects non-local definition destinations returned by a language provider', async () => {
  const f = navigationFixture();
  f.vscode.commands.executeCommand = async () => [{ uri: { scheme: 'https', authority: 'example.com' }, range: { start: { line: 0, character: 0 } } }];
  await f.preview.show(f.resource('source.cpp'));
  await f.receive({ type: 'definition', request: f.preview.request, line: 2, character: 3 });
  assert.equal(f.opened.length, 0);
});
test('preview script only sends navigation on Cmd/Ctrl clicks and preserves UTF-16 source offsets', () => {
  const handlers = {}, messages = [];
  const source = { contains: () => true, parentElement: { dataset: { sourceLine: '45' } } };
  const document = { currentScript: { dataset: { request: '7' } }, querySelector: () => ({ classList: { toggle() {}, remove() {} } }),
    addEventListener: (name, callback) => { handlers[name] = callback; },
    caretRangeFromPoint: () => ({ startContainer: {}, startOffset: 12 }),
    createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => '  target' }) };
  vm.runInNewContext(fs.readFileSync(__dirname + '/../resources/preview.js', 'utf8'), { document, window: { addEventListener() {} }, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }) });
  const event = { button: 0, ctrlKey: false, metaKey: false, target: { closest: selector => selector === '.source' ? source : null }, preventDefault() {}, clientX: 10, clientY: 10 };
  handlers.click(event);
  assert.equal(messages.length, 0);
  handlers.click({ ...event, metaKey: true });
  handlers.click({ ...event, ctrlKey: true });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].line, 45);
  assert.equal(messages[0].character, 8);
  assert.equal(messages[0].request, 7);
});
test('rebranding migrates configured settings at each scope and preserves explicit new values', async () => {
  const f = setup();
  const values = new Map([
    ['reachabilityLens:1:dimOpacity', 0.7], ['callScout:1:dimOpacity', 0.8],
    ['reachabilityLens:2:maxDepth', 5], ['reachabilityLens:3:debounceMs', 200]
  ]);
  f.vscode.workspace.workspaceFolders = [{ uri: f.resource('project') }];
  f.vscode.workspace.getConfiguration = section => ({
    inspect: key => ({ globalValue: values.get(`${section}:1:${key}`), workspaceValue: values.get(`${section}:2:${key}`), workspaceFolderValue: values.get(`${section}:3:${key}`) }),
    update: async (key, value, target) => { const id = `${section}:${target}:${key}`; if (value === undefined) values.delete(id); else values.set(id, value); }
  });
  await f.migrateSettings();
  assert.equal(values.get('callScout:1:dimOpacity'), 0.8);
  assert.equal(values.get('callScout:2:maxDepth'), 5);
  assert.equal(values.get('callScout:3:debounceMs'), 200);
  assert.equal([...values.keys()].some(key => key.startsWith('reachabilityLens:')), false);
});
test('breadcrumbs preserve the selected branch, escape labels and reject stale or arbitrary destinations', async () => {
  const f = setup();
  const uri = f.resource('code.cpp');
  f.documents.set('code.cpp', { getText: () => 'void entry() {}' });
  f.setRanges(new Map([['code.cpp', [{ start: { line: 0, character: 0 }, end: { line: 0, character: 15 } }]]]));
  const root = { item: { name: '<entry>', uri, selectionRange: { start: { line: 0, character: 5 } } } };
  const child = { item: { name: 'child', uri, selectionRange: { start: { line: 0, character: 8 } } }, parent: root };
  await f.commands.get('callScout.selectCall')(child);
  assert.match(f.view.webview.html, /aria-label="Call path"/);
  assert.match(f.view.webview.html, /&lt;entry&gt;/);
  assert.match(f.view.webview.html, /data-step="1" aria-current="location"/);
  assert.equal(f.revealed[0].element, child);
  const selected = [];
  f.vscode.commands.executeCommand = async (id, element) => { if (id === 'callScout.selectCall') selected.push(element); };
  const request = f.preview.request;
  for (const message of [
    { request: request - 1, index: 0 }, { request, index: -1 }, { request, index: 99 },
    { request, index: '0' }, { request, uri: 'file:///other.cpp' }
  ]) await f.preview.navigate({ type: 'breadcrumb', ...message });
  assert.equal(selected.length, 0);
  await f.preview.navigate({ type: 'breadcrumb', request, index: 0 });
  assert.deepEqual(selected, [root]);
  await f.preview.show(uri);
  await f.preview.navigate({ type: 'breadcrumb', request, index: 1 });
  assert.equal(selected.length, 1);
});
test('pinning preserves the root across navigation and tracks source insertions', async () => {
  const f = setup(), uri = f.resource('root.cpp');
  let text = 'void entry() {}';
  const document = { uri, languageId: 'cpp', getText: () => text, offsetAt: p => p.character,
    positionAt: character => ({ line: 0, character }) };
  f.documents.set('root.cpp', document);
  const item = { uri, name: 'entry', selectionRange: { start: { line: 0, character: 5 } } };
  f.tree.update(item, new Map(), 8);
  await f.commands.get('callScout.pinRoot')();
  f.enable();
  f.vscode.window.activeTextEditor = { document: { uri: f.resource('other.cpp'), languageId: 'cpp' } };
  f.events.selection({ textEditor: f.vscode.window.activeTextEditor });
  f.events.editor(f.vscode.window.activeTextEditor);
  assert.equal(f.timer(), undefined);
  text = '// added\n' + text;
  f.events.edit({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '// added\n' }] });
  assert.equal(f.pinned().offset, 14);
  assert.equal(f.pinned().uri, uri);
  const range = new f.vscode.Range({ line: 0, character: 9 }, { line: 0, character: text.length });
  const selectionRange = new f.vscode.Range({ line: 0, character: 14 }, { line: 0, character: 19 });
  let symbolRequests = 0;
  f.vscode.commands.executeCommand = async (id, resource) => {
    if (id === 'vscode.executeDocumentSymbolProvider') {
      symbolRequests++;
      assert.equal(resource, uri);
      return [{ name: 'entry', kind: f.vscode.SymbolKind.Function, range, selectionRange }];
    }
    return [];
  };
  await f.analyze({ force: true });
  assert.equal(symbolRequests, 1);
  assert.equal(f.tree.root.uri, uri);
  assert.equal(f.tree.root.name, 'entry');
  f.events.edit({ document, contentChanges: [{ rangeOffset: 14, rangeLength: 5, text: 'renamed' }] });
  assert.equal(f.pinned(), null, 'Replacing the pinned identifier must not silently select another function');
  await f.commands.get('callScout.unpinRoot')();
  assert.equal(f.pinned(), null);
  assert.ok(f.timer());
  f.commands.get('callScout.clear')();
});
test('call-site action uses the original caller position and rejects non-local resources', async () => {
  const f = setup(), calls = [];
  f.vscode.commands.executeCommand = async (...args) => calls.push(args);
  const uri = f.resource('caller.cpp'), position = { line: 20, character: 4 };
  await f.commands.get('callScout.openCallSite')({ fromUri: uri, callSite: position });
  await f.commands.get('callScout.openCallSite')({ fromUri: { scheme: 'https' }, callSite: position });
  await f.commands.get('callScout.openCallSite')({});
  assert.deepEqual(calls, [['callScout.openLocation', uri, position]]);
});
test('restricted workspaces register no analysis commands or views', () => {
  const f = setup(false);
  assert.equal(f.commands.size, 0);
  assert.equal(f.tree, undefined);
  assert.equal(f.preview, undefined);
  assert.equal(f.documents.size, 0);
});
