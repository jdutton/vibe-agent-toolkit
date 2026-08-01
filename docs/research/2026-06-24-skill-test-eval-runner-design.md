# Design: `vat skill test` — tiered, parallel, cacheable eval runner

**Date:** 2026-06-24
**Status:** Approved design (brainstorming) + adopter spec-review incorporated — the design of record for the v2 eval-runner, to be executed in its own PR.
**Relationship to shipped work:** PR #132 shipped the v1 single-session harness; PR #135 hardened it (security/correctness, per adversarial review). This v2 eval runner — the tiered/parallel/cacheable re-architecture below — is a **separate, not-yet-built PR**. Committed here (promoted from the gitignored `docs/superpowers/specs/` working dir) so the design survives the #135 worktree and the v2 PR can execute from it.
**Forward direction:** the multi-runtime evolution this feeds is [`2026-06-25-multi-runtime-skill-testing-direction.md`](2026-06-25-multi-runtime-skill-testing-direction.md).
**Supersedes scope of:** the v1 single-session runner shipped in #132.

**Revision note (2026-06-24):** a first adopter reviewed the initial spec from a
usage/requirements perspective. Incorporated: a runtime/environment **variant matrix**
(generalizing the model-only matrix), **per-unit runtime-state isolation**,
`errored(environment)` classification, cache bypass/clear controls, and three nits
(SDK-reported cost, mixed-id selectors, variant in the cache key). The core abstraction
changed: the matrix axis is now **`variant = (model, env)`**, not model alone.

---

## 1. Motivation

The eval runner shipped in #132 is a v1 MVP: it stages a skill, hands the *entire*
`evals.json` array to **one headless experimenter Claude session**, and that session
runs every eval internally and emits one flat `grading.json`. The runner never sees an
individual eval.

Adopter feedback (an adopter's skill-factory consuming agent, 2026-06-24) asks for the
inner-dev-loop economics of a real test runner:

- **Token win (primary):** don't run the expensive matrix when the skill is fundamentally
  broken. Stage cheap→expensive, fail fast at the first cheap failure.
- **Wall-clock win (secondary):** the workload is embarrassingly parallel, so
  bound-parallelize it.
- **Real-surface coverage:** exercise *every runtime/config the skill ships on*, not just
  the default — the place the adopter's most expensive bug hid.
- Plus: a smoke subset, two run modes (iterate vs audit), rate-limit resilience,
  machine-readable per-`(eval × variant)` output, and skip-unchanged caching.

Every one of those presupposes the runner orchestrates evals individually. The
foundational move is **lifting the eval loop out of the single experimenter session into
the runner** — a re-architecture, not an increment.

**Reference architectures studied:** `vibe-validate`'s phase/step model (ordered phases,
fail-fast at phase boundaries, per-phase `parallel`, tree-hash skip cache, nested result
schema) maps almost 1:1 and is mirrored where it fits. `skill-creator`'s eval model
(`evals.json`, `grading.json`, `history.json` pass-rate/baseline vocabulary) is the
artifact contract we stay byte-compatible with.

## 2. Goals / Non-goals

**Goals**
- Runner owns the eval loop: stage once, run one invocation per **unit**.
- Tiered execution with hard fail-fast gates: T0 deterministic → T1 smoke → T2 full.
- **Variant matrix:** the same eval runs across a declared set of `variant = (model, env)`
  combinations — a runtime/environment axis alongside the model axis. (P0-1)
- **Per-unit runtime-state isolation:** parallel units cannot observe each other's
  filesystem side effects; isolation is a runner guarantee, not an adopter footgun. (P0-2)
- Adopter-declared tiers/grouping in VAT config via an eval-id **selector grammar**, with
  a sensible zero-config default. `evals.json` stays byte-identical to skill-creator.
- Bounded-parallel execution within a tier, with rate-limit retry/backoff.
- A designated **gating** variant-axis value (the bar) vs non-gating **canary** values
  (diagnostic, non-blocking).
- An **errored** taxonomy distinct from `failed`: `errored(rate-limit)`,
  `errored(environment)` — excluded from pass-rate, mapped to a "run incomplete" exit.
