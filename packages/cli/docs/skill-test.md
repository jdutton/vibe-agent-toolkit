# vat skill test - Eval Harness Commands

## Overview

The `vat skill test` commands run a packaged skill's eval suite in a headless,
context-isolated Claude session. Each eval runs in two roles: a blind **executor**
(the skill under test) performs the task, then a separate **grader** judges the
captured transcript and emits a verdict.

```bash
vat skill test run <skill>        # execute the eval suite
vat skill test configure <skill>  # persist knobs into vibe-agent-toolkit.config.yaml
```

> **This command executes skill code.** It is context-isolated, not an OS sandbox.
> `--i-understand-this-runs-skill-code` is required to acknowledge that.

Note the singular `vat skill` — distinct from the `vat skills` (plural) packaging
commands documented in [skills.md](./skills.md).

## Two config homes

Most knobs exist both as a CLI flag (one-off) and a config key (persisted). **Flags
override config.** There are two places config lives:

| Home | Location | Holds |
|---|---|---|
| **Per-skill** | `skills.config.<skill>.test` | Everything about testing *one* skill — model under test, budgets, evals, companions |
| **Global** | top-level `test:` node | Judge/pipeline knobs shared by every skill — `graderModel`, `concurrency` |

```yaml
# vibe-agent-toolkit.config.yaml
test:                          # GLOBAL — the judge and the pipeline
  graderModel: claude-sonnet-5
  concurrency: 4

skills:
  config:
    my-skill:
      test:                    # PER-SKILL — the thing under test
        model: claude-opus-5
        timeout: 1500
        auth: subscription
        requireAuth: subscription
        evals: evals/suite.json
```

Both blocks are validated under a **strict** schema — an unknown key is a config
error, not a silent no-op. (This is the deliberate inverse of `evals.json`, which
VAT reads liberally as adopter-authored data.)

`vat skill test configure <skill>` writes the **per-skill** block using a
comment-preserving YAML upsert, and validates values before writing. Prefer it over
hand-editing. It publishes the report envelope on stdout (schema
`packages/cli/schemas/skill-test-configure.json`): `status: ok`, `examined: 1`, and
`data: { configPath, skill }`, `configPath` relative to the working directory. With
`--print` it writes nothing to disk and stdout is the updated config text alone — no
report — so `vat skill test configure my-skill --max-turns 20 --print > new.yaml`
yields a usable file. A refusal exits `2` with `error.code`: `USAGE_INVALID` (an invalid
knob value, a skill the config's `skills.include` does not discover — configure a skill
after declaring it — or no project root), `CONFIG_INVALID` (no config file at the project root, or
the edit would leave it failing its schema), `INPUT_UNREADABLE`, or `RUN_INCOMPLETE`
(the write failed). An unknown key already in the config is a stderr warning, never a
refusal.

## Per-skill knobs (`skills.config.<skill>.test`)

Every field is optional; an omitted knob falls back to its default.

| Config key | Type / unit | Default | CLI flag | Purpose |
|---|---|---|---|---|
| `model` | string | claude's own default | `--model <id>` | Model for the **executor** (the skill under test). Passed **verbatim** to `claude --model` — VAT does no mapping or validation. Pin it for reproducible runs. |
| `maxTurns` | integer > 0 | none | `--max-turns <n>` | Per-spawn cap on executor/grader turns. |
| `maxBudgetUsd` | number > 0 | none | `--max-budget-usd <n>` | Hard USD budget cap passed to the CLI. |
| `timeout` | integer, **seconds** | scales with eval count: ~`2min + 2min/eval`, floored at 5min, capped at 1h | `--timeout <s>` | Wall-clock timeout. An explicit value always overrides the scaled default. |
| `stall` | integer, **seconds** | none | `--stall <s>` | Stall watchdog — kill the spawn after this long with no stream output. |
| `evals` | string (path or npm specifier) | auto-detected `evals/evals.json` (see below) | `--evals <path>` | Which `evals.json` to grade against. `test.evals` resolves **relative to the skill source**; `--evals` resolves **relative to the current directory**. Either may be absolute, and either may be an npm bare specifier. An explicit value always wins over the default convention. |
| `auth` | `inherit` \| `subscription` \| `api-key` \| `auto` | `inherit` | `--auth <mode>` | Auth mechanism for the spawned session. |
| `requireAuth` | `subscription` \| `api-key` | none | `--require-auth <mech>` | Fail-fast guard: preflight exits `2` if the effective mechanism isn't this. |
| `baseline` | boolean | `false` | `--baseline` | Run the opt-in with/without A/B skill-lift comparison. |
| `skillCreator` | source descriptor | `{ vendored: true }` | — | Source for the vendored skill-creator rubric. |
| `with` | array of source descriptors | none | `--with name=<src>` | **Required** companion skills staged alongside the subject, invocable by it. |
| `optional` | array of source descriptors | none | `--with-optional name=<src>` | **Optional** companions — skipped with a warning if unresolvable. |
| `env` | map string→string | none | `--env KEY=VALUE` | Env vars injected into the **executor** spawn. Values interpolate `${fixturesDir}`, `${stagedSkillDir}`, `${harnessRoot}`, `${resultsDir}`. `${fixturesDir}` is **per-eval** — it names that eval's own staged workspace (`fixtures/` under the executor's working directory), so the eval must declare input `files`; using it on an eval without them fails the run (exit 2). Protected names (PATH, auth, model, admin) cannot be overridden. |
| `passEnv` | array of strings | none | `--pass-env KEY` | Names of host env vars to forward to the executor spawn if present. Protected names are ignored with a warning. |
| `build` | string (shell command) | none | — | Command run **once, before staging**, to generate build artifacts. Runs with `cwd` = config root. A non-zero exit aborts the run (exit `2`). |

