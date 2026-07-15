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

- [ ] Decide whether to keep the unscoped name `claude-codex-router` or move to a personal/org scope such as `@alex-moroz/claude-codex-router`.
- [ ] If using a scope, create or verify the npm user/org scope.
- [ ] Add real `repository`, `homepage`, and `bugs` fields after the public GitHub repo exists.
- [ ] Review the README for public wording and screenshots.
- [ ] Log in to npm: `npm login`.
- [ ] Confirm account: `npm whoami`.
- [ ] Re-run `npm test`.
- [ ] Re-run `npm pack --dry-run`.
- [ ] Publish:

```bash
npm publish
```

For a scoped public package, publish with:

```bash
npm publish --access public
```

## Post-publish smoke test

```bash
npx claude-codex-router doctor
npx claude-codex-router start
```

For a global install:

```bash
npm i -g claude-codex-router
claude-codex-router install
claude-codex-router doctor
```
