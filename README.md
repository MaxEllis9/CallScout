# CallScout

A VS Code extension for exploring reachable C/C++ code. Current source version: **0.10.2**.

Follow C/C++ calls from the function under your cursor. CallScout keeps discovered function bodies bright, dims other code, and previews only reachable definitions in a selected file.

## Download the built extension

The easiest installation method is to download **`callscout-0.10.2.vsix`** from the [latest GitHub release](https://github.com/MaxEllis9/CallScout/releases/latest). Under **Assets**, choose the `.vsix` file, rather than GitHub's **Source code** ZIP/TAR downloads. The release also includes `SHA256SUMS.txt` for checking the download's integrity.

In VS Code, open the Command Palette (**Ctrl+Shift+P** on Windows / **Cmd+Shift+P** on macOS), run **Extensions: Install from VSIX...**, choose the downloaded file, then run **Developer: Reload Window**. You do not need Node.js, npm, Git or any build tools on that computer. You still need an approved C/C++ language provider such as clangd for symbol analysis.

If this repository is private, sign in to GitHub with an account that has access. On a work computer, follow your IT team's approved download and installation process. The GitHub release is a locally built, unsigned VSIX; it has not been published or signed by the Visual Studio Marketplace.

## Build a VSIX from source

A `.vsix` is the installable VS Code extension package. You can build it on your personal computer and transfer just that file to another computer through an approved channel. The computer where you install CallScout does not need Node.js, npm, Git or the packaging tools.

### 1. Install the build requirements

On the computer that will build the package, install:

- **Node.js 22 or newer**, preferably a supported LTS release, from [nodejs.org](https://nodejs.org/). npm is included with Node.js.
- **Git**, if you want to clone the repository. Alternatively, download the source ZIP as described below.

No C++ compiler, Qt or JUCE installation is needed to package the extension. Internet access is needed to download the source and install the packaging tool. CallScout itself has no third-party npm runtime dependencies.

Open **PowerShell on Windows** or **Terminal on macOS** and check:

```sh
node --version
npm --version
```

The Node.js version should be `v22.x.x` or newer. Reopen your terminal after installing Node.js if either command is not found.

### 2. Download the source

Using Git, run:

```sh
git clone https://github.com/MaxEllis9/CallScout.git
cd CallScout
```

Alternatively, open the [repository](https://github.com/MaxEllis9/CallScout), choose **Code → Download ZIP**, extract it, and open a terminal in the extracted `CallScout-main` folder. For a private repository, sign in with an account that has access; Git cloning also requires GitHub authentication.

For every command below, use the repository's **top-level folder**: it contains `package.json`, `README.md`, `extension` and `tools`. Do not run the commands from inside `extension` or `tools`.

### 3. Test and build

The following commands work in Windows PowerShell and macOS Terminal:

```sh
npm test
npm ci --prefix tools --ignore-scripts --no-fund
node tools/node_modules/@vscode/vsce/vsce package --no-dependencies
```

- `npm test` runs the automated tests. Fix any failures before distributing a build.
- `npm ci` installs the exact packaging-tool dependencies recorded in `tools/package-lock.json`, into `tools/node_modules`. `--ignore-scripts` disables dependency installation scripts.
- The final command uses Microsoft's VS Code extension packager to create the VSIX. It packages the explicit runtime file allowlist, excluding tests and build tools. You do not need a Marketplace publisher account, global `vsce` installation, or publishing token to build locally.

On success, the terminal prints **Packaged**, followed by the output path. The file appears in the top-level repository folder:

```text
callscout-0.10.2.vsix
```

The filename uses the version in `package.json`, so it will change when the extension version changes. The package has no platform-specific native binaries and is intended for both Windows and macOS; a live Windows smoke test remains outstanding.

**Windows PowerShell tip:** if PowerShell reports that `npm.ps1` cannot run because scripts are disabled, use `npm.cmd test` and `npm.cmd ci --prefix tools --ignore-scripts --no-fund` instead. The final `node` command stays the same. You do not need to change PowerShell's execution policy.

### 4. Install the VSIX

On the computer where you want to use CallScout:

1. Open VS Code 1.85 or newer.
2. Open the Command Palette with **Ctrl+Shift+P** on Windows or **Cmd+Shift+P** on macOS.
3. Run **Extensions: Install from VSIX...** and select the generated `.vsix` file.
4. Run **Developer: Reload Window** to activate the installation or update.
5. Install/configure an approved C/C++ language provider such as clangd, and open a trusted C/C++ project. For clangd, provide the project's `compile_commands.json` so definitions can resolve correctly.

On a managed work computer, get IT approval for the exact extension version and installation method first. A public GitHub repository or successful local build does not grant workplace approval. No release is currently published on the Marketplace. See [security and privacy](SECURITY.md), [local review](SECURITY-REVIEW.md) and [release process](RELEASE.md).

### Common build problems

- **`package.json` not found:** change into the top-level source folder before running the commands.
- **Cannot find the `vsce` module:** complete the `npm ci --prefix tools --ignore-scripts --no-fund` step, then retry packaging from the top-level folder.
- **Dependency download fails:** check your network/proxy configuration or use your organisation's approved npm registry. Keep the lockfile and security checks intact.
- **GitHub reports “Repository not found”:** if the repository is private, check that you are signed in with an account that has access. Downloading a ZIP through the signed-in browser is an alternative to configuring Git authentication.
- **Installed update is not visible:** reload the VS Code window and check the installed CallScout version in the Extensions view.

## Install and upgrade

Install/configure clangd with your project's `compile_commands.json`. Install `callscout-0.10.2.vsix` using **Extensions: Install from VSIX...**, then reload the VS Code window. Requires VS Code 1.85 or newer. The universal package has no native binaries or third-party runtime packages; Windows still needs a live smoke test.

This release replaces the old C++ Reachability Lens extension with **local-dev.callscout**. Remove the old installation to avoid running two scanners. The commands, settings, views, output channel and package now use CallScout naming. Existing configured settings are copied to `callScout.*` at their original user/workspace/folder scope, preserving any explicit new settings, then the legacy values are removed.

## Call tree

**Call Tree · Source Order** shows the starting function with nested called functions and filenames beside them. Calls are numbered in their source order within each function. Expand a function to inspect its calls; select it to preview its reachable code. Repeated calls remain separate, shared callees can appear under multiple parents, and recursion is marked and stops expanding.

This is a static outline, not a runtime trace: branches, loops, argument evaluation, callbacks and queued Qt slots can execute differently. The tree shares the existing bounded, cached analysis. Expanding nodes makes no language-server requests. The configured depth/function limits still apply; a discovered function may have no children when its scan was limited or unresolved.

Use the pin button in the Call Tree toolbar to hold the starting function while navigating to other files. The title says **Pinned: function**; click the pinned button to follow the cursor again. Pins last for this window session, track edits before the function, and are released if the pinned identifier is replaced or the function can no longer be identified. **Highlight From Enclosing Function** explicitly selects a new root.

Selecting a tree function shows a clickable call-path breadcrumb above its preview and selects that same tree occurrence. The inline **Open Call Site** action jumps to the caller's source line. Pin the root first if you want to navigate in the editor without changing the analysis. The toolbar also provides **Refresh Analysis** and **Collapse All**.

## Preview and navigation

File rows show a filename and its workspace-relative folder. Full paths and reachable-function counts appear in tooltips. Select a file or function to preview reachable bodies in that file, with original line numbers and separators where unrelated code was omitted. Headers appear only when they contain discovered function definitions.

**Cmd-click on macOS / Ctrl-click on Windows** on a symbol in the preview to resolve and open its definition. Normal clicks select text. Multiple definitions open a chooser; unresolved symbols do nothing. Navigation uses the existing language server and adds no background lookup work to rendering.

The preview uses the installed theme's token colours and editor font settings. Its small C++ lexical highlighter does not reproduce the full VS Code grammar/semantic pipeline, so some colours may differ.

## Dependency filters and performance

The library toolbar button toggles all dependencies. The filter button selects specific folders such as JUCE or Qt. Hidden dependencies are not traversed. Enable one when you need its paths.

Up to four call sites resolve concurrently. A finished lookup immediately frees its slot for the next call, so a slow lookup does not block an entire batch. Confirmed definitions enter the file list as soon as they resolve, before the caller finishes scanning. Unchanged documents, symbols and call results are reused across root changes; edits, file changes and manual refresh invalidate results. Cursor debounce defaults to 120 ms. Cold language-server parsing can still take time; results appear progressively.

Commands are available under **CallScout** in the Command Palette. Settings use `callScout.*`: `autoUpdate` (true), `debounceMs` (120), `maxDepth` (8), `maxFunctions` (500), `dimOpacity` (0.65), `dependencyFolders`, `includedDependencyFolders`, `showDependencies` (false), and `qtSupport` (true).

## Qt signals and slots

This is an initial static Qt implementation, tested with fixtures rather than a real Qt project/runtime.

- Function-pointer `connect()` expressions, including overload selectors, are resolved through the language server.
- A connection only enters the reachable graph when the signal symbol matches, the registration resolves to QObject, and a same-`this` registration precedes emission in the same straight-line function scope. The slot body or lambda body is then traversed. This is a static match, not a promise of runtime execution.
- Other registrations appear in **Possible Qt Connections** with an explanation. This includes uncertain object identity/lifetime, conditional or queued registrations, legacy `SIGNAL()` / `SLOT()` names, unresolved dynamic endpoints, lambdas, and `connectSlotsByName()` candidates.
- Automatic candidates follow `on_<objectName>_<signalName>` names when automatic registration or a `.ui` file is found. Runtime object names and generated setup are not verified. Legacy names and overloads may have multiple candidates.
- Selecting a possible connection opens its target, or its registration when the target cannot be resolved. Possible targets are not silently added to reachable highlights.

The Qt registration index is lazy and cached. It is bounded to 1,000 included workspace source/UI files, 512 KiB per file and approximately 8 MiB of text, with output messages for index limits. Registrations outside included source folders, unsupported C++ expressions, generated/dynamic connections, runtime disconnects and object destruction can leave paths unknown. The extension never runs Qt code or assumes that finding a registration proves it is active.

## Security and limits

The shipped extension has no telemetry, network requests, subprocesses, shell execution, source evaluation, or automatic downloads. It uses VS Code configuration APIs for requested settings/migration and delegates symbol queries to the installed language server. That server and other extensions have their own security properties. A VS Code extension runs with the user's privileges; this review is not certification or a guarantee of zero vulnerabilities.

Untrusted/virtual workspaces and remote/UNC resources are unsupported. Local paths can still refer to mounted volumes or symlinks; this is not a filesystem sandbox.

The webview permits only its own nonce-authorised navigation script. Command URIs, local resource roots and external resources are disabled. Source text is HTML-escaped, font CSS/colours are validated, and the extension validates the current render ID, displayed source line, character position, document version and local destination before navigating. The webview cannot provide a destination URI or choose an editor command.

Direct scans inspect at most 256 call sites per function and skip functions above 1 MiB. Preview rendering is limited to 2,000 lines / 256 KiB. Theme reads are bounded and checked against the canonical installed theme folder, including symlinks. Discovery is approximate: dimmed code means not discovered, not proven unreachable.

## Development and verification

Run `npm test` with Node.js; no dependency installation is needed. Tests cover source-order call trees, repeated/shared calls and recursion, graph traversal/caching, reachable-only previews, dependency filters, theme parsing, injection/navigation rejection, modifier-click handling, setting migration and Qt connection classification.

`extension/clangd.integration.js` checks real Apple clangd 17 using a member-call fixture, a Qt-shaped C++ fixture with QObject stubs, and FlowerPower's `processBlock`. The stub fixture verifies language-server integration without claiming Qt runtime coverage. Integration tests are excluded from the VSIX.

Package offline using `python3 package.py` on macOS or `py -3 package.py` on Windows. The explicit package allowlist includes only runtime source, resources, manifest, README and licence.

For workplace approval, review `SECURITY.md` and `RELEASE.md`. The local VSIX is unsigned and has not undergone Marketplace server-side scanning.
