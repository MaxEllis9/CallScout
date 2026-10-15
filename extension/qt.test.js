'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQt, signalSection, localConnection, createQtResolver } = require('./qt');

test('parses modern overloads, SIGNAL/SLOT macros, context lambdas and automatic connections', () => {
  const text = `// connect(fake, &Fake::signal, fake, &Fake::slot);
    QObject::connect(this, qOverload<int, QString>(&Sender::changed), receiver, &Receiver::update, Qt::QueuedConnection);
    connect(this, SIGNAL(changed(int)), this, SLOT(update(int)));
    connect(this, &Sender::changed, this, [this](int value) { update(value); });
    connect(this, &Sender::changed, [this] { update(); }, Qt::DirectConnection);
    QMetaObject::connectSlotsByName(this);
    void Window::on_button_clicked() { work(); }`;
  const parsed = parseQt(text);
  assert.equal(parsed.connections.length, 4);
  assert.deepEqual(parsed.connections.map(record => record.signal.name), ['changed', 'changed', 'changed', 'changed']);
  assert.equal(parsed.connections[0].signal.owner, 'Sender');
  assert.equal(parsed.connections[0].slot.owner, 'Receiver');
  assert.equal(parsed.connections[1].slot.kind, 'macro');
  assert.equal(parsed.connections[2].slot.kind, 'lambda');
  assert.equal(parsed.connections[3].slot.kind, 'lambda');
  assert.equal(text.slice(parsed.connections[2].slot.offset, parsed.connections[2].slot.end), '[this](int value) { update(value); }');
  assert.equal(parsed.auto.length, 1);
  assert.equal(parsed.automaticSlots[0].name, 'on_button_clicked');
});
test('keeps dynamic QObject registrations explicit instead of inventing endpoints', () => {
  const parsed = parseQt('QObject::connect(sender, signalVariable, receiver, slotVariable);');
  assert.equal(parsed.connections.length, 1);
  assert.equal(parsed.connections[0].signal, null);
  assert.equal(parsed.connections[0].slot, null);
});
test('recognises signal declarations without treating ordinary public methods as signals', () => {
  const text = 'class Sender {\nsignals:\n void changed(int);\npublic slots:\n void update(int);\npublic:\n Q_SIGNAL void ready();\n};\nclass Other { public: void changed(); };';
  assert.equal(signalSection(text, { line: 2, character: 7 }), true);
  assert.equal(signalSection(text, { line: 4, character: 7 }), false);
  assert.equal(signalSection(text, { line: 6, character: 21 }), true);
  assert.equal(signalSection(text, { line: 8, character: 33 }), false);
});
test('only promotes a local straight-line same-object pointer connection', () => {
  const text = 'void Sender::run() { connect(this, &Sender::changed, this, &Sender::update); emit changed(); }';
  const uri = { toString: () => 'file:///sender.cpp' };
  const doc = { offsetAt: position => position.character };
  const info = { uri, caller: { range: { start: { character: 0 } } }, position: { character: text.indexOf('changed();') } };
  const record = { ...parseQt(text).connections[0], uri };
  assert.equal(localConnection(record, info, doc, text), true);
  assert.equal(localConnection({ ...record, receiver: 'other' }, info, doc, text), false);
  assert.equal(localConnection({ ...record, connectionType: 'Qt::QueuedConnection' }, info, doc, text), false);
  assert.equal(localConnection(record, info, doc, text.replace('void ', 'if   ')), false);
});