A **source descriptor** is one of `{ workspace: <pkg> }`, `{ npm: <spec> }`,
`{ url: <u>, sha256?: <hash> }`, `{ path: <dir> }`, or `{ vendored: true }`. On the
command line the same sources are written as `name=workspace:<pkg>`,
`name=npm:<spec>`, `name=url:<u>`, `name=path:<dir>`, or `name=vendored` — the CLI
form requires an explicit companion `name=`, the config form derives it from the
resolved skill.

### Companion staging and builds

A `path:` companion whose source directory maps to a **declared** skill is **built**
first, exactly like the subject, so its `files:` build artifacts are injected — a
companion backed by a bundled executable stages functional rather than inert. A
required companion's build failure fails the run; an optional one falls back to raw
unbuilt source only when the failure is non-destructive. Each declared skill builds
**at most once per run**.

Staging the same name twice across the subject, `--with`, and `--with-optional` is a
duplicate-name error (exit `2`).

### The default eval-suite convention

**You do not need a `test:` block to have an eval suite.** If a skill has a file at:

```
<skill-source-dir>/evals/evals.json
```

VAT treats that as the skill's suite — the same path `vat skill test run` has always defaulted to. Two things follow from it, and they are deliberately the same two things an explicit `test:` block would give you:

1. `vat skill test run <skill>` finds and runs the suite.
2. **The suite directory is excluded from packaged output.** It holds the `expected_output` / `expectations` answer key, so shipping it would both publish the answers and let a skill under test read its own key.

This is **auto-detection, not a requirement**. It is keyed on the suite *file* existing:

| On disk | Treated as a suite? |
|---|---|
| `<skill>/evals/evals.json` | **Yes** — run by the harness, excluded from the bundle |
| `<skill>/evals/` with no `evals.json` | No — ordinary content, ships normally |
| `<skill>/docs/evals/…` (any other location named `evals`) | No — ordinary content, ships normally |
| No `evals/` directory at all | No — nothing happens, no error, no warning |

A skill with no suite is completely unaffected: it packages exactly as it would have, with no error and nothing excluded. The convention never makes evals mandatory.

