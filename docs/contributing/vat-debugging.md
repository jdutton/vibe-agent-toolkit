# Debugging & Testing VAT Fixes

Contributor reference for debugging VAT itself: reproducing bugs, testing a local
code change in adopter projects via `VAT_BIN`/`VAT_ROOT_DIR`, writing failing tests before
fixing, and validating fixes with the full build pipeline before publishing.

Use this guide when VAT itself is behaving unexpectedly, you suspect a VAT bug,
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
- `VAT_BIN=/path/to/dist/bin.js` — Point the wrapper at an explicit built CLI entry, highest
  precedence. A path that does not exist, or that names the wrapper itself
  (`dist/bin/vat.js` — that would re-resolve and spawn itself forever), is a hard error (exit 2),
  never a silent fall-through to dev/local/global resolution.
- `VAT_ROOT_DIR=/path` — Point the wrapper at a monorepo checkout root; it re-dispatches to
  `$VAT_ROOT_DIR/packages/cli/dist/bin.js`. That file must already be built (`bun run build` in
  the checkout) or this is a hard error (exit 2) naming the missing binary — it does not fall
  through either.
- `VAT_TEST_ROOT=/path` — Override the project root VAT uses (skips `.git` detection). Orthogonal
  to `VAT_BIN`/`VAT_ROOT_DIR`: it only changes where dev/local-install detection starts looking,
  and has no effect once either override is set.
- `VAT_TEST_CONFIG=/path/to/config.yaml` — Override the config file path
- `VAT_CACHE=0` — Disable VAT's on-disk caches, including in spawned child phases (the root
  `--no-cache` flag sets this). **Set this before you trust any reproduction.** Parsing is served
  from a cross-process cache under `<tmpdir>/.vat-cache/`, so a second run of "the same" command
  can take a different code path from the first. If a bug appears only on the first run, or only
  on a colleague's machine, suspect the cache before you suspect the input. `vat cache clear`
  discards what is already stored.

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
to `$VAT_ROOT_DIR/packages/cli/dist/bin.js`. This also works through `npx vat` in an adopter
project — the umbrella `vibe-agent-toolkit` package's bin entry routes through the same
dispatcher, so a local install picks up the override just like a global one.

**Verify the override is active** with `VAT_DEBUG=1`:

```bash
VAT_DEBUG=1 VAT_ROOT_DIR=/path/to/vibe-agent-toolkit vat resources validate .
# Expect on stderr:
#   [vat debug] Using VAT_ROOT_DIR override
#   [vat debug] Binary: /path/to/vibe-agent-toolkit/packages/cli/dist/bin.js
```

If you don't see those lines and the command did not hard-error, `$VAT_ROOT_DIR` is unset or
empty in the subprocess's environment — check with `env | grep VAT_ROOT_DIR`. If it errors
instead (exit 2, naming `VAT_ROOT_DIR` and the missing path), run `bun run build` in the
monorepo first.

**Identical output with and without the override usually means the local checkout has the same
code as the installed version**, not that the override failed. Confirm with `git log -1` in the
monorepo — if it points at the same commit as the published version, there's nothing different
for `VAT_ROOT_DIR` to surface.

### Option B: VAT_BIN (no global install needed)

```bash
# Build first
cd /path/to/vibe-agent-toolkit && bun run build

# Then invoke the wrapper with an explicit binary
VAT_BIN=/path/to/vibe-agent-toolkit/packages/cli/dist/bin.js vat resources validate .
```

Point `VAT_BIN` at `dist/bin.js` — the real CLI entry — never at `dist/bin/vat.js`. That file
*is* this wrapper: naming it would make the wrapper re-resolve and spawn itself, which is why
the wrapper refuses it outright (exit 2) rather than looping.

If no `vat` is on `PATH` at all, invoke the built entry directly instead — this bypasses context
detection entirely, so neither `VAT_BIN` nor `VAT_ROOT_DIR` apply:

```bash
node /path/to/vibe-agent-toolkit/packages/cli/dist/bin.js resources validate .
```

## Step 4: Write a Failing Test Before Fixing

Before changing VAT source code, write a test that reproduces the bug:

- **Unit bug** → add a test in `packages/<package>/test/`
- **CLI behavior** → add an integration test in `packages/cli/test/integration/`
- **End-to-end workflow** → add a system test in `packages/cli/test/system/`

See [docs/writing-tests.md](../writing-tests.md) for test patterns and
the unit/integration/system classification guide.

