'use strict';
// Integration check against an actual clangd process, without a VS Code window.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createCallResolver } = require(process.env.RESOLVER_PATH || './calls');
const { walkOutgoing } = require('./graph');
const { createQtResolver } = require('./qt');
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  contains(p) { return (p.line > this.start.line || p.line === this.start.line && p.character >= this.start.character) && (p.line < this.end.line || p.line === this.end.line && p.character <= this.end.character); }
}
const uri = value => ({ scheme: 'file', authority: '', path: new URL(value).pathname, toString: () => value, fsPath: fileURLToPath(value) });
function convert(value) {
  if (Array.isArray(value)) return value.map(convert);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, data] of Object.entries(value)) {
    out[key] = key === 'kind' ? data - 1 : key === 'uri' || key === 'targetUri' ? uri(data)
      : /Range$/.test(key) || key === 'range' ? new Range(data.start, data.end) : convert(data);
  }
  return out;
}
const rootDir = process.argv[2];
const source = process.argv[3] || path.join(rootDir, 'main.cpp');
const rootName = process.argv[4] || 'entry';
const server = spawn('/usr/bin/clangd', ['--background-index', `--compile-commands-dir=${process.argv[5] || rootDir}`]);
server.stderr.on('data', () => {});
let bytes = Buffer.alloc(0), nextId = 0;
const pending = new Map();
function send(message) {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
server.stdout.on('data', data => {
  bytes = Buffer.concat([bytes, data]);
  while (true) {
    const end = bytes.indexOf('\r\n\r\n');
    if (end < 0) break;
    const length = Number(bytes.subarray(0, end).toString().match(/Content-Length: (\d+)/i)[1]);
    if (bytes.length < end + 4 + length) break;
    const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length));
    bytes = bytes.subarray(end + 4 + length);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(Error(message.error.message)) : resolve(message.result);
    } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }); });
}
const documents = new Map();
async function openTextDocument(resource) {
  const key = resource.toString();
  if (!documents.has(key)) {
    const text = fs.readFileSync(resource.fsPath, 'utf8');
    const lines = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
    documents.set(key, { getText: () => text, offsetAt: p => lines[p.line] + p.character,
      positionAt: offset => { let line = 0; while (line + 1 < lines.length && lines[line + 1] <= offset) line++; return new Position(line, offset - lines[line]); } });
    send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: key, languageId: 'cpp', version: 1, text } } });
  }
  return documents.get(key);
}
let outgoingRequests = 0;
const vscode = { SymbolKind: { Function: 11, Method: 5, Constructor: 8 }, workspace: { openTextDocument, fs: { stat: async resource => fs.statSync(resource.fsPath), readFile: async resource => fs.readFileSync(resource.fsPath) }, findFiles: async () => fs.readdirSync(rootDir).filter(name => /\.(cpp|h|ui)$/.test(name)).map(name => uri(pathToFileURL(path.join(rootDir, name)).href)) }, commands: {
  async executeCommand(command, resource, position) {
    if (command === 'vscode.provideOutgoingCalls') {
      outgoingRequests++;
      try { return convert(await request('callHierarchy/outgoingCalls', { item: JSON.parse(JSON.stringify(resource, (key, value) => key === 'uri' ? value.toString() : value)) })); }
      catch (e) { if (/method not found/i.test(e.message)) return []; throw e; }
    }
    await openTextDocument(resource);
    const method = { 'vscode.executeDocumentSymbolProvider': 'textDocument/documentSymbol', 'vscode.executeDefinitionProvider': 'textDocument/definition', 'vscode.prepareCallHierarchy': 'textDocument/prepareCallHierarchy' }[command];
    const response = await request(method, { textDocument: { uri: resource.toString() }, ...(position ? { position } : {}) });
    if (process.env.DEBUG_LSP) console.log(command, resource.toString(), position, JSON.stringify(response));
    return convert(response);
  }
} };
(async () => {
  try {
    await request('initialize', { processId: process.pid, rootUri: pathToFileURL(rootDir).href, capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } } });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const resource = uri(pathToFileURL(source).href);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', resource);
    const flatten = nodes => nodes.flatMap(n => [n, ...flatten(n.children || [])]);
    const symbol = flatten(symbols).find(s => s.name.split('::').pop() === rootName || s.name.split('::').pop().startsWith(rootName + '('));
    assert.ok(symbol, `Missing root ${rootName}`);
    const logs = [];
    const cache = {};
    const started = Date.now();
    let requests = 0;
    const execute = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (...args) => { requests++; return execute(...args); };
    const include = process.env.PROJECT_ONLY ? resource => resource.fsPath.startsWith(path.join(rootDir, 'source') + path.sep) : () => true;
    let qt;
    const resolver = createCallResolver(vscode, () => true, s => logs.push(s), cache, include, info => qt ? qt.follow(info) : []);
    if (process.env.QT) qt = createQtResolver(vscode, cache, () => true, s => logs.push(s), resolver, include);
    const result = await walkOutgoing({ ...symbol, uri: resource }, resolver.outgoing, Number(process.env.DEPTH || 2), 100);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    if (!process.env.BASELINE) for (const node of result.nodes) {
      const doc = await openTextDocument(node.item.uri);
      assert.ok(doc.getText().slice(doc.offsetAt(node.item.range.start), doc.offsetAt(node.item.range.end)).trimEnd().endsWith('}'), `Declaration leaked into graph: ${node.item.name}`);
    }
    if (!process.env.SUMMARY) console.log(result.nodes.map(n => `${n.depth} ${n.item.name} ${n.item.uri.fsPath}`).join('\n'));
    if (rootName === 'entry') {
      for (const name of ['save', 'load', 'leaf']) assert.ok(result.nodes.some(n => n.item.name.split('::').pop().startsWith(name)), `Missing member target ${name}`);
      assert.ok(result.nodes.some(n => n.item.uri.fsPath.endsWith('worker.cpp')));
      assert.ok(!result.nodes.some(n => n.item.name.startsWith('unrelated')));
    }
    if (!process.env.BASELINE) assert.equal(outgoingRequests, 0, 'Direct discovery must not retry unsupported hierarchy APIs');
    assert.ok(result.nodes.length > 1, 'Traversal did not leave the root');
    if (process.env.QT_EXPECT) {
      assert.ok(result.nodes.some(node => node.item.name.endsWith('::update') && node.kind === 'qt'), 'Qt slot missing from reachable graph');
      assert.ok(result.nodes.some(node => node.item.name === 'leaf'), 'Slot callees were not traversed');
    }
    if (process.env.QT && !process.env.QT_EXPECT) assert.equal(cache.qtIndex, undefined, 'Non-Qt traversal must not build a Qt workspace index');
    console.log(`Cold traversal: ${Date.now() - started} ms, ${requests} provider requests, ${result.nodes.length} definitions.`);
    if (process.env.BASELINE) return;
    requests = 0;
    const warmed = Date.now();
    await walkOutgoing({ ...symbol, uri: resource }, resolver.outgoing, Number(process.env.DEPTH || 2), 100);
    assert.equal(requests, 0, 'Unchanged graphs must reuse cached results');
    console.log(`Warm traversal: ${Date.now() - warmed} ms, ${requests} provider requests.`);
    console.log('Real clangd integration passed.');
  } finally { server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
