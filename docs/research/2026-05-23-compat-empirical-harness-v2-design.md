---
title: Empirical Compat Harness v2 — Design
date: 2026-05-23
status: proposed
parent_issue: 100
related_issues: [109]
parent_pr: 108
branch: feat/compat-empirical-harness
---

# Empirical Compat Harness v2 — Design

## Background

PR #108 landed the v1 scaffold for the empirical compat harness
(`packages/dev-tools/src/compat-empirical/`). It can run candidate skills
against `claude-code`, `claude-cowork`, and `claude-chat`, run an LLM
judge over the transcripts, and render a reality-vs-prediction matrix.

Before authoring the corpus and running the first real cycle (the remaining
acceptance criteria for issue #100), this spec proposes a set of harness
improvements that materially affect what the eventual evidence is worth.
The conclusion of brainstorming was: **improve the instrument before
collecting the measurements.**

Four improvement themes were validated as worth pursuing:

1. Probe coverage — single-prompt-per-cell sampling is too thin to
   distinguish trigger-fragility from runtime-fragility.
2. Evidence quality — the deterministic classifier conflates install
   failures, trigger misses, and runtime errors into one `error` bucket,
   which is the single biggest source of false agreement signal.
3. Report fidelity — the v1 scaffold makes promises (per-cell callouts,
   coverage stats) it doesn't keep, and bundles two deferred bug fixes
   from PR #108's review.
4. Automation + methodology — a time-boxed spike on cowork automation,
   judge replay for prompt iteration, and (separately, as issue #109) A/B
   prediction across VAT versions.

This spec splits the work into **three PRs**:

| PR | Themes | Effort | Notes |
|---|---|---|---|
| **PR-1: harness v2 foundations** | §1 + §2 + §3 + §4b | ~3 days | All schema migrations land together |
| **PR-2: cowork driver spike** | §4a | ~4 hours | Docs-only investigation |
| **PR-3: predictions A/B** | §4c | ~1 day | Tracked by issue #109, lands after first real run |

PR-1 unblocks the corpus + run + doc work from the original brief.

## §1 — Probe coverage: multi-prompt + repeat-N + negative prompts

### Schema changes

```ts
// Before
CorpusEntry.triggerPromptRef: z.string()

// After
CorpusEntry.triggerPromptRefs: z.array(z.string()).min(2)
```

**Cross-file validation in `loadManifest`** (Zod alone can't enforce
this because the manifest references prompts by ID, with prompts living
in a separate YAML file):

```ts
// After loading both files and indexing prompts by ID:
for (const entry of manifest.entries) {
  const resolved = entry.triggerPromptRefs.map((id) => {
    const prompt = promptById.get(id);
    if (!prompt) throw new Error(`entry ${entry.id} references missing prompt ${id}`);
    return prompt;
  });
  const hasPositive = resolved.some((p) => p.kind === 'positive');
  const hasNegative = resolved.some((p) => p.kind === 'negative');
  if (!hasPositive || !hasNegative) {
    throw new Error(
      `entry ${entry.id} must reference at least one positive and one negative prompt; ` +
      `got kinds: [${resolved.map((p) => p.kind).join(', ')}]`,
    );
  }
}
```

Requiring negatives at the schema level (rather than treating them as
optional with a soft warning) is the only way to make false-positive
trigger rate a first-class number in the report. Optional negatives
become absent negatives in practice, and the failure-mode taxonomy
loses an entire axis.

```ts
// Two new fields on TriggerPrompt — `kind` required, `tag` optional
TriggerPromptSchema = z.object({
  // ...existing fields
  kind: z.enum(['positive', 'paraphrase', 'edge', 'negative']),
  tag: z.string().optional(),
}).strict();
```

```ts
// New optional input on CorpusManifest (omittable in YAML; default 1)
CorpusManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(CorpusEntrySchema),
  repeatN: z.number().int().positive().default(1),
}).strict();
```

```ts
// RuntimeObservation gets two new fields
RuntimeObservationSchema = z.object({
  // ...existing fields
  promptId: z.string(),         // which prompt was sent
  attemptIdx: z.number().int().nonnegative(),  // 0-based attempt index
}).strict();
```

The cell-key becomes `(skillId, promptId, target, attemptIdx)`.

### Negative prompts

`kind: 'negative'` inverts `expectedBehavior`: invocation is *not* expected.
If the runtime triggers the skill anyway, that's a false-positive trigger
and is recorded as such in the agreement classifier. This is the only
honest way to measure trigger precision; without negatives, we can only
ever measure recall.

### Repeat-N

`repeatN` controls how many times each `(skillId, promptId, target)`
cell is executed. The harness emits one `RuntimeObservation` per
attempt with `attemptIdx ∈ [0, N)`, then the join layer aggregates
across attempts into a single `JoinedMatrixRow` for the cell.

**Why repeat at all.** The agent's decision to invoke a skill is
non-deterministic. The same prompt sent to the same model with the same
loaded skill can trigger or not depending on hidden state (sampling
temperature in the runtime, context window contents, model rev under
the hood). A single-shot probe collapses this into a coin flip we then
treat as a measurement. Repeat-N gives us a discrete trigger-rate per
cell — at N=3 we get four buckets (`3/3`, `2/3`, `1/3`, `0/3`),
enough to distinguish "always triggers" from "usually" from "rarely"
from "never" without inflating cost.

**Default and recommendation.** Default `repeatN: 1` for v1-parity.
**Recommended for any real run: `repeatN: 3`**. N=3 is the lowest value
that yields multiple non-trivial trigger-rate buckets. N=5 would enable
Wilson confidence intervals on trigger-rate (~80% CI half-width on
trigger-rate of 0.6 at N=5 ≈ ±0.21) but the marginal information vs N=3
is small relative to the cost; defer N≥5 until a specific cell's
ambiguity warrants targeted re-probing.

**Driver asymmetry.** Manual and scripted-assisted drivers always
short-circuit to N=1 regardless of config — re-running each cell N
times manually multiplies operator burden linearly and the marginal
information per extra attempt drops fast in a human-loop setting (the
operator's own variance becomes a confound). The scripted
`claude-code` driver honors `repeatN` fully. The methodology section
of the rendered report discloses this asymmetry explicitly so per-bucket
% comparisons aren't accidentally apples-to-oranges.

**Per-attempt independence.** Each attempt **must** run with a fresh
temp `HOME` for the claude-code driver — otherwise prior attempts'
cache, conversation state, or session memory contaminate later
attempts. Currently `setup()` creates a single temp profile that's
shared across all `invoke()` calls. PR-1 changes this so the driver
recreates the temp profile per attempt (cheap — sub-second mkdir of an
empty `.claude/` skeleton). Manual drivers don't have an equivalent
state concept; their N=1 short-circuit makes the question moot.

**Failure handling within an attempt set.** If attempt 0 fails to
install, do we attempt 1 and 2 too, or short-circuit? **Short-circuit
on install-failure** — install failure is a deterministic outcome of
the bundle, not a sampling event, so repeating it just wastes API
calls. The remaining attempts get persisted as deterministic-class
`install-failed` with the same `installResult.notes` and `attemptIdx`
set, so the matrix row's `attemptStats.n` matches the requested N
(making coverage stats honest) but no real invocation happens. Runtime
errors (`runtime-error`, `timeout`) DO repeat — those can be flaky and
the variance is the signal.

**Adaptive extension when N=3 is ambiguous.** When `repeatN === 3` and
the first 3 attempts produce ambiguous results (criteria below), the
harness automatically runs 2 more attempts and judges the cell out of
5. Cap at N=5 — if still ambiguous at 5, the row is tagged
`high-variance` in the report rather than extended further (a
high-variance cell is itself evidence that this skill/runtime pair is
genuinely flaky, which is useful information).

Ambiguity is evaluated from **deterministic signals only** (no judge
verdicts), so the extension decision fits inside the `run` phase
without coupling it to the `judge` phase. The harness extends from
N=3 to N=5 if any of:

1. **Mixed trigger outcomes** — among the 3 attempts, exactly 1 or 2
   produced `not-invoked-engaged` or `not-invoked-empty`. (Trigger-rate
   ∈ {1/3, 2/3} — neither "always" nor "never".) If 0 or 3 attempts
   were `not-invoked-*`, the trigger axis is unambiguous.
2. **Mixed deterministic class among triggered attempts** — among
   attempts where the skill DID invoke (`invoked-output` or
   `invoked-no-output`), the class varies (e.g., one
   `invoked-output`, one `invoked-no-output`). Same skill,
   inconsistent result shape.
3. **Any transient failure** — at least one `timeout` or
   `runtime-error` among the 3, but not all 3. A lone flake among
   successes deserves 2 more probes to determine whether it's a
   consistent failure mode or genuine flake.
4. **Inconsistent refusal** — at least one `refused` but not all 3.
   Guardrails firing sometimes-but-not-always is high-signal and worth
   characterizing.

The harness **skips extension** (stays at N=3) if:

- All 3 attempts produced **identical** deterministic class. Strong
  agreement; more data won't shift the answer.
- Any attempt was `install-failed`. Install is deterministic; the
  short-circuit rule above already populated the slots.
- `repeatN !== 3` (operator explicitly set N=1, N=5, or N=10 — the
  harness honors that setting verbatim and doesn't second-guess).

Each extended cell gets `attemptStats.extendedFromN3: true` so the
report's methodology section can disclose which cells required the
extension and the headline `attemptStats.n` reflects the actual count
(3 or 5).

**Operator-visible behavior.** When the harness extends a cell, it
logs `[run]   extending {skillId}/{promptId}/{target}: ambiguous at
N=3 ({reason}); running attempts 3 and 4` so the operator can see
which cells are consuming the extra budget and why.

Cost impact of adaptive extension is reflected in the "Cost ceiling"
block below.

**Aggregation across attempts.** The join layer builds:

```ts
attemptStats: {
  n: number,                                          // actual count (3 or 5)
  extendedFromN3: boolean,                            // true if adaptive extension fired
  byDeterministicClass: Record<DeterministicClass, number>,
  byJudgeVerdict: Record<JudgeVerdict, number>,
}
```

`JoinedMatrixRow` gains `highVariance: boolean` — set true when
`n === 5 AND extendedFromN3 === true AND the post-N=5 distribution
still satisfies any of the original ambiguity criteria`. This lets the
renderer flag genuinely flaky cells in the report.

A cell is `agree` only if all attempts agreed; otherwise the row adopts
the most-concerning classification across attempts (severity ordering
defined below). The renderer surfaces the per-attempt distribution
inline: `runtime-error (2/3) / failed (3/3)` (for N=3 cells) or
`invoked-output (4/5) / partial (3/5)` (for extended cells).

**Cost ceiling for a realistic corpus.** A 20-skill corpus with 2
prompts per skill (1 positive + 1 negative minimum) at N=3 on
claude-code only:

- **Baseline (no extensions):** 20 × 2 × 3 = 120 attempts × 1 judge
  call each = 240 API calls. Wall time ~5–10 min. API cost ~$5–15
  depending on transcript length and judge token usage.
- **With adaptive extension** (assuming ~30% of cells extend to N=5):
  120 + (0.30 × 40 × 2) = ~144 attempts → ~288 API calls.
  Wall time ~7–12 min. API cost ~$6–18. The budget grows only where
  the signal is most uncertain; cheap cells stay cheap.

Not free, but cheap enough that the variance estimate is clearly worth
it for an evidence artifact intended to gate detector-change proposals.

### Join + render changes

`JoinedMatrixRow`'s key changes from `(skillId, target)` to
`(skillId, promptId, target)`. The `attemptStats` aggregation and the
severity-ordering rule live with the Repeat-N section above; this
section covers only what the renderer does with them.

**Severity ordering for the agreement collapse:**
**`vat-optimistic` (most concerning) → `vat-pessimistic` → `ambiguous`
(least)**. Reasoning: vat-optimistic means *"VAT predicted it works, it
didn't"* — the worst kind of miss because adopters trust an `expected`
verdict; vat-pessimistic means we warned and the warning was
unnecessary, which costs annoyance but not safety; ambiguous is just a
gray-zone signal we should surface honestly rather than collapse.

**Renderer:** the matrix cell shows per-attempt distribution inline as
`runtime-error (2/3) / failed (3/3)` when `attemptStats.n > 1`. When
`n === 1` it renders as the v1 shape (`runtime-error / failed`) for
parity. The new gray-zone callout section (§3) groups cells by the
*pattern* of disagreement, not just by row-level "ambiguous" label.

### Open sub-questions (deferred to implementation)

- Whether `repeatN` should be per-target rather than global (manual
  targets are always 1 anyway — global is simpler).
- Whether to compute Wilson confidence intervals on trigger-rate (only
  meaningful at `repeatN >= 5`; defer until a run actually wants it).

**Resolved during brainstorming:** every corpus entry must reference at
least one `kind: 'positive'` and one `kind: 'negative'` prompt
(`triggerPromptRefs.length >= 2`), enforced in `loadManifest` as
cross-file validation. See schema-changes block above.

## §2 — Evidence quality: finer-grained DeterministicClass + richer judge

### DeterministicClass expansion

```ts
// Before
DeterministicClass = 6 values

// After
DeterministicClass = 9 values:
  invoked-output         // unchanged
  invoked-no-output      // unchanged
  not-invoked-engaged    // [NEW] agent produced output but didn't pick the skill
  not-invoked-empty      // [NEW] agent produced no output at all
  install-failed         // [NEW] installResult.ok === false
  runtime-error          // [NEW] install ok, exit nonzero, errors present
  refused                // [NEW] derived from a regex over the transcript
  timeout                // unchanged
  skipped                // unchanged
```

The `error` value goes away. Anything that was previously `error` splits
into `install-failed` (when `installResult.ok === false`) or `runtime-error`
(everything else).

`not-invoked` splits into two:
- `not-invoked-engaged` — agent produced output but no `invocationSignal`
  matched and no `tool_use` for the skill (the agent saw the prompt but
  didn't pick the skill).
- `not-invoked-empty` — transcript empty (install or trigger silently
  swallowed the request).

`refused` is best-effort: a small regex set over the transcript matching
common refusal templates (`I'm not able to`, `I cannot`, `I will not`, plus
2–3 more after a calibration pass on real transcripts). The LLM judge's
new `refused` verdict corroborates or contradicts the deterministic guess.

### Judge changes

The system prompt currently says *"decide only from the transcript"* but
the user message ships exit status, tool-use events, errors, target, and
driver mode. Reconcile:

1. Rewrite `judge-system.md` → `judge-system.v2.md` with an updated lead
   line: *"decide from the captured runtime facts listed below."*
2. The user-message builder gains `installResult`, the full `errors[]`
   array, and a stderr preview (currently elided).
3. `JudgeVerdictSchema` widens to include `refused`. The
   `record_verdict` tool's `input_schema.properties.verdict.enum`
   mirrors.
4. `RunMetadata.judgePromptSha` automatically pins to v2 since the SHA
   tracks the file contents. Old runs trace to v1, new runs to v2 — no
   manual versioning needed.

### Join classifier updates

`runtimeSucceeded` and `runtimeFailed` in `report/join.ts` need updating
for the new enum:

```ts
runtimeSucceeded = det === 'invoked-output'
                   && (judge === undefined || judge === 'completed')

runtimeFailed = det ∈ {
  install-failed, runtime-error, not-invoked-empty, timeout, refused
} || judge ∈ { failed, off-task, refused }
```

`not-invoked-engaged` deliberately falls into neither bucket — it's a
gray-zone signal (the agent saw the prompt and chose not to use the
skill) and gets surfaced in the report's new gray-zone callout section
(see §3).

### Breaking-change disclosure

Both the `DeterministicClass` and `JudgeVerdict` enum widenings are
schema breaks per VAT's pre-1.0 policy. This is fine — the harness is
private to `@vibe-agent-toolkit/dev-tools` and zero runs have produced
persisted `judgments.json` artifacts yet. No migration code required.

## §3 — Report fidelity + deferred bug fixes

### Gray-zone (mixed-signal) cells

The v1 scaffold says *"cells where the [deterministic and judge] two
disagree are themselves findings; they get a callout below"* — but the
renderer doesn't emit anything. Add a new section after the matrices:

```markdown
### Gray-zone (mixed-signal) cells

Cells where the deterministic and judge signals don't agree on success or
failure. Grouped by pattern:

#### judge-softer-than-det (N cells)
- `own:my-skill` / Code: det=invoked-output, judge=partial — "skill fired
  but only produced 2 of 4 expected sections"
- ...

#### invoked-but-empty (N cells)
- `own:other-skill` / Cowork: det=invoked-no-output — invocation detected
  in transcript but text empty

#### not-invoked-engaged (N cells)
- `official:foo-skill` / Code: agent produced 800 chars of output but
  never picked the skill — possible DESCRIPTION_TOO_VAGUE signal
```

Community-bucket gray-zone rows aggregate to a count + most common
(predicted, observed) shape pair, never named.

### High-variance cells (extended to N=5, still flaky)

Separate from gray-zone (which is about deterministic-vs-judge
disagreement within an attempt), high-variance cells are those that
required adaptive extension to N=5 (per §1) and still satisfy
ambiguity criteria after the extra attempts. These are evidence of
genuine flake in the (skill, runtime) pair and are surfaced in their
own subsection:

```markdown
### High-variance cells (N=5, still ambiguous)

These cells were extended from N=3 to N=5 due to inconsistent first-3
attempts, and remained inconsistent at N=5. The variance itself is
the finding — these skill/runtime pairs trigger or complete
unpredictably and probably warrant a stability flag in the
detector-improvement follow-up.

- `own:my-skill` / Code: trigger-rate 3/5, completion 2/5 — flaky
  trigger pattern
- ...
```

Community-bucket high-variance rows aggregate to a count, never
named.

### Coverage in the executive summary

Compute `{ totalPossible, ran, skipped, byRuntime }` and rewrite the
headline:

```markdown
Across **47/75 cells ran** (claude-code: 25/25, cowork: 12/25, chat: 10/25),
VAT agreed with reality on **X cases (Y%)**.

*28 cells were skipped — chat and cowork have human-in-the-loop drivers
and the operator chose not to drive every cell. Agreement % is computed
over ran cells only.*
```

### Per-bucket headline numbers

Today the headline is one global %. Add a 3-row block:

```markdown
| bucket | ran | agree | optimistic | pessimistic | gray-zone |
|---|---|---|---|---|---|
| own | 18 | 14 (78%) | 1 | 2 | 1 |
| official | 15 | 9 (60%) | 3 | 2 | 1 |
| community | 14 | 8 (57%) | 2 | 3 | 1 |
```

This is the literal answer to issue #100's question of whether VAT is
calibrated to the broader ecosystem or just to its own corpus.

### Install-fail / runtime-error / refused render distinctly

Now that §2 splits the `error` bucket and adds `refused`, the matrix
tables' `observed` column gets the more informative class for free.

### Per-attempt variance

From §1: when `attemptStats.n > 1`, the observed cell renders as
`runtime-error (2/3) / failed (3/3)` so the variance is visible without
clicking through to artifacts.

### Deferred bug fix: `fetch-sources.ts:79` (annotated git tags)

Current `refreshGitRef` does `git fetch --depth 50 origin <ref>` then
`checkout FETCH_HEAD`. For annotated tags (e.g. `v1.2.3` as an annotated
tag object), this writes the tag's commit to `FETCH_HEAD` but the local
tag ref doesn't update — a re-fetch sees no change and returns stale
source if the upstream tag moves.

**Fix:** `git fetch --tags --force` before the named-ref fetch when the
ref is not a SHA. Simpler than special-casing `+refs/tags/<ref>:refs/...`
and covers the same edge case.

### Deferred bug fix: `manual-driver.ts:50` (setup idempotency)

Currently `setup()` mkdirs `${prefix}-${pid}`. Same PID → same path →
`mkdirSyncReal` with `recursive: true` is a no-op the second time, so no
crash today. But two `setup()` calls in the same process leak the prior
bundle into the new "run" — a footgun for any future code that batches.

**Fix:** at start of `setup()`, if `this.bundleRoot` is set, call
`teardown()` first. Three lines. No-op in current flow; safety net for
future code.

## §4 — Automation + methodology

### §4a — Cowork driver spike (PR-2)

Time-box **≤4 hours** to investigate whether `claude-cowork` can be
driven programmatically today via:

- Anthropic Files API (skill bundle as a Files upload)
- Messages API beta with the `skills` feature flag
- `claude` CLI cowork mode (if it exists in the 2.1.x line)
- `console.anthropic.com` admin surface

**Deliverable:** `docs/contributing/cowork-driver-spike.md` reporting
what's possible TODAY, what's blocked, and what would unblock it.

- If automation is feasible, file a follow-up issue with the
  driver-implementation plan. The spike doc stays in place as the
  design reference for that future PR — it is not absorbed into the
  driver code's commit.
- If not, the doc explicitly says *"stay with `scripted-assisted` until
  X lands"* so we stop revisiting the question every quarter.

Either way the doc lives at `docs/contributing/cowork-driver-spike.md`
permanently — it's a record of the question being asked, the methodology
of the answer, and what would change the answer. Removing it would
erase that history.

The value is the answer, not a half-built driver. Either outcome pays
back in operator hours saved across future runs.

### §4b — Judge replay (in PR-1)

Persist verbatim judge I/O so prompt iteration becomes a 30-second loop.

**Artifacts:**
- `judge-calls/<skillId>-<promptId>-<target>-<attemptIdx>.json` containing
  `{ systemPrompt, userMessage, response.content, response.usage, model,
  judgePromptSha }` written during the original judge run.
- `JudgeResult` gains optional `judgeCallRef: string` pointing at the
  artifact path.

**New subcommand:** `compat-empirical re-judge --run <dir> --judge-model
<model>` reads the persisted user messages and re-runs them against a
different model (or the same model with a different system prompt).
Output: `judgments-rerun.json` alongside the original.

**Why this lands in PR-1, not later:** §2 rewrites `judge-system.md` to
v2. With replay wired up during PR-1 development, you can A/B prompt v1
vs v2 in 30 seconds without re-spending operator hours on the runtime
side. The mechanism justifies itself before the PR even merges.

### §4c — Predictions A/B across VAT versions (PR-3, issue #109)

Tracked by issue #109. Lands as its own PR **after the first real run
completes**, because building the A/B mechanism before there's a
detector change to test is YAGNI.

Spec sketch (full design in #109):

- `CorpusManifest` gains optional `predictionVatRef: string` (git SHA or
  branch). When set, `predict` spawns a child VAT at that ref (via
  worktree or temp clone) instead of in-tree VAT.
- Run output gains `predictions-by-vat-ref/<sha>.json` so two prediction
  sets against the same observations are diffable.
- Report renders a comparison column when `--compare-with <other-run>`
  is passed: same observations, two prediction sets, agreement deltas
  highlighted per cell.

The honest signal for detector-improvement proposals (issue #100's
follow-up PR) is: *"VAT@0.1.32 predicted incompatible on this cell;
VAT@HEAD-with-new-detector predicts needs-review; runtime succeeded; net
delta is +N agreement across the matrix."* Without A/B, detector
improvements are unfalsifiable.

## PR sequencing

```
   issue #100 (parent)
        │
        ├── PR #108 ───── merged: v1 scaffold
        │
        ├── PR-1 ──────── this spec: harness v2 foundations (§1 §2 §3 §4b)
        │       │
        │       ├── corpus authoring (manifest.yaml + trigger-prompts.yaml)
        │       ├── first real run (claude-code first; chat/cowork as operator capacity allows)
        │       └── docs/runtime-compatibility-empirical.md  ─── closes issue #100
        │
        ├── PR-2 ──────── cowork spike (§4a; docs/contributing/cowork-driver-spike.md)
        │                 may land in parallel with PR-1; no dependency
        │
        └── issue #109 ── PR-3: predictions A/B (§4c; after first real run)
```

PR-1 unblocks every downstream deliverable. PR-2 is independent. PR-3 is
sequenced after the first real run.

## What follows after these PRs

The original brief's three deliverables become downstream of PR-1:

1. **Corpus authoring** — `packages/dev-tools/corpus/compat-empirical/{
   manifest.yaml, trigger-prompts.yaml}` with 15–25 candidate skills
   spanning pure-prose, shell-using, MCP-using, browser-auth, and
   network-heavy buckets. Own/official skills are named in the manifest;
   community ones are bucket-anonymous in the rendered report per the
   two-bucket discipline.

2. **First empirical run** — `claude-code` only initially (fully
   automated), with chat and cowork covered as operator capacity allows.
   The report's coverage stats (from §3) make partial coverage honest.

3. **`docs/runtime-compatibility-empirical.md`** — the failure-mode
   taxonomy and ≥3 detector-improvement proposals, each citing specific
   matrix cells per the rule-addition bar in
   `docs/validation-rule-design.md`.

These are not in scope for the PRs covered by this spec.

## Non-goals

- No changes to VAT detector code (per #100, evidence first, then a
  separate proposal PR).
- No changes to `RUNTIME_PROFILES` (also per #100).
- No `compat`-badge work (separate effort, blocked on issue #100).
- No grading or ranking of tested skills.
- No new validation codes — the harness produces evidence, not rules.

## Open questions

- Should `repeatN` be per-target or global? (Lean: global. Manual targets
  are always 1 anyway. Deferred to implementation.)
- For §4b, should the persisted judge-call JSON include the raw
  Anthropic SDK response (including request_id) for debugging, or only
  the content blocks needed for replay? (Lean: include both — the file
  is small and request_id is a one-shot debugging aid we won't get back
  if not captured. Deferred to implementation.)

**Resolved during brainstorming:**

- *Manifest validation that every skill references at least one positive
  AND one negative prompt:* **Required.** Enforced as cross-file
  validation in `loadManifest`. See §1 "Schema changes".
- *Cowork spike doc placement when feasible-but-not-implemented:*
  **Leave the doc at `docs/contributing/cowork-driver-spike.md`
  permanently** as a design reference, regardless of whether the spike
  finds automation feasible. The doc is a record of the question +
  answer + what would change the answer. See §4a.

## Acceptance criteria (per PR)

### PR-1

- All schema changes (§1, §2) ship together; `bun run validate` passes.
- `loadManifest` enforces ≥1 positive + ≥1 negative prompt per entry
  with a clear error message and a unit test.
- The `run` command honors `repeatN` for the claude-code driver and
  short-circuits to N=1 for manual drivers, with adaptive extension
  (N=3 → N=5) firing per the criteria in §1 and emitting the
  operator-visible log line.
- Renderer (§3) emits the new gray-zone section, the high-variance
  section, per-bucket headline block, and coverage stats with the new
  "ran" terminology.
- Both deferred bug fixes have regression tests (an annotated tag in
  the cache; a repeat-`setup()` call in the manual driver).
- `compat-empirical re-judge` subcommand exists and round-trips against
  a fixture-run.
- CHANGELOG.md under `## [Unreleased]` gets an `### Internal` entry.

### PR-2

- `docs/contributing/cowork-driver-spike.md` answers the four
  investigation questions and either files a follow-up issue (if
  automation is feasible) or explicitly closes the question (if not).
- CHANGELOG.md `### Internal` entry referencing the spike.

### PR-3 (issue #109)

- Tracked separately. Spec lives on #109; this doc only references it.

## References

- Parent issue: #100 (Empirical Chat | Cowork | Code compat research)
- v1 scaffold PR: #108
- Sub-issue for §4c: #109 (Empirical compat: A/B detector versions on
  shared observations)
- Stance docs: `docs/skill-quality-and-compatibility.md`,
  `docs/validation-rule-design.md`
- Code reference: `docs/validation-codes.md`
- Sister evidence stream: #99 (community corpus scanner foundation)