function fixture(text) {
  const uri = { scheme: 'file', authority: '', path: '/project/sender.cpp', fsPath: '/project/sender.cpp', toString: () => 'file:///project/sender.cpp' };
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  const qtText = 'struct QObject { void connect(); };';
  const qtUri = { ...uri, path: '/project/qobject.h', fsPath: '/project/qobject.h', toString: () => 'file:///project/qobject.h' };
  const qtConnect = { uri: qtUri, range: new Range(new Position(0, qtText.indexOf('connect')), new Position(0, qtText.indexOf('connect') + 7)) };
  const doc = { getText: () => text, offsetAt: p => p.character, positionAt: offset => new Position(0, offset) };
  const signal = { uri, range: new Range(new Position(0, 1), new Position(0, 2)) };
  const body = { uri, name: 'Sender::update', range: new Range(new Position(0, 0), new Position(0, 1)), selectionRange: new Range(new Position(0, 0), new Position(0, 1)) };
  let indexes = 0;
  const vscode = { Position, Range, SymbolKind: { Function: 11 }, workspace: {
    fs: { stat: async () => ({ size: text.length }), readFile: async resource => Buffer.from(resource === qtUri ? qtText : text) },
    findFiles: async () => { indexes++; return [uri]; }
  }, commands: { executeCommand: async (command, resource, position) => {
    if (command === 'vscode.executeWorkspaceSymbolProvider') return [{ name: 'update', location: body }];
    if (text.slice(position.character).startsWith('connect(')) return [qtConnect];
    return text.slice(position.character).startsWith('changed') ? [signal] : [body];
  } } };
  const resolver = { document: async () => doc, functionAt: async (resource, position) => position.character === 0 ? body : undefined, resolve: async item => [item] };
  const cache = {};
  const qt = createQtResolver(vscode, cache, () => true, () => {}, resolver, () => true);
  const caller = { uri, name: 'Sender::run', range: new Range(new Position(0, 0), new Position(0, text.length)), selectionRange: new Range(new Position(0, 5), new Position(0, 8)) };
  return { uri, doc, signal, body, qt, cache, caller, vscode, indexes: () => indexes };
}
test('follows a verified local pointer connection and caches its registration index', async () => {
  const text = 'void Sender::run() { connect(this, &Sender::changed, this, &Sender::update); emit changed(); }';
  const f = fixture(text);
  const info = { caller: f.caller, uri: f.uri, name: 'changed', position: { line: 0, character: text.lastIndexOf('changed') }, locations: [f.signal] };
  const calls = await f.qt.follow(info);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to.name, 'Sender::update');
  assert.equal(calls[0].kind, 'qt');
  assert.equal(f.qt.possibleFor(f.caller).length, 0);
  await f.qt.follow(info);
  assert.equal(f.indexes(), 1);
});
test('keeps runtime/object-identity ambiguity separate from reachable calls', async () => {
  const text = 'void Sender::run() { connect(this, &Sender::changed, other, &Sender::update); emit changed(); }';
  const f = fixture(text);
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'changed', position: { line: 0, character: text.lastIndexOf('changed') }, locations: [f.signal] });
  assert.equal(calls.length, 0);
  assert.equal(f.qt.possibleFor(f.caller).length, 1);
  assert.match(f.qt.possibleFor(f.caller)[0].reason, /identity/);
});
test('does not index a non-Qt workspace while scanning ordinary calls', async () => {
  const f = fixture('void plain() { work(); }');
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'work', position: { line: 0, character: 15 }, locations: [] });
  assert.equal(calls.length, 0);
  assert.equal(f.indexes(), 0);
});
test('legacy string connections remain possible even when a named slot body resolves', async () => {
  const text = 'void Sender::run() { connect(this, SIGNAL(changed(int)), this, SLOT(update(int))); emit changed(1); }';
  const f = fixture(text);
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'changed', position: { line: 0, character: text.lastIndexOf('changed') }, locations: [f.signal] });
  assert.equal(calls.length, 0);
  assert.equal(f.qt.possibleFor(f.caller).length, 1);
  assert.match(f.qt.possibleFor(f.caller)[0].reason, /Legacy/);
});
test('local lambda targets are actual source ranges and can be traversed', async () => {
  const text = 'void Sender::run() { connect(this, &Sender::changed, this, [this] { update(); }); emit changed(); }';
  const f = fixture(text);
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'changed', position: { line: 0, character: text.lastIndexOf('changed') }, locations: [f.signal] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to.name, 'lambda for changed');
  assert.equal(text.slice(calls[0].to.range.start.character, calls[0].to.range.end.character), '[this] { update(); }');
});
test('automatic slots are possible targets with an explicit runtime-object-name warning', async () => {
  const text = 'void Sender::run() { QMetaObject::connectSlotsByName(this); emit changed(); } void Window::on_button_changed() {}';
  const f = fixture(text);
  f.body.name = 'Window::on_button_changed';
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'changed', position: { line: 0, character: text.indexOf('changed();') }, locations: [f.signal] });
  assert.equal(calls.length, 0);
  assert.equal(f.qt.possibleFor(f.caller).length, 1);
  assert.match(f.qt.possibleFor(f.caller)[0].reason, /objectName/);
});
test('a registration inside an uncalled nested lambda is not promoted to a reachable slot', () => {
  const text = 'void Sender::run() { auto setup = [this] { connect(this, &Sender::changed, this, &Sender::update); }; emit changed(); }';
  const uri = { toString: () => 'file:///sender.cpp' };
  const info = { uri, caller: { range: { start: { character: 0 } } }, position: { character: text.lastIndexOf('changed') } };
  assert.equal(localConnection({ ...parseQt(text).connections[0], uri }, info, { offsetAt: p => p.character }, text), false);
});
test('Qt indexing rejects non-local resources before filesystem reads', async () => {
  const text = 'void Sender::run() { emit changed(); }';
  const f = fixture(text);
  f.vscode.workspace.findFiles = async () => [{ scheme: 'https', authority: 'example.com', path: '/remote.cpp' }];
  const read = f.vscode.workspace.fs.readFile;
  f.vscode.workspace.fs.readFile = async uri => {
    assert.equal(uri.scheme, 'file');
    return read(uri);
  };
  const calls = await f.qt.follow({ caller: f.caller, uri: f.uri, name: 'changed',
    position: { line: 0, character: text.indexOf('changed') }, locations: [] });
  assert.equal(calls.length, 0);
  assert.equal(f.qt.possibleFor(f.caller).length, 0);
});
