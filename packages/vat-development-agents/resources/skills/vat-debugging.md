---
name: vibe-agent-toolkit:debugging
description: >-
  Debug unexpected VAT behavior, reproduce bugs, test local vibe-agent-toolkit
  changes in adopter projects (VAT_ROOT_DIR), write failing tests before fixing,
  and validate fixes with the full build pipeline before publishing
---

# Debugging & Testing VAT Fixes

Use this skill when VAT itself is behaving unexpectedly, you suspect a VAT bug,
or you need to test a local code change to vibe-agent-toolkit in another project.

## Step 1: Confirm the Version

First, confirm which version of VAT is running:

```bash
# In the adopter project
cat node_modules/@vibe-agent-toolkit/cli/package.json | grep '"version"'

# Or check the binary directly
vat --version
```

If the installed version is behind the monorepo, you may need `VAT_ROOT_DIR` (see below)
to test with the local build instead.

## Step 2: Enable Debug Output

```bash
VAT_DEBUG=1 vat <command>
```

`VAT_DEBUG=1` prints context detection info, binary path resolution, and config loading
details. Use it to confirm which config file and which binary are actually being used.

Other useful env vars:
- `VAT_TEST_ROOT=/path` — Override the project root VAT uses (skips `.git` detection)
- `VAT_TEST_CONFIG=/path/to/config.yaml` — Override the config file path

## Step 3: Reproduce With the Local Monorepo Build

To test a fix from your local vibe-agent-toolkit checkout in an adopter project
(e.g. lfa-cc-marketplace) **without publishing to npm**:

### Option A: VAT_ROOT_DIR (recommended)

```bash
# In your shell (or .env.local in the adopter project)
export VAT_ROOT_DIR=/path/to/vibe-agent-toolkit

# Build the monorepo first — always required
cd /path/to/vibe-agent-toolkit && bun run build

# Now any vat command in the adopter project uses your local build
cd /path/to/adopter-project
vat resources validate .
```

The globally-installed `vat` wrapper detects `VAT_ROOT_DIR` and re-dispatches
to `$VAT_ROOT_DIR/packages/cli/dist/bin.js`.

### Option B: Direct path (no global install needed)

```bash
# Build first
cd /path/to/vibe-agent-toolkit && bun run build

# Then invoke directly
node /path/to/vibe-agent-toolkit/packages/cli/dist/bin/vat.js resources validate .
```

## Step 4: Write a Failing Test Before Fixing

Before changing VAT source code, write a test that reproduces the bug:

- **Unit bug** → add a test in `packages/<package>/test/`
- **CLI behavior** → add an integration test in `packages/cli/test/integration/`
- **End-to-end workflow** → add a system test in `packages/cli/test/system/`

See [docs/writing-tests.md](../../../../docs/writing-tests.md) for test patterns and
the unit/integration/system classification guide.

## Step 5: Validate Before Committing

After fixing, run the full pipeline from the monorepo root:

```bash
bun run validate
```

This runs unit → integration → system tests with caching. If tests pass, the fix
is safe to commit. Do not commit until `bun run validate` passes.

## Quick Diagnosis Checklist

| Symptom | First thing to check |
|---|---|
| `vat` command not found | `npm install -g vibe-agent-toolkit` |
| Wrong results in adopter project | Confirm installed version matches expected RC |
| Fix applied but adopter still wrong | Did you `bun run build` after the change? |
| Validation slow every time | `git rev-parse --git-dir` — are you in a git repo? |
| Config not loading | `VAT_DEBUG=1 vat <command>` to see which config is found |
| Test passes locally, fails CI | Windows path separator? Use `toForwardSlash()` from `@vibe-agent-toolkit/utils` |

## See Also

- [docs/debug-and-test-vat-fixes.md](../../../../docs/debug-and-test-vat-fixes.md) — Full reference
- [docs/writing-tests.md](../../../../docs/writing-tests.md) — Test patterns and classification
- [packages/cli/CLAUDE.md](../../cli/CLAUDE.md) — CLI development guidelines
