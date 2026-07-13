# grading.json — the skill-test grading contract

For each eval, `vat skill test run` spawns a blind **executor** (a headless Claude
running the skill under test), captures its transcript **in memory**, then spawns
a separate **grader** that judges that transcript against skill-creator's
`grader.md` rubric and writes a per-eval **fragment**. vat — the sole writer of
`results/` — merges the WITH-arm fragments into **`grading.json`** in the harness
`results/` directory, then reads that file to report pass/fail. (Splitting the
executor from the grader, and keeping vat the sole writer, is what stops an
untrusted skill from grading itself; see [issue #145].)

[issue #145]: https://github.com/jdutton/vibe-agent-toolkit/issues/145

This document is the canonical, machine-checkable definition of that file's
shape. **vat does not tolerate a malformed `grading.json`** — a wrong top-level
structure is rejected loudly (`GradingSkewError`) rather than flattened or
guessed at, because silently accepting bad data pushes confusing failures
downstream.

## Source of truth

The shape originates in skill-creator's
[`references/schemas.md`](../packages/agent-skills/vendor/skill-creator/references/schemas.md)
(the `grading.json` section). skill-creator ships prose + an example but **no
machine schema**, so vat ships one:

- **Zod (runtime validator):** `GradingReportSchema` in
  [`packages/agent-skills/src/skill-test/grading-schema.ts`](../packages/agent-skills/src/skill-test/grading-schema.ts)
- **JSON Schema (for external tooling):** `GradingReportJsonSchema`, generated
  from the Zod schema via `zod-to-json-schema` so the two never drift. Exported
  from `@vibe-agent-toolkit/agent-skills`.

The Zod schema is the single source of truth; the JSON Schema is generated from
it. Do not hand-edit one without the other.

## The shape

`grading.json` is **ONE flat JSON object** with two load-bearing top-level
fields:

```json
{
  "expectations": [
    { "text": "The output includes the name 'John Smith'", "passed": true,  "evidence": "Found in transcript Step 3" },
    { "text": "The spreadsheet has a SUM in cell B10",      "passed": false, "evidence": "No spreadsheet was created" }
  ],
  "summary": { "passed": 1, "failed": 1, "total": 2, "pass_rate": 0.5 }
}
```

### Required fields

| Field | Type | Notes |
|---|---|---|
| `expectations` | array | **One entry per graded expectation across ALL evals.** Not grouped per-eval. |
| `expectations[].text` | string | The expectation being graded. |
| `expectations[].passed` | boolean | Verdict. |
| `summary` | object | Aggregate counts. The **exact** aggregate of `expectations` (see below). |
| `summary.passed` | non-negative integer | Count of passed expectations. Must be `<= summary.total`. |
| `summary.total` | non-negative integer | Total expectations evaluated. |

Counts are non-negative integers (a negative or float count is rejected) and
`summary.passed` may never exceed `summary.total`.

### Optional / recommended fields

`expectations[].evidence` (string) is strongly recommended. `summary.failed` and
`summary.pass_rate` are documented but optional. skill-creator's grader also
emits `execution_metrics`, `timing`, `claims`, `user_notes_summary`, and
`eval_feedback`. vat **passes all of these through untouched** (Postel: validate
what we depend on, carry the rest). Extra fields are **not** "bad JSON"; a wrong
top-level *structure* is.

`runNonce` (string) is optional in the schema but **required by the harness at
run time**: `vat skill test run` stamps a secret per-run nonce into every
**grader** prompt (delivered only via stdin, never written to disk or an argv)
and each grader must copy it verbatim into its fragment's top-level `runNonce`.
vat re-verifies the nonce on every fragment as it merges — a missing or wrong
nonce aborts the run. This is how a forged or left-behind result written by
untrusted skill code in the shared sandbox is detected: that code never receives
the nonce, so it cannot mint a fragment vat will accept. External tooling
validating a grading.json off-line need not supply it.

## What is rejected

A **per-eval nested** shape is the common mistake — the grader (an LLM) reaches
for it when the target shape is under-specified:

```json
{
  "skill_name": "poc-skill",
  "evals": [
    { "id": 1, "expectations": [ ... ], "summary": { ... } }
  ]
}
```

This has no top-level `expectations`, so it is rejected with a targeted message
pointing at this document. The fix is to emit the flat shape above — every
graded expectation in a single top-level `expectations` array — never wrapped in
an `evals` array.

## How the flat shape is enforced

1. **Producer side:** vat itself is the sole producer of `grading.json` —
   `mergeFragmentsToGrading`
   ([`fragment-merge.ts`](../packages/agent-skills/src/skill-test/fragment-merge.ts))
   collects every WITH-arm grader fragment and flattens their per-eval
   `expectations` into the single top-level `expectations` array above. Each
   grader fragment's shape is pinned by the grader prompt (`buildGraderPrompt` in
   [`grader-prompt.ts`](../packages/agent-skills/src/skill-test/grader-prompt.ts)),
   and `assertGraderPromptInvariants` fails a built prompt that drops a required
   directive.
2. **Consumer side:** `parseGradingJson`
   ([`grading-adapter.ts`](../packages/agent-skills/src/skill-test/grading-adapter.ts))
   validates against `GradingReportSchema` and throws `GradingSkewError` on any
   mismatch.
3. **Verdict reconciliation:** `reconcileGrading` (same file) recomputes the
   pass/fail counts from the authoritative per-expectation `passed` flags and
   refuses to trust the grader's self-reported `summary` alone. It throws
   `GradingSkewError` when the grader graded **zero** expectations (nothing was
   graded — never a pass) or when `summary` disagrees with the recomputed counts
   (a grader emitting `summary {5,5}` next to a failing expectation is a bug, not
   a pass). The recomputed verdict drives the printed `PASS N/N` / `FAIL N/N`
   summary and the exit code.

## Exit codes and `--allow-eval-failure`

By **default** (fail-closed) a completed run with a failing verdict exits **4**
(`EvalFailure`), distinct from the harness-breakage codes (1 internal / 2
preflight / 3 bootstrap) so CI can gate on eval outcomes without conflating them
with harness breakage — a consumer can `case $? in 0);; 4) tolerate;; *) hard
fail;; esac`. Pass `--allow-eval-failure` (interactive opt-out) to downgrade a
failing verdict to exit **0**; the pass/fail count then lives only in the summary
string and `grading.json`.

The end-to-end producer→consumer path is exercised by the opt-in e2e test in
`packages/cli/test/system/skill-test.system.test.ts`
(`VAT_SKILL_TEST_E2E=1`), which runs a real Claude session and asserts the
written `grading.json` parses.
