# Debugging & Testing VAT Fixes

Reference guide for diagnosing unexpected VAT behavior, testing local code changes
in adopter projects, and validating fixes before publishing.

> **Quick reference**: Also available as `vibe-agent-toolkit:debugging` skill
> when working in Claude Code.

## Check Which Version Is Running

```bash
# In the adopter project
cat node_modules/@vibe-agent-toolkit/cli/package.json | grep '"version"'

# Or via the binary
vat --version
```

Many "VAT bugs" are version mismatches — the adopter project has an older RC installed.

## Enable Debug Output

```bash
VAT_DEBUG=1 vat <command>
```

Prints: binary path resolution, context detection, config file found, and project root.
Use to confirm that VAT is reading the config and root you expect.

Other env vars:

| Variable | Purpose |
|---|---|
| `VAT_DEBUG=1` | Print resolution and context detection details |
| `VAT_ROOT_DIR=/path` | Redirect to a local monorepo build (see below) |
| `VAT_TEST_ROOT=/path` | Override project root (skips `.git` detection) |
| `VAT_TEST_CONFIG=/path` | Override config file path |

## Test With a Local Monorepo Build

To test a fix from your local `vibe-agent-toolkit` checkout in an adopter project
without publishing to npm, use `VAT_ROOT_DIR`:

```bash
# 1. Build the monorepo first (always required after code changes)
cd /path/to/vibe-agent-toolkit
bun run build

# 2. Point the adopter project at your local build
export VAT_ROOT_DIR=/path/to/vibe-agent-toolkit

# 3. Run any vat command — it now uses your local build
cd /path/to/adopter-project
vat resources validate .
```

The globally-installed `vat` wrapper detects `VAT_ROOT_DIR` and re-dispatches to
`$VAT_ROOT_DIR/packages/cli/dist/bin.js` automatically.

**Alternative (no global install needed):**

```bash
node /path/to/vibe-agent-toolkit/packages/cli/dist/bin/vat.js resources validate .
```

## Write a Failing Test Before Fixing

Reproduce the bug as a test before touching source code:

| Bug type | Test location |
|---|---|
| Pure logic, parsing, schema | `packages/<package>/test/*.test.ts` (unit) |
| CLI command behavior | `packages/cli/test/integration/*.integration.test.ts` |
| End-to-end workflow | `packages/cli/test/system/*.system.test.ts` |

See [docs/writing-tests.md](writing-tests.md) for patterns and classification guide.

Run just the test you added:
```bash
bun run test:unit -- <pattern>          # unit
bun run test:integration -- <pattern>  # integration
bun run test:system -- <pattern>       # system
```

## Validate Before Committing

After fixing, run the full pipeline from the monorepo root:

```bash
bun run validate
```

Results are cached by git tree hash — instant if code is unchanged, re-runs only
what changed. Do not commit until this passes.

## Common Symptoms & Causes

| Symptom | Likely cause |
|---|---|
| Wrong anchor slugs in link validation | Check `generateSlug` in `packages/resources/src/link-parser.ts` |
| Headings not found in a file | Spurious ` ``` ` fence swallowing the heading — scan file for unclosed fences |
| Config not loading | Run `VAT_DEBUG=1 vat <command>` — shows which config file is found |
| Fix works locally but adopter still wrong | `bun run build` not run after the change, or adopter uses old installed version |
| Path wrong on Windows | Use `toForwardSlash()` from `@vibe-agent-toolkit/utils` for path comparisons |
| Test passes, CI fails | Different Node version; check matrix (Node 22/24 × Ubuntu/Windows) |

## See Also

- [docs/writing-tests.md](writing-tests.md) — Full test classification and patterns
- [packages/cli/CLAUDE.md](CLAUDE.md) — CLI development guidelines
- [docs/build-system.md]() — Build configuration reference
