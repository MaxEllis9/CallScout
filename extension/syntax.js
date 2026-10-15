'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function parseTheme(text, filename) {
  if (/\.tmTheme$/i.test(filename)) {
    const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);
    const rules = [];
    for (const match of text.matchAll(/<dict>([\s\S]*?)(?:<\/dict>|$)/g)) {
      const value = key => { const item = match[1].match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`)); return item ? decode(item[1]) : undefined; };
      rules.push({ scope: value('scope'), settings: { foreground: value('foreground'), fontStyle: value('fontStyle') } });
    }
    return { tokenColors: rules };
  }
  // JSON with comments/trailing commas. Preserve quoted strings verbatim.
  const json = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|,\s*(?=[}\]])/g,
    match => match[0] === '"' ? match : '');
  return JSON.parse(json);
}
function tokenStyle(scopes, rules) {
  const matched = [];
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== 'object') continue;
    const selectors = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',') : [''];
    for (const selector of selectors) {
      if (typeof selector !== 'string') continue;
      // Scope selectors in installed themes commonly include parent scopes.
      const parts = selector.trim().split(/\s+/).filter(Boolean);
      let cursor = 0;
      let matches = true;
      for (const part of parts) {
        const next = scopes.findIndex((scope, i) => i >= cursor && (scope === part || scope.startsWith(part + '.')));
        if (next < 0) { matches = false; break; }
        cursor = next + 1;
      }
      if (matches) matched.push({ rule, specificity: parts.reduce((sum, part) => sum + part.length, 0), index });
    }
  }
  matched.sort((a, b) => a.specificity - b.specificity || a.index - b.index);
  let foreground, fontStyle;
  for (const { rule } of matched) {
    if (/^#[\da-f]{3,8}$/i.test(rule.settings?.foreground || '')) foreground = rule.settings.foreground;
    if (typeof rule.settings?.fontStyle === 'string') fontStyle = rule.settings.fontStyle;
  }
  const css = [];
  if (foreground) css.push(`color:${foreground}`);
  if (fontStyle !== undefined) {
    const styles = fontStyle.split(/\s+/);
    css.push(`font-style:${styles.includes('italic') ? 'italic' : 'normal'}`);
    css.push(`font-weight:${styles.includes('bold') ? 'bold' : 'normal'}`);
    css.push(`text-decoration:${styles.includes('underline') ? 'underline' : 'none'}`);
  }
  return css.join(';');
}

function renderCpp(lines, rules) {
  // A bounded lexical fallback: no source evaluation and no executable grammars.
  const text = lines.join('\n');
  const tokens = /R"([^\s()\\]{0,16})\([\s\S]*?(?:\)\1"|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)[\w]*\b|\b[A-Za-z_]\w*\b|[^\w\s"'\/]|\/(?![/*])/g;
  const keywords = new Set('alignas alignof asm auto break case catch class concept const consteval constexpr constinit continue co_await co_return co_yield decltype default delete do else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator private protected public register requires return sizeof static static_assert struct switch template this thread_local throw true try typedef typename union using virtual volatile while'.split(' '));
  const types = new Set('bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t'.split(' '));
  const rendered = Array.from({ length: lines.length }, () => '');
  let line = 0, offset = 0;
  const styles = new Map();
  function styleFor(scope) {
    if (!styles.has(scope)) styles.set(scope, tokenStyle(scope ? ['source.cpp', scope] : ['source.cpp'], rules));
    return styles.get(scope);
  }
  function append(value, style = '') {
    const parts = value.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i) line++;
      const safe = escapeHtml(parts[i]);
      rendered[line] += style && safe ? `<span style="${style}">${safe}</span>` : safe;
    }
  }
  for (const match of text.matchAll(tokens)) {
    append(text.slice(offset, match.index));
    const token = match[0];
    let scope;
    if (token.startsWith('//')) scope = 'comment.line.double-slash.cpp';
    else if (token.startsWith('/*')) scope = 'comment.block.cpp';
    else if (/^(?:R"|["'])/.test(token)) scope = 'string.quoted.cpp';
    else if (/^\d/.test(token)) scope = 'constant.numeric.cpp';
    else if (types.has(token)) scope = 'storage.type.cpp';
    else if (['true', 'false', 'nullptr'].includes(token)) scope = 'constant.language.cpp';
    else if (keywords.has(token)) scope = 'keyword.control.cpp';
    else if (/^\w/.test(token) && /^\s*(?:<[^;{}\n]*>\s*)?\(/.test(text.slice(match.index + token.length, match.index + token.length + 256))) scope = 'entity.name.function.cpp';
    else if (/^[A-Z]\w*$/.test(token)) scope = 'entity.name.type.cpp';
    else if (/^[+*/%=!&|^~<>-]+$/.test(token)) scope = 'keyword.operator.cpp';
    append(token, styleFor(scope));
    offset = match.index + token.length;
  }
  append(text.slice(offset));
  return rendered;
}

function createSyntaxRenderer(vscode, log) {
  let cached;
  async function themeRules() {
    const themeName = vscode.workspace.getConfiguration('workbench').get('colorTheme', '');
    let theme;
    for (const extension of vscode.extensions.all) {
      const contribution = extension.packageJSON.contributes?.themes?.find(item => (item.id || item.label) === themeName || item.label === themeName);
      if (contribution) { theme = { extension, contribution }; break; }
    }
    const rules = [];
    async function load(filename, root, seen = new Set()) {
      // Canonical paths also reject includes that escape through a symlink.
      [root, filename] = await Promise.all([fs.realpath(root), fs.realpath(filename)]);
      const relative = path.relative(root, filename);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || seen.has(filename) || seen.size >= 8) return;
      seen.add(filename);
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
      const parsed = parseTheme(await fs.readFile(filename, 'utf8'), filename);
      if (typeof parsed.include === 'string') await load(path.resolve(path.dirname(filename), parsed.include), root, seen);
      if (typeof parsed.tokenColors === 'string') await load(path.resolve(path.dirname(filename), parsed.tokenColors), root, seen);
      else if (Array.isArray(parsed.tokenColors)) rules.push(...parsed.tokenColors);
    }
    if (theme) {
      try { await load(path.resolve(theme.extension.extensionPath, theme.contribution.path), theme.extension.extensionPath); }
      catch (error) { log(`Could not read preview theme: ${error.message}`); }
    }
    const custom = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations', {});
    for (const settings of [custom, custom[`[${themeName}]`] || {}]) {
      const groups = { comments: 'comment', strings: 'string', keywords: 'keyword', numbers: 'constant.numeric', types: 'entity.name.type', functions: 'entity.name.function', variables: 'variable' };
      for (const [group, scope] of Object.entries(groups)) {
        if (settings[group]) rules.push({ scope, settings: typeof settings[group] === 'string' ? { foreground: settings[group] } : settings[group] });
      }
      if (Array.isArray(settings.textMateRules)) rules.push(...settings.textMateRules);
    }
    return rules;
  }
  return {
    async render(lines) {
      if (!cached) cached = themeRules();
      return renderCpp(lines, await cached);
    },
    invalidate() { cached = null; }
  };
}
module.exports = { escapeHtml, parseTheme, tokenStyle, renderCpp, createSyntaxRenderer };
