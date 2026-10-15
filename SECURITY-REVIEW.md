# CallScout 0.10.0 local security review

Reviewed 16 October 2026. Scope: all eight extension runtime modules, the webview script and SVG resource, package manifest, offline builder, and development/integration harnesses. Automated tests use mocks plus Apple clangd fixtures. This is a local source review, not an independent penetration test or vulnerability certification.

## Findings and changes

| Finding | Change | Evidence |
| --- | --- | --- |
| Unfinished C++ block comments/raw strings repeatedly retried matching and could stall analysis | Treat unfinished tokens as extending to end of input, in source masking and preview rendering | Regression covers 120–160 KB adversarial inputs. Local masking benchmark improved from 703/464 ms to 3/4 ms; timings are illustrative, not a bound |
| Lexical theme path checks could permit a symlink outside the installed theme folder | Resolve canonical root/file paths before checking containment | A real temporary symlink escape test verifies outside theme styles are not loaded |
| Configuration schema limits alone do not constrain malformed settings at runtime | Clamp traversal depth/function limits, tree depth and cursor debounce | Invalid-limit traversal regression passes |
| Qt indexing relied on its callers to provide local resources | Explicit local-file checks before Qt reads and in the index list | Remote-resource regression confirms no remote file is read |
| New breadcrumb navigation could retain stale offsets after edits | Invalidate breadcrumb/navigation state on edits/new analysis; accept current render and bounded integer index only | Escaped labels, repeated-branch selection, stale render and arbitrary-target rejection tested |

No additional code-execution or deliberate source-exfiltration path was found in the reviewed shipped code. That finding is limited to this review; it is not proof that all vulnerabilities are absent.

## Reviewed surfaces

- main.js: trust gate, source/symbol requests, decorations, configuration migration, events, pin/edit tracking, webview HTML/CSS and message handling. Messages cannot choose a command or destination. Local output can include sensitive paths/symbol names/errors.
- calls.js and graph.js: local-definition discovery, masking, cached queries, cycle handling and traversal limits. No source evaluation. Language providers are separately trusted and can be slow or privileged.
- call-tree.js, files.js and preview.js: identifiers/labels, parent paths, recursive expansion, dependency filters and reachable-line bounds. Tree rows and tooltips use text; webview names/paths are escaped.
- qt.js: raw-file index, modern/legacy/lambda/autoconnection parsing, exact/possible separation, source limits and local-resource access. Static matches are not runtime proof; generated/dynamic expressions remain approximate.
- syntax.js: theme includes, small JSON/XML parsing, scope matching and constrained CSS. Malformed rules are ignored. The parser does not expand XML entities or execute a grammar.
- resources/preview.js and glasses.svg: static code/assets with no remote includes. Only modifier-click coordinates or breadcrumb indices cross the message boundary.
- package.py/package.json: allowlisted runtime files, manifest identity/engine/trust capabilities and excluded build/test tooling. Official VSCE packaging is the release path.
- Development harness: clangd.integration.js intentionally launches /usr/bin/clangd and reads selected fixtures. It is not shipped; run it only on approved fixtures/toolchains. Tests use local temporary files and VM mocks, and do not represent a production sandbox.

## Local checks and package status

- 50 unit/regression tests passed, including webview injection rejection, document-version checks, local navigation, restricted workspace activation, pinned-root navigation/edit tracking, symlink containment and scanner edge cases.
- Real Apple clangd member-call fixture and Qt-shaped QObject-stub fixture passed. Warm repeat traversal made zero provider requests.
- Official @vscode/vsce 4.0.0 packaging passed with --no-dependencies and the documented --allow-missing-repository metadata exception. Secret allowances, environment-file allowances and license skips were not used.
- The isolated packaging-tool lockfile's npm advisory audit reported zero known advisories at review time (optional packages omitted from that audit). This is not a runtime dependency audit: the shipped package has no third-party runtime packages.
- Extracted VSIX contents and source/resource equality are checked, and hashes/component inventory are supplied separately. Hashes are integrity records, not signatures.

## Remaining limits

No Windows desktop smoke test, live UI regression pass, real Qt runtime test, enterprise endpoint/antivirus scan, independent SAST review, Microsoft server-side scan, Marketplace signature or publisher ownership validation has been completed. The package has not been published. Official tool validation alone does not complete Marketplace acceptance.

VS Code extensions inherit VS Code permissions. Filesystem symlinks/mounted volumes, language-server behaviour, concurrent filesystem changes and compromised installed extensions/publisher credentials are outside this extension's isolation guarantees. Input limits do not provide a hard CPU/memory sandbox; opening source documents can still consume substantial memory. Static call analysis can be incomplete, and highlights are not evidence that dimmed code is safe to remove.

For release/IT approval steps and official sources, see RELEASE.md. Exact version, package hash and independent approval should identify what is permitted on a work PC.

## Repository import

The GitHub import adds repository/issue/homepage metadata and a build-from-source README. Runtime source is unchanged from the reviewed local 0.10.0 package. The original local package validation used a missing-repository metadata exception; validate new repository builds without that exception. Original VSIX hashes/components are not represented as repository build hashes. No release tag or Marketplace publication is implied by this import.