- Machine-readable, matrix-aware output (`run.json` aggregate + skill-creator-shaped
  per-unit leaves), with `cost` from SDK-reported usage.
- Per-unit skip-unchanged caching keyed on a content hash that **includes the variant**,
  plus `--no-cache` / `--clear-cache` escape hatches.
- Two run modes: `--fail-fast` (iterate) and `--audit` (run-all).

**Non-goals (this spec)** — adopter concurs these are correct deferrals:
- Splitting the central `vibe-agent-toolkit.config.yaml` into per-skill config files (§12).
- Semantic eval *tags* beyond id-selectors.
- Cross-skill eval suites; CI-native reporters (JUnit/SARIF/etc.).
- Replacing skill-creator's executor/grader agents — we reuse them per unit.

## 3. Architecture

### 3.1 Definitions

- **variant** = `(model, env)` — one point in the matrix. `env` is a concrete assignment
  of environment variables (e.g. `{ENGINE: native}`). The model axis and each declared
  env axis form a **cartesian product** per tier; with nothing declared, there is exactly
  one variant `(<default model>, {})` and the matrix is 1×1.
- **unit** = `(eval, variant)` — one staged-skill invocation + one grader call. The
  smallest schedulable, cacheable, gradable thing.
- **work-list** = `tiers × selected-evals × variants`, flattened to an ordered `Unit[]`.

### 3.2 Control flow

```
lock workdir / assert harness root
  → stage skill + declared deps ONCE  (read-only skill bytes; existing staging.ts/manifest.ts)
  → build work-list: tiers × selected evals × variants
  → for each TIER in declared order:
        run tier's units bounded-parallel (concurrency cap)
          each unit:
            provision per-unit isolated runtime state (own TMPDIR/HOME/cache root)   ← P0-2
            apply the variant's env (after the security allowlist; protected names win)
            cache hit (key includes variant) → reuse GREEN leaf, skip spawn
            else spawn staged-skill invocation → skill-creator executor → grader
          classify each unit: pass | fail | errored(rate-limit|environment|other)
        GATE (gating-axis values only):
          - tier fails AND failFast → STOP (no lower tiers, no further spend)
          - audit mode → record, continue
  → aggregate → write results/<eval>/<variant>/grading.json (leaves) + results/run.json
  → exit code derived from GATING variants only
```

Staging is the expensive step and happens **once** (the skill *bytes* are read-only and
shared); the per-unit cost is the isolated-state setup + spawn + model calls. This is
vibe-validate's "step = spawn" model, eval-aware.

### 3.3 Module boundaries (each independently testable; pure where possible)

- **variant expander** (pure): `(models, env-matrix) → Variant[]` (cartesian).
- **work-list builder** (pure): `(tiers, evals.json, variants) → ordered Unit[]`; applies
  the selector grammar; tags each unit with tier, variant, and gating flag.
- **selector** (pure): `(selectorExpr, evalIds) → matchedIds` (exact / range / glob).
- **tier-gate state machine** (pure): per-unit results + mode → continue/stop + skipped
  tiers.
- **outcome classifier** (pure): invocation outcome → `pass | fail | errored(kind)`; never
  scores a rate-limit or missing-environment as a content failure.
- **cache key** (pure): hashes a unit's inputs **including the variant** → freshness key.
- **result aggregator** (pure): `Unit[] + per-unit gradings → run.json`.
- **executor adapter** (I/O): stage-once; per-unit isolated-state provisioning;
  spawn-per-unit bounded by a pLimit pool; wraps existing `spawnHeadlessClaude` +
  skill-creator executor/grader.
- **cache store** (I/O): read/write last-GREEN leaf by cache key in a local gitignored
  cache dir; honors `--no-cache` / `--clear-cache`.

## 4. Configuration (the control surface)

`evals.json` is **unchanged** (skill-creator schema:
`{skill_name, evals:[{id, prompt, expected_output, files?, expectations[]}]}`). No
VAT-specific fields are injected into the portable eval entry.

All orchestration lives in `skills.config.<name>.test`:

