'use strict';
const { itemKey } = require('./graph');

function isLocalFile(uri) {
  return uri?.scheme === 'file' && !uri.authority && !/^[/\\]{2}/.test(uri.fsPath);
}

// Keep offsets intact while excluding comments, strings, and preprocessor lines.
function maskCode(text) {
  return text.replace(/R"([^\s()\\]{0,16})\([\s\S]*?(?:\)\1"|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^[ \t]*#(?:[^\n]*\\\n)*[^\n]*/gm,
    match => match.replace(/[^\r\n]/g, ' '));
}
function callOffsets(text) {
  const code = maskCode(text);
  const offsets = [];
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'alignof', 'decltype', 'noexcept', 'static_assert', 'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast', 'requires']);
  const identifiers = /\b[A-Za-z_][A-Za-z_0-9]*\b/g;
  for (const match of code.matchAll(identifiers)) {
    if (keywords.has(match[0])) continue;
    let next = match.index + match[0].length;
    while (/\s/.test(code[next] || '') && next < code.length) next++;
    if (code[next] === '<') {
      let depth = 1;
      const limit = Math.min(code.length, next + 1024);
      while (++next < limit && depth) {
        if (code[next] === '<') depth++;
        if (code[next] === '>') depth--;
        if (/[;{}]/.test(code[next])) break;
      }
      while (/\s/.test(code[next] || '') && next < code.length) next++;
    }
    if (code[next] === '(') offsets.push(match.index);
  }
  return offsets;
}

function createCallResolver(vscode, isCurrent, log, cache = {}, include = () => true, onCall = async () => []) {
  const kinds = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
  for (const key of ['documents', 'symbols', 'locations', 'definitions', 'outgoing']) cache[key] ||= new Map();
  async function document(uri) {
    const key = uri.toString();
    if (!cache.documents.has(key)) cache.documents.set(key, vscode.workspace.openTextDocument(uri));
    return cache.documents.get(key);
  }
  async function locations(uri, position) {
    const key = `${uri}:${position.line}:${position.character}`;
    if (!cache.locations.has(key)) cache.locations.set(key,
      vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position).catch(error => {
        log(`Definition lookup failed: ${error.message}`); return [];
      }));
    return await cache.locations.get(key) || [];
  }
  async function functionAt(uri, position) {
    if (!isLocalFile(uri) || !include(uri)) return;
    const key = uri.toString();
    await document(uri);
    if (!cache.symbols.has(key)) cache.symbols.set(key,
      vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri).catch(error => {
        log(`Symbol lookup failed: ${error.message}`); return [];
      }));
    let result;
    function visit(items) {
      for (const symbol of items || []) {
        if (kinds.has(symbol.kind) && symbol.selectionRange?.contains(position)) result = { ...symbol, uri };
        visit(symbol.children);
      }
    }
    visit(await cache.symbols.get(key));
    return result;
  }
  async function hasBody(item) {
    const doc = await document(item.uri);
    const text = doc.getText().slice(doc.offsetAt(item.range.start), doc.offsetAt(item.range.end)).trimEnd();
    return text.endsWith('}');
  }
  async function resolve(item, remaining = 2) {
    if (!isLocalFile(item.uri)) return [];
    const key = itemKey(item);
    if (cache.definitions.has(key)) return cache.definitions.get(key);
    if (await hasBody(item)) { cache.definitions.set(key, [item]); return [item]; }
    if (!remaining) return [];
    const bodies = new Map();
    for (const location of await locations(item.uri, item.selectionRange.start)) {
      const uri = location.targetUri || location.uri;
      const position = (location.targetSelectionRange || location.range).start;
      const target = await functionAt(uri, position);
      if (!target || itemKey(target) === key) continue;
      for (const definition of await resolve(target, remaining - 1)) bodies.set(itemKey(definition), definition);
    }
    const result = [...bodies.values()];
    cache.definitions.set(key, result);
    return result;
  }
  async function outgoing(item) {
    const key = itemKey(item);
    if (cache.outgoing.has(key)) return cache.outgoing.get(key);
    const calls = [];
    for (const definition of await resolve(item)) {
      if (!isCurrent()) break;
      const doc = await document(definition.uri);
      const start = doc.offsetAt(definition.selectionRange.end);
      const text = doc.getText().slice(start, doc.offsetAt(definition.range.end));
      if (text.length > 1024 * 1024) { log(`Skipped oversized function ${definition.name}.`); continue; }
      const offsets = callOffsets(text);
      if (offsets.length > 256) log(`Direct call scan limited to 256 sites in ${definition.name}.`);
      // Four concurrent definition requests, rather than a serial round trip per call.
      for (let i = 0; i < Math.min(offsets.length, 256) && isCurrent(); i += 4) {
        const batch = await Promise.all(offsets.slice(i, Math.min(i + 4, 256)).map(async offset => {
          const targets = [];
          const position = doc.positionAt(start + offset);
          const resolved = await locations(definition.uri, position);
          for (const location of resolved) {
            if (!isCurrent()) break;
            const uri = location.targetUri || location.uri;
            const position = (location.targetSelectionRange || location.range).start;
            const target = await functionAt(uri, position);
            if (target) targets.push(...await resolve(target));
          }
          const qtCalls = await onCall({ caller: definition, uri: definition.uri, position, locations: resolved, name: text.slice(offset).match(/^\w+/)?.[0] || '' });
          return [...new Map([...targets.map(to => ({ to })), ...qtCalls].map(call => [itemKey(call.to), { ...call, fromUri: definition.uri, callSite: position }])).values()];
        }));
        calls.push(...batch.flat());
      }
    }
    if (isCurrent()) cache.outgoing.set(key, calls);
    return calls;
  }
  return { resolve, outgoing, functionAt, document };
}
module.exports = { callOffsets, createCallResolver, isLocalFile, maskCode };
