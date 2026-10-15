# Release and workplace installation

Prepared 16 October 2026 for CallScout 0.10.0. This document recommends a process; it does not represent employer approval or completed Marketplace publication.

## Recommended hosting

The source is prepared for https://github.com/MaxEllis9/CallScout. Keep it private initially; configure a protected main branch, reviewed pull requests and versioned release tags. Keep the extension in its own repository rather than a client/project repository. Store source, tests, the packaging-tool lockfile, changelog and security documents together. Do not include company source files, compile databases, credentials or local development artifacts.

For the first work-PC installation, give IT the reviewed source archive, exact VSIX, SHA-256 checksum, SECURITY.md and SECURITY-REVIEW.md. Ask IT to scan and distribute the exact approved version through its existing software deployment or internal artifact system. Do not bypass an extension allowlist or signature policy. A hash checks integrity against a trusted expected hash; it does not authenticate the publisher.

If IT permits public distribution, use a publisher account you control on the Visual Studio Marketplace and let IT allow that exact extension/version. Microsoft documents version allowlisting and a private marketplace option; the latter currently requires eligible enterprise accounts. [Enterprise extension management](https://code.visualstudio.com/docs/enterprise/extensions)

The current ID is local-dev.callscout. local-dev is only a local development identity, not proof of Marketplace account ownership. Before public release, register a real publisher, set publisher in package.json, and plan the one-time uninstall/reinstall if that changes the extension ID. Add the real repository, homepage, issue URL and private vulnerability-reporting channel. Add a PNG listing icon if desired; the bundled glasses SVG is a VS Code activity-bar asset, not the Marketplace icon.

## Reproducible build inputs

Runtime has no npm dependencies. Build tools are isolated in tools/package.json and tools/package-lock.json, with @vscode/vsce pinned to 4.0.0. Use an approved current Node.js version satisfying that tool's engines. Install build tools only on a development/CI machine:

```sh
npm ci --prefix tools --ignore-scripts --no-fund
npm test
node tools/node_modules/@vscode/vsce/vsce ls --no-dependencies
node tools/node_modules/@vscode/vsce/vsce package --no-dependencies
```

The original local 0.10.0 package used --allow-missing-repository as a metadata exception. The repository source now includes the actual repository URL, so new builds should omit that flag and require clean package validation. The README and manifest metadata differ from the original reviewed local VSIX; use a new version and a new review/checksum before distributing a new release. Do not use the allow-package-secrets or allow-package-env-file options.

The manifest files allowlist excludes development scripts, tests, tools, source archives, credentials and unrelated projects. The Python offline builder uses the same list; it does not run official VSCE checks, so use the official build for releases. ZIP metadata may vary between builds: compare extracted file contents, not only whole-archive bytes.

On Windows after an approved download, compare the hash with the trusted release record:

```powershell
Get-FileHash .\callscout-0.10.0.vsix -Algorithm SHA256
```

Install only by the method IT approves. When sideloading is explicitly allowed, use Extensions: Install from VSIX and reload VS Code. Retain the last approved VSIX for rollback. The VSIX produced locally is unsigned; do not claim it carries a Marketplace signature.

## Release gates

1. Review the full diff and run unit/security regression tests on Windows and macOS. Smoke-test real VS Code with approved clangd, source navigation, pinning, filters, large projects and light/dark/high-contrast themes. Add a real Qt test project before claiming comprehensive Qt support.
2. Run a source/secret scanner, dependency advisory checks for build tools and any future runtime dependencies, and your organization's malware/endpoint scan on the exact VSIX. Keep scan output and tool versions with the release. Local VSCE secret checking is not a substitute for those checks.
3. Package from a reviewed tag using the locked build tools. Inspect the extracted file list, compare every runtime file with that tag, create SHA-256 hashes and retain a component inventory. Use immutable release assets and restricted release permissions.
4. Require release approval; publish only the reviewed artifact. Use least-privilege publishing credentials. Microsoft's current guidance recommends Entra ID workload identity federation rather than long-lived secrets. [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
5. Allow IT to approve/pin the release, including the language provider. Keep an issue tracker, private security-reporting route, supported-version policy and rollback instructions. Recheck advisories before releases and periodically, and promptly assess new reports. Do not silently overwrite an approved version.

## Marketplace and standards

Microsoft applies server-side malware, runtime-behaviour and secret checks, and signs published packages. These checks have not run on CallScout because it has not been submitted. Marketplace publication and a verified-publisher badge do not certify the absence of vulnerabilities or grant workplace installation permission. [Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)

NIST's Secure Software Development Framework is useful guidance for protecting source/builds, reviewing code, verifying releases and responding to vulnerabilities. It is not a VS Code extension acceptance test or a certification achieved by this local review. [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)

The outstanding release gates are a real Marketplace publisher, repository access/release controls, Windows and live UI validation, organization-approved scanning/review, and actual Marketplace acceptance if that distribution route is chosen.

## First GitHub release: 0.10.1

Version 0.10.1 packages the repository metadata and expanded installation/build documentation. Runtime JavaScript and resources are unchanged from the reviewed 0.10.0 local release. The GitHub release provides the VSIX and SHA-256 checksum; GitHub-generated source archives are available from the same tag. This distribution is not a Marketplace signature or employer approval.
