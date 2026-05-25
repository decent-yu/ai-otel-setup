# Release Guide

This package is published by GitHub Actions. Do not run `npm publish` locally.

The workflow is `.github/workflows/publish.yml`. It runs when a `v*` tag is pushed, checks that the tag version matches `package.json`, then publishes to npm.

## 1. Update Version

Edit `package.json` and set the new version:

```bash
npm version 1.0.12 --no-git-tag-version
```

Or edit `package.json` manually.

## 2. Verify Locally

Run syntax checks:

```bash
node --check cli.js
node --check templates/on-session-start.js
node --check templates/codex/on-session-start.js
node --check templates/gemini/on-session-start.js
node --check templates/opencode/plugin.mjs
```

Run a dry pack check:

```bash
npm --cache /private/tmp/npm-cache-ai-otel pack --dry-run
```

Optional smoke test with a temporary home directory:

```bash
env HOME=/private/tmp/ai-otel-release-test node cli.js url=collector.example.test --debug
sed -n '1,120p' /private/tmp/ai-otel-release-test/.claude/cc-otel/endpoint.json
```

Confirm no private endpoint values were committed:

```bash
rg -n "PRIVATE_DOMAIN_OR_IP_PATTERN" .
```

Replace `PRIVATE_DOMAIN_OR_IP_PATTERN` with the real sensitive value before checking.

## 3. Commit

Check the diff:

```bash
git status --short
git diff --stat
git diff
```

Commit the release:

```bash
git add README.md cli.js package.json RELEASE.md
git commit -m "Release v1.0.12"
```

Adjust the file list if only some files changed.

## 4. Tag

Create a tag that exactly matches `package.json`:

```bash
git tag v1.0.12
```

Confirm the tag points at the release commit:

```bash
git log -1 --oneline
git tag --points-at HEAD
```

## 5. Push

Push the branch and tag:

```bash
git push origin main v1.0.12
```

If the branch pushes but the tag does not, push the tag separately:

```bash
git push origin v1.0.12
```

## 6. Confirm Remote State

Confirm GitHub has both `main` and the tag:

```bash
git ls-remote origin refs/heads/main refs/tags/v1.0.12
```

Both refs should point to the same commit.

## 7. Confirm GitHub Actions

Open the repository Actions page and check the `Publish to npm` run for the tag.

The workflow should:

1. Check out the tag.
2. Verify `vX.Y.Z` matches `package.json` version `X.Y.Z`.
3. Run `npm publish --provenance --access public`.

After the workflow succeeds, confirm npm:

```bash
npm view ai-otel-setup@1.0.12 version
```