**Set `test.evals` explicitly** when your suite lives anywhere else — a shared directory, a per-skill subdirectory (VAT's own repo uses `evals/<skill-name>/evals.json`), or outside the skill tree. An explicit path always overrides the convention.

> Both lanes honor this. Before it was shared, the harness auto-detected the suite while the packager did not, so a skill relying on the default had its answer key published even though the harness was protecting it.

### Testing a skill you did not author

A correctly packaged skill ships **no** eval suite — the suite is the answer key, and excluding it from the bundle is the whole point of the convention above. So for any skill you install rather than write, there is nothing in its tree to grade against, and you have to supply the suite yourself:

```bash
vat skill test run npm:@vendor/their-skill \
  --evals ./our-audit-corpus/their-skill.json \
  --i-understand-this-runs-skill-code
```

`--evals` resolves against the directory you run it from, so the path means what you typed. It may point anywhere — including outside the skill's tree entirely, which is the normal case here. It also accepts an npm bare specifier (`--evals @acme/skill-evals/their-skill.json`), honoring that package's `exports` map, so a shared corpus can be distributed as a package.

The suite is never copied into anything the executor can reach. Each eval's declared input `files` are resolved relative to the **suite's** directory and staged into that eval's own workspace, so fixtures travel with the suite rather than with the skill.

> **On sensitive fixtures.** `workspaces/` and `results/` are created `0700`, so a fixture that was never in your repo is not left readable by other local users. That is necessary but **not** sufficient: `grading.json` quotes the executor transcript verbatim as evidence, so anything the skill *reads out of* a fixture is written into `results/` as text — and `results/` survives `--keep` by design. Treat the harness output as being as sensitive as the fixtures you feed it.

## Global knobs (top-level `test:`)

| Config key | Type | Default | CLI flag | Purpose |
|---|---|---|---|---|
| `graderModel` | string | `claude-sonnet-5` | `--grader-model <id>` | Model for the fixed grader/judge. Passed verbatim to `claude --model`. Independent of `model` — you can run the skill under one model and grade under another. |
| `concurrency` | integer > 0 | `4` | `--concurrency <n>` | Width of the bounded-parallel executor→grader pipeline. |

## Run-only flags (no config key)

| Flag | Purpose |
|---|---|
| `--i-understand-this-runs-skill-code` | **Required.** Acknowledges the command executes skill code. |
| `--no-build` | Stage existing `dist` instead of building. Errors if absent for the subject or a **required** companion; an optional companion falls back to raw source with a warning. |
| `--refresh` | Force a full re-stage, ignoring existing staged content. |
| `--keep` | Keep the harness directory after the run (needed to inspect `results/`). |
| `--dry-run` | Build and stage exactly as a real run would, then stop without spawning Claude — no session, no tokens. It **does build** (when `--i-understand-this-runs-skill-code` is passed), because the question a dry run answers is "what happens if I drop this flag", and a preview built from a stale `dist/` answers it wrongly. **Without** the acknowledgement it does not build — building runs the repo's `test.build` hook, an arbitrary shell command — so it falls back to an existing `dist/` and warns it may be stale. `--no-build` skips the build either way. |
| `--out <dir>` / `--workdir <dir>` | Override the harness output / working directory. An existing `--out` must already be a directory and, on POSIX, `0700`: VAT creates a new one `0700`, and never changes the mode of one you made (Windows has no mode check). |
| `--allow-eval-failure` | Opt out of fail-closed: each failed eval is published as a `warning` finding instead of an `error`, so the run exits `0`. For interactive iteration. |
| `--allow-unverified-skill-source` | Skip the vendored manifest integrity check. |
| `--debug` | Enable debug logging. |

## The report

`vat skill test run` publishes the report envelope on stdout (schema
`packages/cli/schemas/skill-test-run.json`), and nothing else — the `Summary:` line that
used to be stdout's one machine-readable channel is gone from it. The human verdict line
stays on stderr as `Summary: <line>`, beside `Harness:`, `Results:`, `Workspaces:` and
`Reason:`.

- `examined` — the evals the run graded; on `--dry-run`, which grades nothing, the evals
  it staged.
- `findings` — one `SKILL_TEST_EVAL_FAILED` per eval that ran and did not pass (an output
  expectation, or its tool verdict): `location` the suite's `evals.json` relative to the
  project root (omitted when it lies outside the project), `field` the eval's `id`. `error` by default,
  `warning` under `--allow-eval-failure`. Evals a fail-fast tier gate skipped are not
  listed: they never ran, and the failure that fired the gate is.
- `data.skill` — the reference as passed; `data.description` — the verdict line
  (`PASS 3/3`, `FAIL 1/2 (1 tool)`, the dry-run preview); `data.evals` — `{ id, passed }`
  per graded eval; `data.artifacts.frictionReport` — the `friction.json` written, or `null`
  on a dry run; `data.artifacts.outputDir` — the harness root (`--out`), of which a
  default run keeps only `results/`.

## Exit codes

The same three-way contract as every other `vat` command, derived from the published
document, so a CI consumer can tolerate eval failures while failing closed on a harness
that could not run.

- `0` - Every eval passed (or `--allow-eval-failure` published the failures as warnings)
- `1` - **Eval failure** — the run completed and an `error` finding names each eval that did not pass
- `2` - The harness could not run: `status: error`, and `error.code` says which refusal.
  A `Reason: <reason>` line on stderr restates it for a CI log — `internal` exactly for
  `INTERNAL_ERROR`, `bootstrap` for a scaffolded `evals.json`, `preflight` for the rest.
  Each code is decided where the cause was seen, never read back from a message. A skill
  build that threw is classified by what it threw: a coded cause keeps its own code (a
  directory the OS will not list is `INPUT_UNREADABLE` from a build exactly as from
  resolution), and an uncoded one is `INTERNAL_ERROR`:

| `error.code` | `Reason:` | When |
|---|---|---|
| `BACKEND_UNAVAILABLE` | `preflight` | No `claude` binary on `PATH`, or one too old for a flag the spawn needs |
| `USAGE_INVALID` | `preflight` | An invalid flag value, an auth guard the credentials do not meet, the missing security ack, an unsafe `--workdir`, an `--out` that exists and is not a directory, or (POSIX only — Windows has no mode check) is not `0700` (VAT never changes its mode — `chmod 700` it, or name one that does not exist yet), a held harness lock, a skill name the config does not declare (or `--no-build` with no dist), a bad `env` token, a failing `test.build` hook, a repeated staged name |
| `CONFIG_INVALID` | `preflight` | The governing `vibe-agent-toolkit.config.yaml` does not parse or fails its schema (subject's or a companion's) |
| `INPUT_UNREADABLE` | `preflight` | A declared eval input or dependency is absent, the `evals.json` is not a valid suite, the vendored copy fails its manifest, a config or directory the OS will not read, a `--with name=path:<dir>` companion that does not exist, or holding a file or directory the OS will not read or a symlink (named) |
| `INPUT_UNREADABLE` | `bootstrap` | `evals.json` was absent, so VAT wrote a starter template next to the skill source; fill it in and re-run |
| `RUN_INCOMPLETE` | `preflight` | The packager refused the subject's (or a required companion's) own content — a `files:` source absent, a `SKILL.md` bundled as a resource. A `SKILL_PACKAGING_FAILED` finding at the skill's `SKILL.md` says what to change. Also, with no finding: an output the OS will not let the run write — the harness root (`--out` under a read-only directory), its lockfile, the staged skill copies and manifest, the `results/` files, a dist bundle — a full disk or a read-only directory. Known gap: a disk so full that a skill build's git snapshot of the project fails first is still `INTERNAL_ERROR` |
| `INTERNAL_ERROR` | `internal` | The harness broke (executor/grader crash, stall, timeout, grader nonce or skew failure); the stack is on stderr |

