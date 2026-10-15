'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const request = Number(document.currentScript.dataset.request);
  const code = document.querySelector('.code');
  document.addEventListener('mousemove', event => {
    code.classList.toggle('navigate', event.metaKey || event.ctrlKey);
  });
  document.addEventListener('keyup', () => code.classList.remove('navigate'));
  window.addEventListener('blur', () => code.classList.remove('navigate'));
  document.addEventListener('click', event => {
    if (event.button !== 0) return;
    const step = event.target.closest('[data-step]');
    if (step) { vscode.postMessage({ type: 'breadcrumb', request, index: Number(step.dataset.step) }); return; }
    if (!(event.metaKey || event.ctrlKey)) return;
    const source = event.target.closest('.source');
    if (!source) return;
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!caret || !source.contains(caret.startContainer)) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(source);
    prefix.setEnd(caret.startContainer, caret.startOffset);
    event.preventDefault();
    vscode.postMessage({ type: 'definition', request,
      line: Number(source.parentElement.dataset.sourceLine), character: prefix.toString().length });
  });
})();