```yaml
test:
  models: [sonnet, haiku]        # model axis. Default: [<resolved default model>].
                                 #   Claude-family ids; per-runner model mapping is a FUTURE axis.
  env:                           # environment/runtime axis (P0-1). Each key → a list = a matrix dimension.
    ENGINE: [default, native]    #   omitted ⇒ single empty env, matrix stays 1×1 on this axis.

  gating:                        # SET-MATCHER (replaces scalar gatingModel/gatingEnv). The bar may be
    models: [sonnet]             #   multiple values: [sonnet, opus] = both must pass; others = canaries.
    env: { ENGINE: [default] }   #   gating set = cartesian(gating.*) ∩ real variants.
    # OMITTED ENTIRELY ⇒ the WHOLE matrix gates (no canaries). A teaching advisory then nudges:
    #   "declare a gating subset to unlock non-blocking canaries + a cheaper tier + (later) sampling."
    #   No positional default (never silently pick "first model"); absent gating = everything counts.

  concurrency: 6                 # bounded cap. Default: 6.
  failFast: true                 # default mode; CLI --fail-fast / --audit override. Default: true.
  retry: { attempts: 4, baseMs: 2000, factor: 2, jitter: true, capMs: 60000 }  # rate-limit backoff (Q4)

  checks:                        # TOP-LEVEL deterministic gate (T0) — NOT a tier field (see §5).
    - name: cli-opens-native     #   vibe-validate-phase-shaped: name + run + exit-0=pass + per-check timeout.
      run: "csvsum open ${fixturesDir}/sample.xlsx --engine native"   # zero-token, but RUNS SKILL CODE.
                                 #   "safe to run" = isolated (own TMPDIR/HOME/cache) + protected-env
                                 #   allowlisted + time-bounded + --i-understand-this-runs-skill-code ack.
                                 #   Skill-level only in v1; eval-specific scoping is a future `evals:` field.
  tiers:                         # PURELY the eval ladder now (no `smoke:` field; no name collision).
    - { name: smoke, evals: ["1-3", 7] }   # cheap tier; its variant-scope = the gating set (resolves Q1)
    - { name: full,  evals: "*" }
```

**Variant expansion.** The runner forms variants as the cartesian product of the model
axis and every declared `env` axis, **scoped per tier** (a tier may narrow the matrix —
e.g. T1 runs `gatingModel × gatingEnv` only; the per-tier scoping default is an open
question in §13). The existing
#132 env machinery (`test.env` static injections, `--env`, `passEnv`, `${fixturesDir}`
interpolation, the protected-name allowlist) is the substrate; the new piece is **list
values fan out** into matrix dimensions while scalar values stay static injections.
Provisioning a backend a variant needs (e.g. installing the native binary) is
**adopter-supplied** via the existing `test.build` hook or the CI lane; the runner's job
is to inject the env, isolate state, and classify "backend absent" as
`errored(environment)` (§6, P1-1) — never `failed`.

### 4.1 Eval-id selector grammar

A tier's `evals:` is a list; each element matches against the **stringified** skill-creator
`id`. Suites mix integer and string ids; the grammar tolerates both (Nit-2):

- **exact** — `7` / `"7"` / `"recognition-accuracy"`.
- **numeric range** — `"1-5"` (inclusive). **Cleanly ignores** non-numeric ids (does not
  error on string ids in the same suite).
- **glob** — `"*"`, `"recognition-*"`; applies to string ids via the same `picomatch`
  used for `validation.allow` paths.

A list unions its matches. A selector element that matches **no** id is a **config-load
warning** (typo guard), not a silent no-op — mirroring `validation.allow` key validation.

### 4.2 Zero-config default

If `tiers` is absent: **T0 structural** (built-in, §5) → **T2 full** (`evals: "*"`). With
no `models`/`env` declared the matrix is 1×1. A plain skill-creator skill thus gets the
free fail-fast structural gate + the full suite with no extra authoring; adopters opt into
the smoke rung, the model axis, and the env axis when they want control.

### 4.3 CLI overrides