Run just the test you added, from its package directory (`bun run test:<tier> -- <pattern>` does
not work: bun strips the `--` and turbo reads the pattern as a task name):

```bash
cd packages/<pkg>
bunx vitest run test/<file>.test.ts                                        # unit
bunx vitest run --config vitest.integration.config.ts test/integration/<file>.integration.test.ts
bunx vitest run --config vitest.system.config.ts test/system/<file>.system.test.ts
```

## Step 5: Validate Before Committing

After fixing, run the full pipeline from the monorepo root:

```bash
bun run validate
```

This runs unit → integration → system tests with caching. If tests pass, the fix
is safe to commit. Do not commit until `bun run validate` passes.

## Crucible runs

The verdict facet (`packages/lab`, `vat-lab verdict run|compare`) is the crucible: it runs two
vat builds — never more — over the same subject set and diffs what each one DECIDES (exit code,
the multiset of findings, the full document), reconciled against a committed deltas file.

**Baseline arm** — the previous published RC, installed into a private prefix so it never
touches the operator's own global/local install:

```bash
npm install --prefix "$HOME/.cache/vat-lab/instruments/<ver>" --no-save --ignore-scripts \
  @vibe-agent-toolkit/cli@<ver>
```

Then a shim directory whose `packages/cli/dist` symlinks to that install, used as:

```bash
--instrument dist:"$HOME/.cache/vat-lab/instruments/<ver>/node_modules/@vibe-agent-toolkit/cli/dist" \
--env VAT_ROOT_DIR="$HOME/.cache/vat-lab/shims/<ver>"
```

Never `npx:<pkg@version>` for the baseline: its wrapper re-resolves vat from the *subject's* cwd,
so run against VAT's own tree it dispatches to the candidate, not the pinned version.

**Candidate arm** — the worktree under test:

```bash
--instrument tree:"$WORKTREE" --env VAT_BIN="$WORKTREE/packages/cli/dist/bin.js" \
--env VAT_ROOT_DIR="$WORKTREE"
```

Both overrides, because an adopter's already-installed wrapper predates `VAT_BIN` and honours
only `VAT_ROOT_DIR`.

**Subjects file** is local (never committed), lives outside every subject it names, and carries
aliases only (`crucible-1`, `crucible-2`, …) — no adopter names. `--subjects` is required on every
`verdict run`.

**Isolation** — the facet itself sets a private projection store per arm and per subject
(`VAT_PROJECTION_STORE_DIR`) and unsets `CLAUDE_CONFIG_DIR`; an arm's own `--env`/`--unset` may
not name either — the facet refuses that as a clash with what it already owns.

**Sequence**: control first — `baseline` twice, then `verdict compare --control` must exit 0. Any
field that differs between two runs of the *same* build is a new instability in the normalizer,
not a real finding, and needs a normalizer rewrite backed by that run before anything else
proceeds. Then baseline immediately followed by candidate: a baseline capture reused across an
edit to the worktree is refused, because the candidate's subject fingerprint has moved and the
compare only tolerates the instrument axis moving.

**Deltas** — every accepted difference between baseline and candidate is declared in
`packages/lab/data/verdict-deltas.yaml` against a `.changes/` fragment anchor. Both an undeclared
delta and a declared-but-absent one fail the compare — the file is a two-way ratchet, not an
allowlist that only grows.

**Backfill obligation** — every catch the crucible finds that no existing suite caught gets a
failing synthetic test in `packages/*/test/` first, then the fix. The crucible is a net, not a
substitute for the test it exposes a gap in.

## Quick Diagnosis Checklist

| Symptom | First thing to check |
|---|---|
| `vat` command not found | `npm install -g vibe-agent-toolkit` |
| Wrong results in adopter project | Confirm installed version matches expected RC |
| Fix applied but adopter still wrong | Did you `bun run build` after the change? |
| Validation slow every time | `git rev-parse --git-dir` — are you in a git repo? |
| Config not loading | `VAT_DEBUG=1 vat <command>` to see which config is found |
| Test passes locally, fails CI | Windows path separator? Use `toForwardSlash()` from `@vibe-agent-toolkit/utils` |
| Wrong anchor slugs in link validation | Check `generateSlug` in `packages/resources/src/link-parser.ts` |
| Headings not found in a file | Spurious ` ``` ` fence swallowing the heading — scan file for unclosed fences |

## See Also

- [docs/writing-tests.md](../writing-tests.md) — Test patterns and classification
- [packages/cli/CLAUDE.md](../../packages/cli/CLAUDE.md) — CLI development guidelines
