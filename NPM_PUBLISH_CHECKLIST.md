# npm publish checklist

## Done locally

- [x] Package is no longer marked private.
- [x] Package has a CLI entrypoint: `claude-codex-router`.
- [x] Package metadata includes description, license, keywords, Node engine, and macOS OS constraint.
- [x] Package uses an explicit `files` whitelist so generated downloads, backups, and local artifacts are not published.
- [x] CLI supports `start`, `install`, `uninstall`, `open`, `doctor`, and `build-portable`.
- [x] Install command has no npm `postinstall` side effects; local system changes happen only after an explicit user command.
- [x] Existing Node test suite passes locally.
- [x] `npm pack --dry-run` has been checked.

## Human steps before first publish

- [x] Package name is scoped as `@alex_moroz/claude-codex-router`.
- [ ] Verify the npm account can publish under the `@alex_moroz` scope.
- [ ] Add real `repository`, `homepage`, and `bugs` fields after the public GitHub repo exists.
- [ ] Review the README for public wording and screenshots.
- [ ] Log in to npm: `npm login`.
- [ ] Confirm account: `npm whoami`.
- [ ] Enable npm 2FA for publishing or prepare a granular access token that can publish.
- [ ] Re-run `npm test`.
- [ ] Re-run `npm pack --dry-run`.
- [ ] Publish:

```bash
npm publish --access public
```

If npm asks for a one-time password or returns `E403 Two-factor authentication ... is required`, publish with the current authenticator code:

```bash
npm publish --access public --otp=123456
```

## Post-publish smoke test

```bash
npx @alex_moroz/claude-codex-router doctor
npx @alex_moroz/claude-codex-router start
```

For a global install:

```bash
npm i -g @alex_moroz/claude-codex-router
claude-codex-router install
claude-codex-router doctor
```
