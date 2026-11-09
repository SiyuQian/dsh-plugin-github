# npm releases and native DSH version checks

## Package identity

Publish only **`@siyuqian/dsh-plugin-github`** to **`https://registry.npmjs.org/`**, with public access. The unscoped npm package `dsh-plugin-github` is owned by another publisher; never use it as a registry installation or publishing target for this repository. The GitHub repository URL is unchanged.

The scoped package starts from repository version **0.8.0**. This preparation does not publish it or bump it. Before a future release, check the scoped registry history and choose an unused semver version. Increment the version for each later release; DSH lists only versions newer than the installed version.

The Cordis row stays `github`. Existing RPC names, `githubPrLinks`, locale namespaces, CSS IDs and review-workspace state stay unchanged. The browser ModuleLoader ID must equal the scoped manifest name; it is not a storage key. The package retains its description and in-app locale dictionaries, and exports English/Chinese inventory metadata plus an original MIT-licensed SVG icon.

## Prepare and inspect locally

Use Node and npm from your development environment. In a DSH-managed agent environment, use the Node and pnpm paths returned by `load_workspace_dependencies` if invoking pnpm.

```sh
node --test test.mjs
node --check lib/index.js
node --check lib/client.js
node --check lib/review.js
git diff --check
npm pack --dry-run --json --ignore-scripts
```

There is no compilation step: `lib/` contains the maintained distributable JavaScript. Check that the dry-run includes `lib/index.js`, `lib/client.js`, `lib/review.js`, `package.json`, `cordis.patch.yml`, both `locale/*.json` files, `icon.svg`, README, this guide and LICENSE. No credentials, workspace records, test files, vendored skills or `node_modules` belong in the package. Verify the scoped name, public `publishConfig`, resource exports and unchanged row ID. Do not use a dry-run as evidence of npm authentication, ownership or publication.

## Publish later — separate authorization required

The current handoff reports npm authentication **E401**. No credentials were read or changed, and publication is blocked until the publisher independently restores npm access and verifies control of `@siyuqian`. Do not put tokens in source files or chat. Publication, commits, pushes and profile migration are not part of release preparation.

Only after explicit release approval, valid npm access, review and successful checks:

```sh
npm publish --access public --registry=https://registry.npmjs.org/
```

This command is a future manual step, not an instruction to run during preparation. Inspect the resulting scoped registry version before asking users to install it. Keep the tested-runtime statement in README: this release preparation does not establish compatibility beyond it. No new DSH version range is inferred from unit tests.

## Install through DSH, not profile file edits

After publication, use **Plugins > Add plugin** with `@siyuqian/dsh-plugin-github@<published-version>` and choose the public npm registry. An authorized agent can use native `plugin_manager` installation with the same scoped target and registry. This changes the profile and must be a separate user-approved operation. Do not run npm/pnpm in the profile or hand-edit its manifest or patch to migrate.

For an existing unscoped Git/path installation (for example GitHub 0.6.2 enabled):

1. Record its source, version, enabled state and configured prompt values through DSH. Back up user data outside this preparation task. Repository 0.8.0 no longer bundles skills; separately provide `pr-creator`, `pr-review` and `pr-explain`, or configure available equivalents.
2. After publication is verified, use DSH's normal removal flow for the old bundle before installing the scoped one. Both bundles declare row `github`; do not select them together. If the runtime requires stopping or restarting, follow its result.
3. Install the scoped registry package through DSH and restore the previous enabled state and prompt settings through supported controls. An old module-name assertion can refer to the unscoped name: the unchanged row ID alone does not guarantee configuration migration.
4. Confirm exactly one `github` row, the expected source/version and enabled state, metadata/icon, PR links and review data. Do not delete existing state. If replacement fails, use the recorded trusted Git/local source for rollback, never the unrelated unscoped npm package.

## Native version-check acceptance

No custom updater, polling service or GitHub workflow is needed. DSH's Plugin Manager owns version discovery and updates:

- The bundle must be a third-party profile dependency installed from npm **under its own scoped name**, with a semver version and `dsh.bundle.patch`. Local paths, Git URLs, tarballs and `npm:` aliases do not qualify for the native registry update list.
- Open the installed bundle's version/update control on the Plugins page. The native contract is `pluginManager.listVersions('@siyuqian/dsh-plugin-github', { registry: 'https://registry.npmjs.org/' })`. This is a documented service contract, not an Inspect method or a new plugin API call to add here.
- A successful lookup lists only newer versions, with tags, prerelease/deprecation and compatibility information. A successful empty list means there are no newer releases; `not-updatable`, `not-found`, network or authentication errors are not that result.
- For a later approved upgrade, DSH's `updateBundle` rechecks the exact newer version's bundle declaration and DSH requirements and preserves the enabled selection. Respect compatibility refusals; do not grant version exemptions as a release shortcut. Follow any restart requirement and verify the loaded version after restart.

A registry install and later newer scoped publication are required to exercise this end to end. Neither publication, profile replacement, rendered icon validation nor a live npm version-check result was performed by this preparation.
