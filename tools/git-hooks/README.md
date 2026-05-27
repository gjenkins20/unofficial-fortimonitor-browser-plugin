# Git hooks

Committed git hooks for this repo, activated through `core.hooksPath` rather
than the per-clone `.git/hooks/` directory so they travel with the repo.

## Activation

The root `package.json` `prepare` script points git at this directory on
`npm install`. To wire it up by hand (once per clone):

```sh
git config core.hooksPath tools/git-hooks
```

## Hooks

- **`pre-commit`** (FMN-248) - runs `tools/dev/sync-readme-version.mjs --check`
  when `extension/manifest.json` or `README.md` is staged, blocking a commit
  that would let the README's "Current version" line drift from the manifest
  version. Bypass a single commit with `git commit --no-verify`.
