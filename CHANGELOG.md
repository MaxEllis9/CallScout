# Changelog

## 0.10.2

- Populate source files as each function body resolves, without waiting for every call in its caller.
- Keep four call sites in flight instead of waiting for fixed batches; preserve source order and repeated calls.
- Retain the existing traversal limits and reconcile partial results at completion.

## 0.10.1

- Provide a prebuilt VSIX through GitHub Releases, with a SHA-256 checksum.
- Expand Windows/macOS source-build, installation and troubleshooting instructions.
- Add repository metadata; runtime code is unchanged from 0.10.0.

## 0.10.0

- Pin the starting function while exploring other definitions; release it to follow the cursor.
- Click call-path breadcrumbs to return to an ancestor and its tree occurrence.
- Open the original call site from a tree row; refresh or collapse the tree from its toolbar.
- Bound traversal settings at runtime, reject non-local Qt reads, and resolve theme symlinks before checking paths.
- Treat unfinished comments and raw strings as extending to end of input, avoiding repeated scanner retries.
- Use an explicit runtime file allowlist for both offline and official VS Code packaging.

## 0.9.0

- Add a source-ordered nested call tree with filenames, repeated calls and recursion markers.

## 0.8.0

- Rename to CallScout, add modifier-click definition navigation and initial static Qt signal/slot support.
