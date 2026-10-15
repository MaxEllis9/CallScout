'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const previewScript = require('node:fs').readFileSync(path.join(__dirname, '../resources/preview.js'), 'utf8');
const { walkOutgoing, itemKey } = require('./graph');
const { CallTreeProvider } = require('./call-tree');
const { createCallResolver, isLocalFile } = require('./calls');
const { DEFAULT_DEPENDENCIES, visibleFile } = require('./files');
const { previewLines } = require('./preview');
const { createQtResolver } = require('./qt');
const { createSyntaxRenderer, escapeHtml } = require('./syntax');
const FUNCTION_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
const CPP = new Set(['cpp', 'c']);
let dimDecoration = createDimDecoration();
function createDimDecoration() {
  return vscode.window.createTextEditorDecorationType({ opacity: String(vscode.workspace.getConfiguration('callScout').get('dimOpacity', 0.65)), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
}
class ReachableFilesProvider {
  constructor() { this.files = []; this.allFiles = []; this.change = new vscode.EventEmitter(); this.onDidChangeTreeData = this.change.event; }
  update(nodes) {
    const files = new Map();
    for (const node of nodes) {
      const key = node.item.uri.toString();
      if (!files.has(key)) files.set(key, { uri: node.item.uri, functions: [] });
      files.get(key).functions.push({ name: node.item.name, uri: node.item.uri, position: node.item.selectionRange.start, range: node.item.range, depth: node.depth, kind: node.kind });
    }
    for (const file of files.values()) file.functions.sort((a,b) => a.position.line - b.position.line);
    this.allFiles = [...files.values()].sort((a,b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
    this.refresh();
  }
  refresh() {
    const settings = vscode.workspace.getConfiguration('callScout');
    const config = {
      showDependencies: settings.get('showDependencies', false),
      dependencyFolders: settings.get('dependencyFolders', DEFAULT_DEPENDENCIES),
      includedDependencyFolders: settings.get('includedDependencyFolders', [])
    };
    this.files = this.allFiles.filter(file => visibleFile(file.uri, vscode.workspace.getWorkspaceFolder(file.uri), config));
    this.change.fire();
  }
  clear() { this.allFiles = []; this.files = []; this.change.fire(); }
  getTreeItem(element) {
    if (element.functions) {
      const folder = vscode.workspace.getWorkspaceFolder(element.uri) || vscode.workspace.workspaceFolders?.[0];
      const relativePath = folder ? path.relative(folder.uri.fsPath, element.uri.fsPath) : element.uri.fsPath;
      const item = new vscode.TreeItem(path.basename(element.uri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
      item.resourceUri = element.uri; item.iconPath = vscode.ThemeIcon.File;
      item.description = path.dirname(relativePath);
      item.tooltip = `${element.uri.fsPath}\n${element.functions.length} reachable function(s)`;
      item.contextValue = 'reachableFile';
      item.command = { command: 'callScout.previewFile', title: 'Preview source file', arguments: [element.uri] };
      return item;
    }
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.description = `depth ${element.depth}${element.kind === 'qt' ? ' · Qt slot' : ''}`;
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.command = { command: 'callScout.previewFile', title: 'Preview function', arguments: [element.uri, element.position, element.range] };
    return item;
  }
  getChildren(element) { return element ? element.functions || [] : this.files; }
}
const fileProvider = new ReachableFilesProvider();
const callTreeProvider = new CallTreeProvider(vscode);
class PossibleQtProvider {
  constructor() { this.edges = []; this.change = new vscode.EventEmitter(); this.onDidChangeTreeData = this.change.event; }
  update(edges) {
    this.edges = [...new Map(edges.map(edge => [`${edge.signal}:${edge.target.uri}:${edge.target.selectionRange.start.line}:${edge.registration.uri}:${edge.registration.offset}`, edge])).values()];
    this.change.fire();
  }
  getChildren() { return this.edges; }
  getTreeItem(edge) {
    const item = new vscode.TreeItem(`${edge.signal} → ${edge.target.name}`, vscode.TreeItemCollapsibleState.None);
    item.description = 'possible';
    item.tooltip = `${edge.reason}\n${edge.registration.kind === 'auto-candidate' ? 'Candidate' : 'Registration'}: ${edge.registration.uri.fsPath}`;
    item.iconPath = new vscode.ThemeIcon('question');
    item.command = { command: 'callScout.openLocation', title: 'Inspect possible Qt target', arguments: [edge.target.uri, edge.target.selectionRange.start] };
    return item;
  }
}
const possibleQtProvider = new PossibleQtProvider();

class SourcePreviewProvider {
  constructor() { this.view = null; this.pending = null; this.request = 0; this.lastRangeKey = ''; this.navigation = null; }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    view.webview.onDidReceiveMessage(message => this.navigate(message).catch(error => output.appendLine(`Navigation failed: ${error.message}`)));
    view.onDidDispose(() => { this.view = null; });
    if (this.pending) this.show(...this.pending);
    else view.webview.html = '<html><body><p>Select a file or function in Reachable Source Files.</p></body></html>';
  }
  async navigate(message) {
    if (message?.type === 'breadcrumb') {
      if (message.request !== this.request || this.navigation?.request !== this.request || !Number.isInteger(message.index)) return;
      const steps = this.pending?.[3];
      if (!steps || message.index < 0 || message.index >= steps.length) return;
      await vscode.commands.executeCommand('callScout.selectCall', steps[message.index]);
      return;
    }
    const source = this.navigation;
    if (!source || message?.type !== 'definition' || message.request !== this.request || source.request !== this.request
      || !Number.isInteger(message.line) || !Number.isInteger(message.character) || message.character < 0
      || !source.lines.has(message.line) || !isLocalFile(source.uri)) return;
    const doc = await vscode.workspace.openTextDocument(source.uri);
    if (message.request !== this.request || doc.version !== source.version) return;
    const text = doc.lineAt(message.line).text;
    if (message.character >= text.length || !/[A-Za-z_0-9]/.test(text[message.character])) return;
    const position = new vscode.Position(message.line, message.character);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', source.uri, position) || [];
    if (message.request !== this.request) return;
    const locations = definitions.map(location => ({ uri: location.targetUri || location.uri,
      range: location.targetSelectionRange || location.range })).filter(location => isLocalFile(location.uri) && location.range);
    let target = locations[0];
    if (locations.length > 1) {
      target = await vscode.window.showQuickPick(locations.map(location => ({
        label: path.basename(location.uri.fsPath),
        description: `${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}`,
        ...location
      })), { title: 'CallScout: Choose definition' });
    }
    if (!target || message.request !== this.request) return;
    await vscode.window.showTextDocument(target.uri, { preview: true, selection: target.range });
  }
  async show(uri, position, range, steps) {
    const request = ++this.request;
    this.navigation = null;
    this.pending = [uri, position, range, steps];
    if (!this.view || !isLocalFile(uri)) return;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (request !== this.request || !this.view) return;
      const ranges = active?.get(uri.toString()) || [];
      this.lastRangeKey = ranges.map(r => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`).join(',');
      const focus = position ? position.line : -1;
      const escape = escapeHtml;
      const snippets = previewLines(doc, ranges);
      const lines = snippets.map(item => item.text);
      const notice = snippets.truncated ? '<p>Preview limited to 2,000 lines / 256 KiB.</p>' : '';
      const rendered = await syntaxRenderer.render(lines);
      if (request !== this.request || !this.view) return;
      const editorConfig = vscode.workspace.getConfiguration('editor', uri);
      const fontSize = Math.max(8, Math.min(40, Number(editorConfig.get('fontSize', 14)) || 14));
      const configuredFont = String(editorConfig.get('fontFamily', 'monospace'));
      const fontFamily = escape(/^[\w\s,'"-]+$/.test(configuredFont) ? configuredFont : 'monospace');
      const tabSize = Math.max(1, Math.min(16, Number(editorConfig.get('tabSize', 4)) || 4));
      const configuredHeight = Number(editorConfig.get('lineHeight', 0));
      const lineHeight = configuredHeight === 0 ? fontSize * 1.5 : configuredHeight < 8 ? configuredHeight * fontSize : configuredHeight;
      const fontWeight = /^([1-9]00|normal|bold)$/.test(String(editorConfig.get('fontWeight', 'normal'))) ? editorConfig.get('fontWeight', 'normal') : 'normal';
      const nonce = randomBytes(18).toString('base64');
      this.navigation = { request, uri, version: doc.version, lines: new Set(snippets.filter(item => item.line !== null).map(item => item.line)) };
      const breadcrumb = steps?.length ? `<nav aria-label="Call path">${steps.map((step, index) =>
        `<button type="button" data-step="${index}"${index === steps.length - 1 ? ' aria-current="location"' : ''}>${escape(step.item.name)}</button>`).join('<span aria-hidden="true"> › </span>')}</nav>` : '';
      const rows = lines.map((line, index) => {
        if (snippets[index].line === null) return '<div class="gap">⋯ omitted unreachable code ⋯</div>';
        const number = snippets[index].line + 1;
        return `<div class="line ${number === focus + 1 ? 'focus' : ''}" data-source-line="${number - 1}"><span class="number">${number}</span><span class="source">${rendered[index] || ' '}</span></div>`;
      }).join('');
      this.view.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
        body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 8px; margin: 0; }
        h4 { font: 12px var(--vscode-font-family); overflow-wrap:anywhere; margin: 0 0 10px; }
        nav { display:flex; flex-wrap:wrap; align-items:center; gap:2px; margin-bottom:8px; font:12px var(--vscode-font-family); }
        nav button { color:var(--vscode-textLink-foreground); background:transparent; border:0; padding:3px; font:inherit; cursor:pointer; overflow-wrap:anywhere; }
        nav button:hover { text-decoration:underline; } nav button[aria-current] { color:var(--vscode-foreground); font-weight:bold; }
        nav button:focus-visible { outline:1px solid var(--vscode-focusBorder); }
        .code { overflow: auto; white-space: pre; }
        .line { display: flex; min-width: max-content; } .number { color: var(--vscode-editorLineNumber-foreground); min-width: 3.5em; padding-right: 1em; text-align: right; user-select: none; }
        .navigate .source { cursor: pointer; }
        .gap { color: var(--vscode-descriptionForeground); margin: 8px 0; }
        .focus { background: var(--vscode-editor-selectionBackground); }
      </style></head><body>${breadcrumb}<h4>${escape(vscode.workspace.asRelativePath(uri))}</h4><div class="code" style="font-family:${fontFamily};font-size:${fontSize}px;font-weight:${fontWeight};line-height:${Math.max(8, Math.min(100, lineHeight))}px;tab-size:${tabSize}">${rows || '<p>No reachable function definitions in this file.</p>'}</div>${notice}<script nonce="${nonce}" data-request="${request}">${previewScript}</script></body></html>`;
    } catch (e) { output.appendLine(`Preview error: ${e.message}`); }
  }
}
const previewProvider = new SourcePreviewProvider();
const output = vscode.window.createOutputChannel('CallScout');
const syntaxRenderer = createSyntaxRenderer(vscode, message => output.appendLine(message));
let active = null;
let generation = 0;
let timer;
let lastRoot = null;
let currentRoot = null;
let enabled = true;
let callCache = {};
let pinned = null;
let callTreeView;

function contains(range, position) { return !!range && range.contains(position); }
function span(range) { return (range.end.line - range.start.line) * 100000 + range.end.character - range.start.character; }
function enclosingSymbol(symbols, position) {
  const matches = [];
  function visit(symbol) {
    if (!contains(symbol.range, position)) return;
    if (FUNCTION_KINDS.has(symbol.kind)) matches.push(symbol);
    for (const child of symbol.children || []) visit(child);
  }
  for (const symbol of symbols || []) visit(symbol);
  matches.sort((a, b) => span(a.range) - span(b.range));
  return matches[0];
}
function dimRanges(document, reachable) {
  const length = document.getText().length;
  const intervals = (reachable || []).map(r => [document.offsetAt(r.start), document.offsetAt(r.end)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const result = [];
  let cursor = 0;
  for (const [start, end] of intervals) {
    if (start > cursor) result.push(new vscode.Range(document.positionAt(cursor), document.positionAt(start)));
    cursor = Math.max(cursor, end);
  }
  if (cursor < length) result.push(new vscode.Range(document.positionAt(cursor), document.positionAt(length)));
  return result;
}
function decorateVisible() {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!CPP.has(editor.document.languageId)) {
      editor.setDecorations(dimDecoration, []);
      continue;
    }
    const ranges = active && active.get(editor.document.uri.toString()) || [];
    editor.setDecorations(dimDecoration, enabled && active ? dimRanges(editor.document, ranges) : []);
  }
}
function addRange(map, uri, range) {
  if (!uri || !range) return;
  const key = uri.toString();
  const ranges = map.get(key) || [];
  if (!ranges.some(r => r.isEqual(range))) ranges.push(range);
  map.set(key, ranges);
}
function setPinned(value) {
  pinned = value;
  vscode.commands.executeCommand('setContext', 'callScout.pinned', !!pinned);
  if (callTreeView) callTreeView.description = pinned ? `Pinned: ${pinned.name}` : 'Following cursor';
}
function clear() {
  setPinned(null);
  generation++;
  clearTimeout(timer);
  active = null;
  lastRoot = null;
  currentRoot = null;
  fileProvider.clear(); callTreeProvider.clear(); possibleQtProvider.update([]);
  if (previewProvider.pending) { previewProvider.pending[3] = undefined; previewProvider.show(...previewProvider.pending); }
  decorateVisible();
}
async function analyze(options = {}) {
  const run = ++generation;
  const editor = vscode.window.activeTextEditor;
  const target = pinned;
  const document = target ? await vscode.workspace.openTextDocument(target.uri).catch(error => {
    if (pinned === target) clear();
    throw error;
  }) : editor?.document;
  if (run !== generation || target !== pinned || !document || !isLocalFile(document.uri) || !CPP.has(document.languageId)) return;
  const config = vscode.workspace.getConfiguration('callScout');
  const position = target ? document.positionAt(target.offset) : editor.selection.active;
  let symbols;
  try {
    callCache.symbols ||= new Map();
    const uriKey = document.uri.toString();
    if (!callCache.symbols.has(uriKey)) callCache.symbols.set(uriKey, vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri));
    symbols = await callCache.symbols.get(uriKey);
  }
  catch (e) { callCache = {}; output.appendLine(`Symbol provider error: ${e.message}`); return; }
  if (run !== generation) return;
  const symbol = enclosingSymbol(symbols, position);
  if (!symbol || (pinned && symbol.name !== pinned.name)) {
    if (pinned) {
      setPinned(null);
      vscode.window.showInformationMessage('CallScout: The pinned function changed or was removed. Select a function to continue.');
    }
    // Outside a function, do not dim the file as if nothing were reachable.
    active = null; lastRoot = null; currentRoot = null; fileProvider.clear(); callTreeProvider.clear(); possibleQtProvider.update([]);
    if (previewProvider.pending) { previewProvider.pending[3] = undefined; previewProvider.show(...previewProvider.pending); }
    decorateVisible();
    return;
  }
  const rootKey = `${document.uri.toString()}:${symbol.range.start.line}:${symbol.range.start.character}:${symbol.name}`;
  if (!options.force && rootKey === lastRoot && active) return;
  let root = { ...symbol, uri: document.uri };
  if (previewProvider.pending?.[3]) {
    previewProvider.pending[3] = undefined;
    previewProvider.show(...previewProvider.pending);
  }
  lastRoot = null;
  currentRoot = { uri: document.uri.toString(), range: symbol.range };
  const started = Date.now();
  const filter = {
    showDependencies: config.get('showDependencies', false),
    dependencyFolders: config.get('dependencyFolders', DEFAULT_DEPENDENCIES),
    includedDependencyFolders: config.get('includedDependencyFolders', [])
  };
  if ((callCache.outgoing?.size || 0) > 1000 || (callCache.locations?.size || 0) > 10000) callCache = {};
  const include = uri => visibleFile(uri, vscode.workspace.getWorkspaceFolder(uri), filter);
  let qt;
  const resolver = createCallResolver(vscode, () => run === generation, message => output.appendLine(message), callCache, include,
    info => qt ? qt.follow(info) : [], (caller, targets) => {
      if (run !== generation) return;
      const depth = (visited.get(itemKey(caller))?.depth || 0) + 1;
      const fileCount = ranges.size;
      for (const item of targets) record(item, depth);
      if (ranges.size !== fileCount || Date.now() - lastPublish >= 100) publish();
    });
  if (config.get('qtSupport', true)) qt = createQtResolver(vscode, callCache, () => run === generation, message => output.appendLine(message), resolver, include);
  const possible = [];
  possibleQtProvider.update([]);
  const ranges = new Map();
  const visited = new Map();
  const maxFunctions = Math.max(1, Math.min(10000, Math.floor(Number(config.get('maxFunctions', 500)) || 500)));
  function record(item, depth, kind) {
    const key = itemKey(item), previous = visited.get(key);
    if (!previous && visited.size >= maxFunctions) return;
    if (!previous || depth < previous.depth) visited.set(key, { item, depth, kind });
    addRange(ranges, item.uri, item.range);
  }
  const callsByCaller = new Map();
  let lastPublish = 0;
  function publish() {
    if (run !== generation) return;
    active = ranges;
    fileProvider.update([...visited.values()]);
    callTreeProvider.update(root, callsByCaller, config.get('maxDepth', 8));
    decorateVisible();
    if (previewProvider.pending) {
      const previewRanges = ranges.get(previewProvider.pending[0].toString()) || [];
      const key = previewRanges.map(r => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`).join(',');
      if (key !== previewProvider.lastRangeKey) previewProvider.show(...previewProvider.pending);
    }
    lastPublish = Date.now();
  }
  // Definitions only: declaration-only headers never enter the graph or preview.
  const rootDefinitions = await resolver.resolve(root);
  if (rootDefinitions.length === 1) root = rootDefinitions[0];
  for (const definition of rootDefinitions) {
    record(definition, 0);
  }
  if (run !== generation) return;
  publish();
  output.appendLine(`Scanning ${symbol.name}…`);
  const result = await walkOutgoing(root, async item => {
    if (run !== generation) return [];
    const calls = await resolver.outgoing(item);
    if (run === generation && qt) {
      const matches = qt.possibleFor(item);
      if (matches.length) { possible.push(...matches); possibleQtProvider.update(possible); }
    }
    return calls;
  }, config.get('maxDepth', 8), config.get('maxFunctions', 500), async node => {
    if (run !== generation) return;
    for (const definition of await resolver.resolve(node.item)) {
      if (run !== generation) return;
      record(definition, node.depth, node.kind);
    }
    if (Date.now() - lastPublish >= 100) publish();
  }, (caller, calls) => {
    if (run !== generation) return;
    callsByCaller.set(itemKey(caller), calls);
    if (Date.now() - lastPublish >= 100) publish();
  });
  if (run !== generation) return;
  // Reconcile provisional discoveries with the bounded completed traversal.
  visited.clear(); ranges.clear();
  for (const node of result.nodes) {
    for (const definition of await resolver.resolve(node.item)) record(definition, node.depth, node.kind);
  }
  if (run !== generation) return;
  lastRoot = rootKey;
  publish();
  output.appendLine(`\nFrom ${root.name} (${document.uri.fsPath}:${symbol.range.start.line + 1}), ${visited.size} definition(s), ${ranges.size} file(s), ${Date.now() - started} ms:`);
  for (const node of visited.values()) output.appendLine(`${'  '.repeat(node.depth)}${node.item.name} — ${node.item.uri.fsPath}:${node.item.range.start.line + 1}`);
  for (const error of result.errors) output.appendLine(`UNRESOLVED ${error.key}: ${error.message}`);
  if (result.truncated) output.appendLine('Traversal truncated by maxFunctions.');
  if (options.showOutput) output.show(true);
}
function scheduleAnalyze(force = false) {
  if (!enabled && !force) return;
  clearTimeout(timer);
  // Invalidate in-flight traversals immediately, not after the debounce delay.
  generation++;
  timer = setTimeout(() => {
    timer = null;
    analyze({ force }).catch(e => { currentRoot = null; output.appendLine(`Analysis error: ${e.stack || e}`); });
  },
    Math.max(100, Math.min(3000, Number(vscode.workspace.getConfiguration('callScout').get('debounceMs', 120)) || 120)));
}
async function migrateSettings() {
  const keys = ['maxDepth', 'maxFunctions', 'autoUpdate', 'debounceMs', 'dimOpacity', 'showDependencies', 'dependencyFolders', 'includedDependencyFolders'];
  const scopes = [
    [undefined, 'globalValue', vscode.ConfigurationTarget.Global],
    [undefined, 'workspaceValue', vscode.ConfigurationTarget.Workspace],
    ...(vscode.workspace.workspaceFolders || []).map(folder => [folder.uri, 'workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder])
  ];
  for (const [uri, field, target] of scopes) {
    const previous = vscode.workspace.getConfiguration('reachabilityLens', uri);
    const current = vscode.workspace.getConfiguration('callScout', uri);
    for (const key of keys) {
      const value = previous.inspect(key)?.[field];
      if (value === undefined) continue;
      if (current.inspect(key)?.[field] === undefined) await current.update(key, value, target);
      await previous.update(key, undefined, target);
    }
  }
}
function activate(context) {
  if (vscode.workspace.isTrusted === false) return;
  enabled = vscode.workspace.getConfiguration('callScout').get('autoUpdate', true);
  callTreeView = vscode.window.createTreeView('callScout.callTree', { treeDataProvider: callTreeProvider, showCollapseAll: true });
  setPinned(null);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{c,cc,cpp,cxx,h,hpp,hxx,inl,ui}');
  const changed = uri => {
    const config = vscode.workspace.getConfiguration('callScout');
    if (!isLocalFile(uri) || !visibleFile(uri, vscode.workspace.getWorkspaceFolder(uri), {
      showDependencies: config.get('showDependencies', false),
      dependencyFolders: config.get('dependencyFolders', DEFAULT_DEPENDENCIES),
      includedDependencyFolders: config.get('includedDependencyFolders', [])
    })) return;
    callCache = {}; previewProvider.lastRangeKey = '';
    if (active) scheduleAnalyze(true);
  };
  context.subscriptions.push(
    watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
    vscode.window.registerTreeDataProvider('callScout.files', fileProvider),
    callTreeView,
    vscode.window.registerTreeDataProvider('callScout.qtPossible', possibleQtProvider),
    vscode.window.registerWebviewViewProvider('callScout.preview', previewProvider),
    vscode.commands.registerCommand('callScout.pinRoot', async () => {
      const root = callTreeProvider.root;
      if (!root) return;
      const doc = await vscode.workspace.openTextDocument(root.uri);
      if (root !== callTreeProvider.root) return;
      setPinned({ uri: root.uri, name: root.name, offset: doc.offsetAt(root.selectionRange.start) });
    }),
    vscode.commands.registerCommand('callScout.unpinRoot', () => { setPinned(null); scheduleAnalyze(true); }),
    vscode.commands.registerCommand('callScout.refresh', () => { callCache = {}; scheduleAnalyze(true); }),
    vscode.commands.registerCommand('callScout.openCallSite', element => {
      if (element?.callSite && isLocalFile(element.fromUri)) return vscode.commands.executeCommand('callScout.openLocation', element.fromUri, element.callSite);
    }),
    vscode.commands.registerCommand('callScout.selectCall', async element => {
      if (!element?.item || !isLocalFile(element.item.uri)) return;
      const steps = [];
      for (let step = element; step; step = step.parent) steps.unshift(step);
      await previewProvider.show(element.item.uri, element.item.selectionRange.start, undefined, steps);
      if (previewProvider.pending?.[3] !== steps) return;
      await callTreeView.reveal(element, { select: true, focus: false });
      await vscode.commands.executeCommand('callScout.preview.focus');
    }),
    vscode.commands.registerCommand('callScout.previewFile', async (uri, position, range) => {
      await previewProvider.show(uri, position, range);
      await vscode.commands.executeCommand('callScout.preview.focus');
    }),
    vscode.commands.registerCommand('callScout.openLocation', async (uri, position) => {
      if (!isLocalFile(uri)) return;
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }),
    vscode.commands.registerCommand('callScout.toggleDependencies', async () => {
      const config = vscode.workspace.getConfiguration('callScout');
      await config.update('showDependencies', !config.get('showDependencies', false), vscode.ConfigurationTarget.Workspace);
    }),
    vscode.commands.registerCommand('callScout.selectDependencies', async () => {
      const config = vscode.workspace.getConfiguration('callScout');
      const selected = config.get('includedDependencyFolders', []);
      const choices = config.get('dependencyFolders', DEFAULT_DEPENDENCIES).map(label => ({ label, picked: selected.includes(label) }));
      const picked = await vscode.window.showQuickPick(choices, { canPickMany: true, title: 'Include these dependency folders', placeHolder: 'Project files remain visible. Select JUCE, Qt, or other dependencies to include.' });
      if (!picked) return;
      await config.update('includedDependencyFolders', picked.map(item => item.label), vscode.ConfigurationTarget.Workspace);
      await config.update('showDependencies', false, vscode.ConfigurationTarget.Workspace);
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      syntaxRenderer.invalidate();
      if (previewProvider.pending) previewProvider.show(...previewProvider.pending);
    }),
    vscode.commands.registerCommand('callScout.analyze' , () => { setPinned(null); callCache = {}; enabled = true; scheduleAnalyze(true); }),
    vscode.commands.registerCommand('callScout.clear', () => { enabled = false; clear(); }),
    vscode.commands.registerCommand('callScout.enableAuto', () => { enabled = true; scheduleAnalyze(true); }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (pinned) return;
      if (event.textEditor !== vscode.window.activeTextEditor || !CPP.has(event.textEditor.document.languageId)) return;
      if (!timer && currentRoot?.uri === event.textEditor.document.uri.toString() && currentRoot.range.contains(event.textEditor.selection.active)) return;
      scheduleAnalyze();
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => { if (!pinned && editor && CPP.has(editor.document.languageId)) scheduleAnalyze(); }),
    vscode.window.onDidChangeVisibleTextEditors(() => { decorateVisible(); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if ((!CPP.has(event.document.languageId) && !event.document.uri.path.endsWith('.ui')) || !event.contentChanges.length) return;
      if (pinned?.uri.toString() === event.document.uri.toString()) {
        for (const change of [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
          if (change.rangeLength && change.rangeOffset <= pinned.offset && change.rangeOffset + change.rangeLength > pinned.offset) {
            setPinned(null); // The pinned identifier was replaced; do not guess another target.
            break;
          }
          if (change.rangeOffset <= pinned.offset) pinned.offset += change.text.length - change.rangeLength;
        }
      }
      callCache = {}; previewProvider.lastRangeKey = '';
      previewProvider.navigation = null;
      if (previewProvider.pending) previewProvider.pending[3] = undefined;
      if (active) {
        // Source changed: invalidate offsets and recompute.
        active = null; currentRoot = null;
        scheduleAnalyze(true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('callScout.showDependencies') || event.affectsConfiguration('callScout.dependencyFolders') || event.affectsConfiguration('callScout.includedDependencyFolders')) {
        callCache = {};
        fileProvider.refresh();
        scheduleAnalyze(true);
        return;
      }
      if (event.affectsConfiguration('editor') || event.affectsConfiguration('workbench.colorTheme')) {
        syntaxRenderer.invalidate();
        if (previewProvider.pending) previewProvider.show(...previewProvider.pending);
      }
      if (event.affectsConfiguration('callScout')) {
        dimDecoration.dispose();
        dimDecoration = createDimDecoration();
        decorateVisible();
        enabled = vscode.workspace.getConfiguration('callScout').get('autoUpdate', true);
        if (enabled) scheduleAnalyze(true); else clear();
      }
    }),
    { dispose: () => { clearTimeout(timer); dimDecoration.dispose(); fileProvider.change.dispose(); callTreeProvider.change.dispose(); possibleQtProvider.change.dispose(); } }, output
  );
  migrateSettings().catch(error => output.appendLine(`Settings migration failed: ${error.message}`));
  if (enabled && vscode.window.activeTextEditor) scheduleAnalyze(true);
}
function deactivate() { clear(); }
module.exports = { activate, deactivate };
