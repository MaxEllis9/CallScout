'use strict';

function itemKey(item) {
  const uri = item.uri && (typeof item.uri.toString === 'function' ? item.uri.toString() : String(item.uri));
  const r = item.selectionRange || item.range;
  return `${uri}:${r.start.line}:${r.start.character}:${item.name}`;
}

/** Breadth-first traversal. Adapter returns an array of {to: CallHierarchyItem}. */
async function walkOutgoing(root, outgoing, maxDepth, maxFunctions, onVisit = async () => {}, onCalls = () => {}) {
  maxDepth = Math.max(0, Math.min(30, Math.floor(Number(maxDepth) || 0)));
  maxFunctions = Math.max(1, Math.min(10000, Math.floor(Number(maxFunctions) || 500)));
  const queue = [{ item: root, depth: 0, via: null }];
  const scheduled = new Set([itemKey(root)]);
  const nodes = [];
  const errors = [];
  let truncated = false;
  while (queue.length) {
    if (nodes.length >= maxFunctions) { truncated = true; break; }
    const next = queue.shift();
    const key = itemKey(next.item);
    nodes.push({ ...next, key });
    await onVisit(nodes[nodes.length - 1]);
    if (next.depth >= maxDepth) continue;
    try {
      const calls = await outgoing(next.item) || [];
      const valid = calls.filter(call => call?.to);
      onCalls(next.item, valid);
      for (const call of valid) {
        const targetKey = itemKey(call.to);
        if (!scheduled.has(targetKey)) {
          scheduled.add(targetKey);
          queue.push({ item: call.to, depth: next.depth + 1, via: key, kind: call.kind });
        }
      }
    } catch (error) {
      errors.push({ key, message: String(error && error.message || error) });
    }
  }
  return { nodes, errors, truncated };
}
module.exports = { walkOutgoing, itemKey };
