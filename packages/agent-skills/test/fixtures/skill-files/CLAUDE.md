# Skill Files Test Fixture

This fixture tests the `files` config and content-type routing features.

## Structure

- `docs/guide.md` — Normal markdown resource (stays in resources/)
- `build-artifacts/` — Source files for build artifacts (committed to git)
- `pre-build/` — Clean checkout variant (no build artifacts)
- `post-build/` — After build variant (committed files only)

## Build Artifact Convention

Real projects gitignore `dist/` and `node_modules/`. Test fixtures must not
use gitignored directory names for committed files. Instead:

- **Committed source**: `build-artifacts/bin/cli.mjs` (checked into git)
- **Test setup simulates build**: copies to `tempDir/dist/bin/cli.mjs`
- **files config references**: `source: 'dist/bin/cli.mjs'` (realistic path)

This mirrors a real project where `npm run build` produces `dist/bin/cli.mjs`
and `vat skills build` copies it via the `files` config.

## How to Add Test Cases

1. Add committed files to `post-build/` or `build-artifacts/`
2. Reference them from a SKILL.md via a link
3. If it's a build artifact, put the source in `build-artifacts/` and
   have the test setup copy it to `dist/` in the temp dir
4. Add a corresponding test in `skill-files.integration.test.ts`
