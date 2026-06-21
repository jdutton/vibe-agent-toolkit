# grading.json — the skill-test grading contract

`vat skill test run` spawns a headless Claude "experimenter" that, for each eval,
dispatches an executor, grades the executor's output with skill-creator's
`grader.md` rubric, and writes the result to **`grading.json`** in the harness
`results/` directory. vat then reads that file to report pass/fail.

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
| `summary` | object | Aggregate counts. |
| `summary.passed` | number | Count of passed expectations. |
| `summary.total` | number | Total expectations evaluated. |

### Optional / recommended fields

`expectations[].evidence` (string) is strongly recommended. `summary.failed` and
`summary.pass_rate` are documented but optional. skill-creator's grader also
emits `execution_metrics`, `timing`, `claims`, `user_notes_summary`, and
`eval_feedback`. vat **passes all of these through untouched** (Postel: validate
what we depend on, carry the rest). Extra fields are **not** "bad JSON"; a wrong
top-level *structure* is.

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

1. **Producer side:** the experimenter prompt
   (`DEFAULT_EXPERIMENTER_PROMPT` in
   [`experimenter-prompt.ts`](../packages/agent-skills/src/skill-test/experimenter-prompt.ts))
   pins the shape with an explicit instruction and example, and
   `assertPromptInvariants` fails any prompt override that drops the pin.
2. **Consumer side:** `parseGradingJson`
   ([`grading-adapter.ts`](../packages/agent-skills/src/skill-test/grading-adapter.ts))
   validates against `GradingReportSchema` and throws `GradingSkewError` on any
   mismatch.

The end-to-end producer→consumer path is exercised by the opt-in e2e test in
`packages/cli/test/system/skill-test.system.test.ts`
(`VAT_SKILL_TEST_E2E=1`), which runs a real Claude session and asserts the
written `grading.json` parses.