`--model a,b`, `--env KEY=a,b` (repeatable; fans out), `--concurrency N`, `--tier <name>`,
`--fail-fast`, `--audit`, `--force` (run even on cache hit, then overwrite — mirrors `vv`;
replaces `--no-cache`/`--clear-cache`), and existing
`--dry-run` / `--no-build` / `--baseline`. CLI wins over config (existing `resolveKnobs`
precedence).

## 5. T0 — the deterministic gate (reuses existing machinery; the cheapest catch)

T0 runs **zero model calls** and is mostly built today:

- `validateSkillForPackaging` (build + validate + link integrity).
- `preflight.ts` checks: `evals.json` schema-valid, fixtures exist, `claude` binary +
  flags + auth, vendored skill-creator manifest intact.
- **New — top-level `checks:`** (P0-1's cheap path), a first-class deterministic primitive
  shaped like a **vibe-validate phase** (named steps: `name` + `run` command + exit-0 = pass
  + per-check timeout) — **NOT** a `smoke:` field on a tier (that earlier shape overloaded the
  word "smoke" and collided with a tier *named* `smoke`; both are gone). `checks` run before
  any tier, gate hard, cost zero tokens, with the existing interpolation (`${fixturesDir}` /
  `${stagedSkillDir}` / `${harnessRoot}` / `${resultsDir}`) and the security allowlist, **plus
  arbitrary env-var injection** so a check can force a non-default backend. A check can assert
  a deterministic sanity bound (e.g. an extracted year is 4 digits) under the native engine
  and catch a "wrong-but-green" data-corruption bug **for zero tokens, before the matrix
  runs**. Skill-level only in v1; eval-specific check scoping is a future additive `evals:`
  field on a check entry.
  - **"Safe to run" (zero-token ≠ sandbox-free):** a check runs the skill's bundled CLI =
    **skill code**, under the *same* trust boundary as a model unit. It therefore inherits
    per-unit state isolation (own `TMPDIR`/`HOME`/cache root), the protected-env allowlist (a
    check cannot override auth creds / `PATH`), a per-check timeout (a hung CLI can't wedge the
    run), and the `--i-understand-this-runs-skill-code` ack.

A check failure → STOP before any spend. The token-win gate; this promotes preflight to
"tier 0" + adds the deterministic `checks` layer, not building from scratch. (Two-layer
model: deterministic `checks` vs. the model-driven `tiers` of evals × variants.)

## 6. Execution: isolation, concurrency, error classification

### 6.1 Per-unit runtime-state isolation (P0-2)

Stage-once is correct for the skill *bytes*, but skills **write runtime state at execution
time** (caches, append-only activity/audit logs, provisioned artifacts). Sharing those
across parallel (or even serial) units interleaves writes and serves stale leftovers — a
flaky-test generator and a "trust a green" violation.

**Guarantee:** every unit gets **isolated, ephemeral writable state** — its own `TMPDIR`,
`HOME`, and cache root (an equivalent per-unit sandbox dir), set by the runner and torn
down after. The shared, read-only staged skill dir is never written by a unit. This is a
runner property from Phase 1 (it applies the moment N units run against one staged dir),
documented so any filesystem-touching skill is safe by default.

### 6.2 Bounded concurrency (divergence from vibe-validate)

vibe-validate parallelizes **unbounded**; our units are billable model calls, so a
**bounded pool** (`concurrency`, pLimit-style, default 6) caps simultaneous units.

### 6.3 Error classification (twin of rate-limit handling)

A unit outcome is `pass | fail | errored(kind)`:

- **`errored(rate-limit)`** — `llm-rate-limit` / HTTP 429, retried with exponential
  backoff + jitter up to a bounded count; after max retries, errored — **not** `failed`.
- **`errored(environment)`** (P1-1) — the variant's required runtime/backend isn't
  available in this harness/lane (e.g. native binary not provisioned). Same bucket: a lane
  that can't run every variant must not read as a skill regression.
- **`errored(other)`** — harness/internal failure.

Errored units are excluded from pass-rate and mapped to the "run incomplete" exit code,
never the content-failure code. Results are collected by **work-list index** (not
completion order — `Promise.allSettled` preserves array order), so `run.json` is
deterministic regardless of parallelism.

## 7. Output schema (matrix-aware from day one)

Designed once, matrix-aware, so no breaking reshape when the matrix lands (Phase 1 emits a
1×1 table):

- **Leaf, per unit:** `results/<eval-id>/<variant>/grading.json` — **skill-creator's exact
  grading shape, unchanged** (each leaf stays skill-creator-valid; the published
  `docs/skill-test-grading-schema.md` JSON Schema is not broken). `<variant>` is a stable,
  filesystem-safe label (e.g. `model=sonnet,ENGINE=native`).
- **Aggregate envelope:** `results/run.json` — the machine-readable table:
  - `units[]`: `{ eval_id, tier, variant: { model, env }, gating: bool,
    status: pass|fail|errored, error_kind?: rate-limit|environment|other, pass_rate,
    tokens, cost_usd, latency_ms, cache_hit: bool }`
  - `summary`: `{ gating_passed: bool, tiers_run: string[], stopped_at_tier?: string,
    models: string[], env_axes: object, gating_variant: object }`
  - `run.json` gets its own published JSON Schema + doc, mirroring the grading schema doc.

**`cost_usd` source (Nit-1, resolves §13):** prefer the **SDK's reported usage**; fall
back to a token-count × price-table estimate only when the SDK does not report it (and
flag the estimate as such). A hardcoded price table must never be the primary source.

**Exit code:** derived from **gating variants only** (the `gatingModel × gatingEnv`
combinations). Gating fail → content-failure exit; canary-only fail → zero exit, recorded
as non-blocking diagnostics; any `errored` → distinct "run incomplete" exit.

## 8. Skip-unchanged cache

- **Key (Nit-3):** content hash of `(staged skill bytes, eval entry JSON, fixture bytes,
  **variant = model id + env assignment**, experimenter+grader prompt version)`. The
  variant **must** be in the key — otherwise two variants of one eval collide and serve
  each other's results, reintroducing P0-2's bug at the cache layer. Built from the
  per-entry `contentHash` / fingerprint already computed in `manifest.ts`.
- **Hit:** last-GREEN leaf for a matching key is reused; spawn skipped; `cache_hit: true`.
  **Only GREEN results are cached** — a `failed`/`errored` unit always re-runs.
- **Store:** a **local gitignored cache dir** (not git notes) — an inner-loop dev tool
  wanting per-unit granularity, not a shared whole-tree CI gate.
- **Invalidation:** automatic on any byte change in the hashed inputs.
- **Escape hatch (P1-2): mirror `vv` — a single `--force`** that runs even on a cache hit and
  then overwrites the entry, scoped to the units in this run (no `--no-cache`/`--clear-cache`,
  no env pass-through — there is no nested-invocation case here). Needed because a judge can
  score a **flaky pass**, that green gets cached, and it masks a real regression until an input
  changes — `--force` is the one-flag clean re-run that busts the stuck green. (Green-only
  caching means a red already always re-runs.)

## 9. Run modes

- **`--fail-fast` (iterate)** — stop at the first failing gating unit/tier. Default when
  `test.failFast: true`.
- **`--audit` (run-all)** — run every unit across every tier, aggregate all findings.
- **`--dry-run`** (exists) — preview the full work-list (tiers × evals × variants) and what
  would spawn, without spend; reports where a template would scaffold if no `evals.json`
  exists.
- **`--force`** (§8) — run even on a cache hit, then overwrite.

## 10. Testing strategy

- **Unit (bulk):** variant expander; selector grammar (incl. mixed int/string ids);
  work-list builder; tier-gate state machine; outcome classifier (rate-limit +
  environment + content); cache-key hashing incl. variant + hit/miss; result aggregator.
  All I/O-free.
- **Integration:** stage-once-run-N wiring; **per-unit state isolation** (two units writing
  the same relative path must not collide — assert against a fake state-writing skill);
  cache hit/miss/`--no-cache` against a fake executor (assert spawn counts + gate behavior
  + aggregate shape).
- **System:** minimal — real `claude` spawn is covered by #132's e2e; add one thin
  matrix-mode smoke.
- Follows the repo pyramid (unit > integration > system; only unit coverage-gated) and the
  zero-duplication policy (extract `setupEvalRunnerTestSuite()` helpers early).

## 11. Implementation phasing

The spec covers the whole vision so the pieces fit; the **plan ships incrementally**, each
phase independently shippable and gated by the prior. Order keeps the adopter's "build the
gate first" and front-loads the two P0s' foundations.

1. **A1 rearchitecture + isolation foundation.** Runner owns the per-eval loop;
   stage-once-run-N; **per-unit runtime-state isolation (P0-2)**; single variant (1×1);
   T0 built-in structural gate **with env-injectable smoke (P0-1's zero-token path)** + T2
   all-evals (zero-config); `run.json` aggregate (1×1) with the `errored` taxonomy scaffold;
   per-unit leaf grading.json preserved. *Serial. The token-win + isolation foundation.*
2. **Declared tiers + T1 smoke rung + selector grammar + `--fail-fast` / `--audit`.**
3. **Variant matrix.** Model axis + **env axis (P0-1)** + `gatingModel`/`gatingEnv` +
   per-`(eval × variant)` table + **`errored(environment)` (P1-1)**.
4. **Bounded `concurrency` + rate-limit retry/backoff + `errored(rate-limit)`.**
5. **Per-unit skip cache (variant in key, Nit-3) + `--no-cache` / `--clear-cache` (P1-2).**

*Note:* P0-2 isolation lands in Phase 1 because it applies the moment multiple units share
one staged dir (even serial). The env-axis *cheap path* (T0 env-injectable smoke) also
lands in Phase 1; the full model-driven env matrix lands in Phase 3.

## 12. Future work (out of scope, captured; adopter concurs)

- Split the central `vibe-agent-toolkit.config.yaml` into per-skill config files (central
  is fine today; revisit when config grows).
- Semantic eval **tags** beyond id-selectors.
- Cross-skill eval suites; CI-native reporters (JUnit/SARIF); a `history.json`-style
  pass-rate trend ledger across runs (building on skill-creator's vocabulary).

## 13. Open questions for the plan

**Resolved 2026-06-25** (see `docs/research/2026-06-25-multi-runtime-skill-testing-direction.md`):

- **Gating** = a set-matcher block `gating: { models:[…], env:{…} }` (not scalar). Omitted ⇒
  whole matrix gates + a teaching advisory. No positional "first model" default.
- **Per-tier matrix scoping (was "Q1"):** the cheap tier's variant-scope = the **gating set**;
  the full tier runs the full matrix. With no `gating:` declared, the gating set is the whole
  matrix, so tiers then differ only by *evals* (not variants) — by design.
- **Variant-explosion guardrail (was "Q2"): dropped.** The caller sees the matrix they configured.
- **Cache control (was "Q3"): mirror `vv`** — a single `--force` (run even on a cache hit,
  then overwrite; scoped to the units in this run). No `--no-cache`/`--clear-cache`, no env
  pass-through. **Green-only caching** (deliberate divergence from `vv`: units are billable +
  non-deterministic, so a red always re-runs; `--force` busts a stuck flaky *green*).
- **Retry/backoff (was "Q4"):** `{ attempts: 4, baseMs: 2000, factor: 2, jitter: true, capMs: 60000 }`,
  overridable via `test.retry`.
- **`checks:`** is a top-level deterministic primitive (§5), not a tier `smoke:` field.

**Still open for the plan:**

- **repeat-N (depth axis) — NEW, load-bearing.** Skill invocation is non-deterministic; a
  single-shot run is a Bernoulli draw, not a measurement. The chassis is currently single-shot.
  Add `repeatN` (default? N=3 adaptive→5, per the sibling compat-empirical harness). Cost is
  counted in **runs = variants × repeatN**. The **gating** variant must run repeat-N with an
  explicit pass rule (k-of-N or Wilson lower-bound — threshold TBD) *before* deriving an exit
  code, and a flaky-green gate must not be frozen in cache.
- Exact gating pass-rule threshold (k-of-N vs. Wilson lower-bound) and repeat-N defaults.
