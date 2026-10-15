'use strict';
const path = require('node:path');
const { itemKey } = require('./graph');

class CallTreeProvider {
  constructor(vscode) {
    this.vscode = vscode;
    this.root = null;
    this.calls = new Map();
    this.maxDepth = 8;
    this.change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.change.event;
  }
  update(root, calls, maxDepth) {
    this.root = root;
    this.calls = calls;
    this.maxDepth = Math.max(0, Math.min(30, Math.floor(Number(maxDepth) || 0)));
    this.change.fire();
  }
  clear() { this.root = null; this.calls = new Map(); this.change.fire(); }
  getChildren(element) {
    if (!element) {
      if (!this.root) return [];
      const key = itemKey(this.root);
      return [{ item: this.root, key, ancestors: [key], id: key, depth: 0 }];
    }
    if (element.recursive || element.depth >= this.maxDepth) return [];
    return (this.calls.get(element.key) || []).map((call, index) => {
      const key = itemKey(call.to);
      return { item: call.to, key, ancestors: [...element.ancestors, key],
        id: `${element.id}/${index}:${key}`, depth: element.depth + 1, order: index + 1,
        recursive: element.ancestors.includes(key), kind: call.kind,
        callSite: call.callSite, fromUri: call.fromUri, parent: element };
    });
  }
  getParent(element) { return element.parent; }
  getTreeItem(element) {
    const vscode = this.vscode;
    const hasChildren = !element.recursive && element.depth < this.maxDepth && this.calls.get(element.key)?.length;
    const state = hasChildren ? (element.depth === 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const label = `${element.order ? `${element.order}. ` : ''}${element.item.name}`;
    const item = new vscode.TreeItem(label, state);
    item.id = element.id;
    item.contextValue = element.callSite ? 'callOccurrence' : 'callRoot';
    item.description = path.basename(element.item.uri.fsPath)
      + (element.callSite ? ` · call L${element.callSite.line + 1}` : '')
      + (element.recursive ? ' · recursive' : element.depth >= this.maxDepth ? ' · depth limit' : '')
      + (element.kind === 'qt' ? ' · Qt slot' : '');
    item.tooltip = `${element.item.uri.fsPath}:${element.item.selectionRange.start.line + 1}`
      + (element.callSite ? `\nCalled from ${element.fromUri.fsPath}:${element.callSite.line + 1}` : '')
      + (element.recursive ? '\nRecursive call: expand stopped here.' : '')
      + '\nSource order, not a runtime execution trace.';
    item.iconPath = new vscode.ThemeIcon(element.recursive ? 'references' : element.kind === 'qt' ? 'symbol-event' : 'symbol-method');
    item.command = { command: 'callScout.selectCall', title: 'Preview reachable code', arguments: [element] };
    return item;
  }
}
module.exports = { CallTreeProvider };
