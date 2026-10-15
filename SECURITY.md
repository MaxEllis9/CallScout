# Security and privacy

This is an early local extension. No release has independent security certification or Marketplace acceptance. A clean local review cannot guarantee that vulnerabilities are absent.

## Runtime behaviour

CallScout reads C/C++ source and UI files, queries the installed VS Code language provider, displays source in a restricted webview, reads the active installed theme, and applies editor decorations. It does not execute project source, build commands, tasks, shells or external programs. It contains no network client, telemetry, automatic downloader, native executable or third-party runtime package.

Analysis caches, pinned roots and navigation state stay in extension-host memory. The CallScout output channel includes local paths, symbol names, timings and error messages; those logs may be sensitive and should be reviewed before sharing. CallScout does not export source or create trace files. VS Code, language servers, theme extensions, Settings Sync and other extensions have their own behaviours and require separate approval.

The extension changes only its own/legacy settings through VS Code APIs: dependency filters and old-setting migration. Migration preserves explicit new settings and removes migrated legacy values. User settings can sync if the user enables VS Code Settings Sync.

## Boundaries and safeguards

- Restricted Mode/virtual workspaces are unsupported; activation requires a trusted workspace.
- Source/navigation resources must be local file URIs; authority/UNC and remote URI schemes are rejected. Local symlinks and mounted drives are not a filesystem sandbox.
- Source text, paths and breadcrumb labels are HTML escaped. Script execution requires a random nonce. The webview blocks command URIs and resource roots, has default-deny CSP, and accepts only current-render symbol coordinates or a validated breadcrumb index. It cannot supply target paths or command names.
- Symbol clicks validate original displayed lines, integer character offsets, document version and local definition destinations. Breadcrumb state is invalidated by source edits or a new analysis.
- Theme paths are canonicalised before folder checks; executable grammars, XML entities and remote theme content are not evaluated. Theme CSS values are constrained.
- Traversal, per-function call queries, preview size and Qt source indexing have limits. These limits are not a hard CPU/memory sandbox; source documents and language-server responses can still be large or slow.
- Packages contain an explicit source/resource allowlist. Tests, integration subprocess tooling, project files and release credentials are excluded.

VS Code extensions run with the user's privileges. These application checks do not isolate a malicious language server, another extension, a compromised publisher account or modified installed package.

## Reporting and maintenance

For this unpublished release, report an issue privately to the person who supplied the package or your IT security team. Do not include company source, credentials, unrestricted logs or exploit details in public issues. Before public release, configure a real private vulnerability-reporting channel and add its URL here.

Maintain a supported-release list and issue a new version for each fix. Keep VS Code and the approved language provider updated. Review every runtime dependency addition and every change to filesystem access, webview messages, authentication or network/process behaviour. Distribute fixes through the approved release channel with new hashes; do not silently replace a published version.
