# Publishing

This directory is a standalone npm package and should be the root of the public
GitHub repository `ytmaps/dsh-flowtext`.

## Before the first release

1. Confirm that the public GitHub repository URL exactly matches the
   `repository.url` in `package.json`.
2. Use Node.js 24 and run `npm ci`, `npm test`, and `npm run pack:check`.
3. Confirm that `dsh-flowtext` is still available on npm.
4. Sign in to npm with publishing 2FA and publish the current version once from the public
   repository checkout:

   ```sh
   npm publish --access public
   ```

The package allowlist in `package.json` is authoritative. `npm pack --dry-run`
must show only the license, documentation, Bundle patch, compiled entry points,
type declarations, and package metadata.

## Trusted releases after bootstrap

In the npm package settings, add a GitHub Actions trusted publisher with:

- repository: `ytmaps/dsh-flowtext`
- workflow: `publish.yml`
- environment: leave unset

The repository's `publish.yml` requests `id-token: write` and publishes from a
GitHub-hosted runner without a long-lived npm token. Publishing a GitHub Release
then runs the full verification suite and publishes the package with npm
provenance. Keep the repository public so provenance can link the artifact to
its source.

For each later release, update `version` in both `package.json` and
`package-lock.json`, verify locally, publish the matching GitHub Release, and
confirm the npm package version and provenance after the workflow completes.
