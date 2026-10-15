'use strict';
const { maskCode, isLocalFile } = require('./calls');
const { itemKey } = require('./graph');

function closing(code, start, open, close) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++;
    if (code[i] === close && --depth === 0) return i;
  }
  return -1;
}
function argumentsAt(code, open, end) {
  const args = [];
  let start = open + 1, parens = 0, braces = 0, brackets = 0, angles = 0;
  for (let i = start; i < end; i++) {
    const c = code[i];
    if (c === '(') parens++; else if (c === ')') parens--;
    else if (c === '{') braces++; else if (c === '}') braces--;
    else if (c === '[') brackets++; else if (c === ']') brackets--;
    else if (!parens && !braces && !brackets && c === '<') angles++;
    else if (!parens && !braces && !brackets && c === '>' && angles) angles--;
    else if (c === ',' && !parens && !braces && !brackets && !angles) { args.push({ start, end: i }); start = i + 1; }
  }
  args.push({ start, end });
  return args;
}
function endpoint(code, arg, macro) {
  if (!arg) return null;
  const text = code.slice(arg.start, arg.end);
  const pointer = /&\s*((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)/.exec(text);
  if (pointer) return { owner: pointer[1], name: pointer[2], offset: arg.start + pointer.index + pointer[0].lastIndexOf(pointer[2]), kind: 'pointer' };
  const legacy = new RegExp(`\\b${macro}\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\(`).exec(text);
  if (legacy) return { name: legacy[1], offset: arg.start + legacy.index + legacy[0].indexOf(legacy[1]), kind: 'macro' };
  const capture = text.search(/\[/);
  if (capture >= 0) {
    const captureEnd = closing(text, capture, '[', ']');
    const body = text.indexOf('{', captureEnd + 1);
    const bodyEnd = body >= 0 ? closing(text, body, '{', '}') : -1;
    if (captureEnd >= 0 && bodyEnd >= 0) return { name: 'lambda', offset: arg.start + capture, selectionEnd: arg.start + captureEnd + 1, end: arg.start + bodyEnd + 1, kind: 'lambda' };
  }
  return null;
}
function parseQt(text, qtWorkspace = false) {
  const code = maskCode(text);
  const connections = [], auto = [];
  for (const match of code.matchAll(/\b(connect|connectSlotsByName)\s*\(/g)) {
    const open = match.index + match[0].lastIndexOf('(');
    const end = closing(code, open, '(', ')');
    if (end < 0) continue;
    if (match[1] === 'connectSlotsByName') { auto.push({ offset: match.index, end: end + 1 }); continue; }
    const args = argumentsAt(code, open, end);
    if (args.length < 3) continue;
    const signal = endpoint(code, args[1], 'SIGNAL');
    const slotIndex = args.length === 3 || (args.length === 4 && /^\s*Qt::/.test(code.slice(args[3].start, args[3].end))) ? 2 : 3;
    const slot = endpoint(code, args[slotIndex], 'SLOT');
    if (!signal && !qtWorkspace && !/QObject\s*::\s*$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue;
    connections.push({ offset: match.index, end: end + 1, signal, slot,
      sender: code.slice(args[0].start, args[0].end).trim(),
      receiver: slotIndex === 3 ? code.slice(args[2].start, args[2].end).trim() : '',
      connectionType: code.slice(args[slotIndex + 1]?.start || end, end).trim() });
  }
  const automaticSlots = [...code.matchAll(/\b(on_[A-Za-z_]\w*)\s*\(/g)].map(match => ({ name: match[1], offset: match.index }));
  return { connections, auto, automaticSlots };
}
function signalSection(text, position, masked = false) {
  const code = masked ? text : maskCode(text);
  const lines = code.split(/\r?\n/);
  const before = lines.slice(0, position.line).join('\n') + '\n' + (lines[position.line] || '').slice(0, position.character);
  if (/\bQ_SIGNAL\b[^;{}]*$/.test(before)) return true;
  const stack = [];
  let section = '';
  for (const match of before.matchAll(/[{}]|\b(signals|Q_SIGNALS|public|protected|private)\s*(?:(?:slots|Q_SLOTS)\s*)?:/g)) {
    if (match[0] === '{') { stack.push(section); section = ''; }
    else if (match[0] === '}') section = stack.pop() || '';
    else section = match[1];
  }
  return section === 'signals' || section === 'Q_SIGNALS';
}
function locationKey(location) {
  const uri = location.targetUri || location.uri;
  const range = location.targetSelectionRange || location.range;
  return `${uri}:${range.start.line}:${range.start.character}`;
}
function localConnection(record, info, document, code) {
  if (!record.signal || record.signal.kind !== 'pointer' || !record.slot || record.slot.kind === 'macro'
    || record.sender !== 'this' || (record.receiver && record.receiver !== 'this') || /QueuedConnection/.test(record.connectionType)) return false;
  if (record.uri.toString() !== info.uri.toString()) return false;
  const start = document.offsetAt(info.caller.range.start);
  const call = document.offsetAt(info.position);
  if (record.offset < start || record.end >= call) return false;
  const depthAt = end => [...code.slice(start, end)].reduce((depth, char) => depth + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
  if (depthAt(record.offset) !== 1 || depthAt(call) !== 1) return false;
  // Only a straight-line registration and emission in the same function is promoted.
  return !/\b(if|for|while|switch|catch|return|throw|disconnect|delete)\b/.test(code.slice(start, call));
}

function createQtResolver(vscode, cache, isCurrent, log, resolver, include) {
  cache.qtPossible ||= new Map();
  cache.qtCalls ||= new Map();
  cache.qtTexts ||= new Map();
  cache.qtMasked ||= new Map();
  cache.qtEndpoints ||= new Map();
  async function read(uri) {
    if (!isLocalFile(uri)) return '';
    const key = uri.toString();
    if (cache.documents?.has(key)) { const text = (await cache.documents.get(key)).getText(); return text.length <= 512 * 1024 ? text : ''; }
    const open = vscode.workspace.textDocuments?.find(document => document.uri.toString() === key);
    if (open) { const text = open.getText(); return text.length <= 512 * 1024 ? text : ''; }
    if (!cache.qtTexts.has(key)) cache.qtTexts.set(key, (async () => {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 512 * 1024) return '';
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    })().catch(error => { log(`Qt source read failed: ${error.message}`); return ''; }));
    return cache.qtTexts.get(key);
  }
  async function masked(uri) {
    const key = uri.toString();
    if (!cache.qtMasked.has(key)) cache.qtMasked.set(key, read(uri).then(maskCode));
    return cache.qtMasked.get(key);
  }
  async function index() {
    if (!cache.qtIndex) cache.qtIndex = (async () => {
      const files = (await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx,h,hpp,hxx,inl,ui}', '**/{.git,node_modules}/**', 1000)).filter(uri => isLocalFile(uri) && include(uri));
      const records = [], automatic = [], slots = [];
      let bytes = 0;
      for (let i = 0; i < files.length; i += 8) {
        for (const result of await Promise.all(files.slice(i, i + 8).map(async uri => {
          const text = await read(uri);
          if (uri.path.endsWith('.ui')) return { uri, size: text.length, connections: [], auto: [{ offset: 0, end: 0, generated: true }], automaticSlots: [] };
          return { uri, size: text.length, ...parseQt(text, true) };
        }))) {
          bytes += result.size;
          if (bytes > 8 * 1024 * 1024) { log('Qt registration index limited to 8 MiB; some connections may be missing.'); return { records, automatic, slots }; }
          records.push(...result.connections.map(record => ({ ...record, uri: result.uri })));
          automatic.push(...result.auto.map(record => ({ ...record, uri: result.uri })));
          slots.push(...result.automaticSlots.map(record => ({ ...record, uri: result.uri })));
        }
      }
      if (files.length >= 1000) log('Qt registration index limited to 1,000 workspace files.');
      return { records, automatic, slots };
    })();
    return cache.qtIndex;
  }
  async function endpointLocations(record, end) {
    const key = `${record.uri}:${end.offset}`;
    if (!cache.qtEndpoints.has(key)) cache.qtEndpoints.set(key, (async () => {
      const document = await resolver.document(record.uri);
      return await vscode.commands.executeCommand('vscode.executeDefinitionProvider', record.uri, document.positionAt(end.offset)) || [];
    })());
    return cache.qtEndpoints.get(key);
  }
  async function isQtRegistration(record) {
    for (const location of await endpointLocations(record, { offset: record.offset })) {
      const uri = location.targetUri || location.uri;
      if (!isLocalFile(uri)) continue;
      const position = (location.targetSelectionRange || location.range).start;
      const code = await masked(uri);
      const lines = code.split(/\r?\n/);
      const offset = lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
      if (/\bQObject\s*::\s*$/.test(code.slice(0, offset))) return true;
      for (const match of code.matchAll(/\b(?:class|struct)\s+(?:[A-Za-z_]\w*\s+)*QObject\b[^;{]*\{/g)) {
        const open = match.index + match[0].lastIndexOf('{');
        if (open < offset && closing(code, open, '{', '}') > offset) return true;
      }
    }
    return false;
  }
  async function targets(record, end) {
    if (!end) return [];
    const document = await resolver.document(record.uri);
    if (end.kind === 'lambda') {
      return [{ name: `lambda for ${record.signal?.name || 'signal'}`, kind: vscode.SymbolKind.Function, uri: record.uri,
        range: new vscode.Range(document.positionAt(end.offset), document.positionAt(end.end)),
        selectionRange: new vscode.Range(document.positionAt(end.offset), document.positionAt(end.selectionEnd)) }];
    }
    let locations = await endpointLocations(record, end);
    if (!locations.length && end.kind === 'macro') {
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', end.name) || [];
      locations = symbols.filter(symbol => symbol.name === end.name || symbol.name.endsWith('::' + end.name)).map(symbol => symbol.location);
    }
    const result = new Map();
    for (const location of locations) {
      const uri = location.targetUri || location.uri;
      const range = location.targetSelectionRange || location.range;
      const symbol = await resolver.functionAt(uri, range.start);
      if (symbol) for (const body of await resolver.resolve(symbol)) result.set(itemKey(body), body);
    }
    return [...result.values()];
  }
  async function follow(info) {
    if (!info.name || !isCurrent()) return [];
    const document = await resolver.document(info.uri);
    const text = document.getText();
    const qtContext = /\b(?:Q[A-Z]\w*|emit|signals)\b|Qt::|\bui\s*->/.test(text);
    const offset = document.offsetAt(info.position);
    const code = await masked(info.uri);
    let isSignal = /\b(?:emit|Q_EMIT)\s+(?:this\s*->\s*)?$/.test(code.slice(Math.max(0, offset - 40), offset));
    if (!isSignal) {
      for (const location of info.locations) {
        const uri = location.targetUri || location.uri;
        if (!isLocalFile(uri) || (!qtContext && !include(uri))) continue;
        const position = (location.targetSelectionRange || location.range).start;
        if (signalSection(await masked(uri), position, true)) { isSignal = true; break; }
      }
    }
    if (!isSignal || !isCurrent()) return [];
    const key = `${info.uri}:${info.position.line}:${info.position.character}`;
    if (cache.qtCalls.has(key)) return cache.qtCalls.get(key);
    const discovered = await index();
    if (!isCurrent()) return [];
    const calls = [], possible = [];
    const sourceKeys = new Set(info.locations.map(locationKey));
    for (const record of discovered.records) {
      if (!isCurrent()) break;
      if (record.signal && record.signal.name !== info.name) continue;
      let exactSignal = false;
      if (record.signal?.kind === 'pointer') {
        const locations = await endpointLocations(record, record.signal);
        exactSignal = locations.some(location => sourceKeys.has(locationKey(location)));
        if (locations.length && sourceKeys.size && !exactSignal) continue;
      }
      const resolved = await targets(record, record.slot);
      const qtRegistration = exactSignal && await isQtRegistration(record);
      const confirmed = qtRegistration && localConnection(record, info, document, code) && resolved.length > 0;
      if (confirmed) calls.push(...resolved.map(to => ({ to, kind: 'qt' })));
      else {
        const reason = !record.signal ? 'Unresolved connect() call; Qt signal association is unknown'
          : record.signal.kind === 'macro' ? 'Legacy SIGNAL/SLOT: names, overload and runtime object identity need verification'
          : !resolved.length ? 'Slot/functor could not be resolved or is excluded by dependency filters'
          : 'Runtime registration, sender/receiver identity, lifetime or delivery is uncertain';
        const registrationDoc = await resolver.document(record.uri);
        const fallback = { uri: record.uri, name: record.slot?.name || 'unresolved receiver', selectionRange: new vscode.Range(registrationDoc.positionAt(record.offset), registrationDoc.positionAt(record.offset)) };
        for (const target of resolved.length ? resolved : [fallback]) possible.push({ signal: info.name, target, reason, registration: record });
      }
    }
    if (discovered.automatic.length) {
      for (const slot of discovered.slots.filter(slot => slot.name.endsWith('_' + info.name))) {
        if (!isCurrent()) break;
        const resolved = await targets(slot, { ...slot, kind: 'pointer' });
        for (const target of resolved) possible.push({ signal: info.name, target, reason: 'connectSlotsByName: child objectName and generated/runtime setup are unverified', registration: { ...slot, kind: 'auto-candidate' } });
      }
    }
    if (isCurrent()) {
      cache.qtCalls.set(key, calls);
      const callerKey = itemKey(info.caller);
      const existing = cache.qtPossible.get(callerKey) || [];
      for (const edge of possible) {
        if (!existing.some(other => other.signal === edge.signal && itemKey(other.target) === itemKey(edge.target) && other.registration.offset === edge.registration.offset && other.registration.uri.toString() === edge.registration.uri.toString())) existing.push(edge);
      }
      cache.qtPossible.set(callerKey, existing);
    }
    return calls;
  }
  return { follow, possibleFor: item => cache.qtPossible.get(itemKey(item)) || [] };
}
module.exports = { parseQt, signalSection, localConnection, createQtResolver };
