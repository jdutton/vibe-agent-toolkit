# Skill Files Test Fixture

This fixture tests the `files` config and content-type routing features.

## Structure

- `docs/guide.md` — Normal markdown resource (stays in resources/)
- `pre-build/` — Clean checkout variant (no build artifacts)
- `post-build/` — After build variant (has build artifacts)

Note: `.sh` files are forbidden in this repository (no-shell-scripts rule). Use `.mjs` for
script fixtures to test script content-type routing (`scripts/` subdirectory).

## How to Add Test Cases

1. Add the file to the appropriate variant
2. Reference it from a SKILL.md via a link
3. If it's a build artifact, add a `files` entry in config
4. Add a corresponding test in `skill-files.integration.test.ts`