```bash
vat skill test run my-skill --i-understand-this-runs-skill-code
case $? in
  0) ;;
  1) echo "evals failed (tolerated)" ;;
  *) exit 1 ;;    # harness could not run — fail the build; read error.code
esac
```

## Results

The harness root keeps a `results/` tree (named on stderr as `Results:`) that VAT is
the sole writer of — the harness writes it, not the CLI, and validates each file against
its schema before the run reports:

- `grading.json` - per-expectation verdicts and the pass/total summary
- `friction.json` - packaging issues observed during the run (advisory). Each item's
  `severity` is `error|warning|info`, the vocabulary every VAT report uses. The grader is
  still asked for `high|medium|low`; VAT maps it (`high`->`error`, `medium`->`warning`,
  `low`->`info`) once, when it parses the grader's fragment.
- `tool-eval.json` - tool-expectation verdicts; always written, so check
  `.evals.length` rather than file existence

## Examples

```bash
# Run a declared skill's suite, honoring its test: config
vat skill test run my-skill --i-understand-this-runs-skill-code

# Pin both models independently, keep the harness for inspection
vat skill test run my-skill --model claude-opus-5 --grader-model claude-sonnet-5 \
  --keep --i-understand-this-runs-skill-code

# Stage a required companion the subject is expected to invoke
vat skill test run router-skill --with helper=path:./skills/helper \
  --i-understand-this-runs-skill-code

# Persist knobs instead of passing them every time (`requireAuth` has no
# configure flag: set it under the skill's `test:` block by hand, or pass
# --require-auth to each `run`)
vat skill test configure my-skill --auth subscription
```

## See Also

- [skills.md](./skills.md) - `vat skills` (plural): packaging, validation, install
- [index.md](./index.md) - full CLI command index

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `skill test configure`

The test block written to the config. Produced by `vat skill test configure test-skill-2 --auth inherit`.

```yaml vat-report=skill test configure
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  configPath: vibe-agent-toolkit.config.yaml
  skill: test-skill-2
```

### `skill test run`

A dry run: what a real run would do, with nothing spawned and no eval graded. Produced by `vat skill test run ./test-skill-1 --dry-run --i-understand-this-runs-skill-code --out ./out`; the absolute paths are shortened.

```yaml vat-report=skill test run
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
data:
  skill: ./test-skill-1
  description: |-
    [dry-run] A real run would: stage the source dir as-is, then spawn claude.
    [dry-run] Would run 1 executor→grader spawn pair at concurrency 4 — 2 claude sessions in total.
    [dry-run] --max-budget-usd is PER SPAWN ($5), not per run: worst case ≈ $10.00 across those 2 sessions.
    [dry-run] Executor (no --model; claude default); grader model claude-sonnet-5 (prompt via stdin).
    [dry-run] Staged manifest: 1 entry | fingerprint: 33dee44374157bdc92af00c90fc5de39d2a3d974795a707a73c575ecf6488b4d
    [dry-run] Provenance would be written to: /home/me/project/out/results/provenance.json
  evals: []
  artifacts:
    frictionReport: null
    outputDir: /home/me/project/out
```

Refused without the security acknowledgment: an `error` document, exit `2`. Produced by `vat skill test run test-skill-1`.

```yaml vat-report=skill test run
status: error
examined: 0
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
error:
  code: USAGE_INVALID
  message: Security acknowledgment required. Pass --i-understand-this-runs-skill-code to proceed.
data: null
```
