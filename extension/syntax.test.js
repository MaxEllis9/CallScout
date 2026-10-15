'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTheme, tokenStyle, renderCpp } = require('./syntax');
const rules = [
  { settings: { foreground: '#eeeeee' } },
  { scope: 'keyword', settings: { foreground: '#ff0000' } },
  { scope: 'string', settings: { foreground: '#00ff00' } },
  { scope: 'comment', settings: { foreground: '#888888', fontStyle: 'italic' } },
  { scope: 'entity.name.function', settings: { foreground: '#0000ff' } }
];
test('reads installed XML themes without interpreting entities or external resources', () => {
  const xml = '<!DOCTYPE plist SYSTEM "https://example.com/no-fetch"><plist><dict><key>settings</key><array><dict><key>scope</key><string>keyword, storage</string><key>settings</key><dict><key>foreground</key><string>#ff0000</string></dict></dict></array></dict></plist>';
  assert.equal(parseTheme(xml, 'theme.tmTheme').tokenColors[0].settings.foreground, '#ff0000');
  assert.equal(parseTheme(xml, 'theme.tmTheme').tokenColors[0].scope, 'keyword, storage');
});
test('reads JSON themes with comments, URLs inside strings, and trailing commas', () => {
  const parsed = parseTheme('{/*comment*/"name":"https://example.com", "tokenColors":[{"scope":"keyword", "settings":{"foreground":"#ff0000",},},],}', 'theme.json');
  assert.equal(parsed.name, 'https://example.com');
  assert.equal(parsed.tokenColors[0].settings.foreground, '#ff0000');
});
test('renders strings after operators, multiline comments, keywords and function calls in theme colours', () => {
  const html = renderCpp(['if (ready()) { auto s="<img src=x>"; /* comment', 'continued */ return; }'], rules);
  assert.match(html[0], /color:#ff0000[^>]*>if<\/span>/);
  assert.match(html[0], /color:#0000ff[^>]*>ready<\/span>/);
  assert.match(html[0], /color:#00ff00[^>]*>&quot;&lt;img src=x&gt;&quot;<\/span>/);
  assert.match(html[1], /color:#888888;font-style:italic[^>]*>continued \*\//);
  assert.doesNotMatch(html.join(''), /<img/);
});
test('rejects theme colours that attempt CSS or HTML injection', () => {
  const style = tokenStyle(['source.cpp', 'keyword.control.cpp'], [{ scope: 'keyword', settings: { foreground: 'red;background:url(https://example.com)', fontStyle: '\"></span><script>alert(1)</script>' } }]);
  assert.doesNotMatch(style, /url|script|https|"|</);
});
test('theme includes cannot escape the installed theme directory through a symlink', async () => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'callscout-theme-'));
  try {
    const installed = path.join(root, 'installed');
    await fs.mkdir(installed);
    await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify({ tokenColors: [{ scope: 'keyword', settings: { foreground: '#123456' } }] }));
    await fs.symlink(path.join(root, 'outside.json'), path.join(installed, 'escape.json'));
    await fs.writeFile(path.join(installed, 'theme.json'), JSON.stringify({ include: 'escape.json', tokenColors: [] }));
    const vscode = { extensions: { all: [{ extensionPath: installed,
      packageJSON: { contributes: { themes: [{ label: 'Test', path: 'theme.json' }] } } }] },
      workspace: { getConfiguration: section => ({ get: (_key, fallback) => section === 'workbench' ? 'Test' : fallback }) } };
    const renderer = require('./syntax').createSyntaxRenderer(vscode, () => {});
    assert.doesNotMatch((await renderer.render(['if (ready()) {}'])).join(''), /123456/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
