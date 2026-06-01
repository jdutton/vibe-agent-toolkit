# [vat: empirical] Runtime Compatibility — Empirical Report

> Status: rendered scaffold. Headline numbers and matrices below are produced
> by the harness from `packages/dev-tools/corpus/compat-empirical/runs/2026-06-01/`.
> The Failure-Mode Taxonomy and Detector-Improvement Proposals sections are
> authored on top of this rendered base.

## Executive summary

Across **44/88 cells ran** (Code: 44/44, Cowork: 0/22, Chat: 0/22), VAT agreed with reality on **27 cases (61.4%)**.
The harness saw **8 VAT-optimistic** cells (predicted expected, runtime failed),
**3 VAT-pessimistic** cells (predicted incompatible/needs-review, runtime succeeded),
and **6 ambiguous** cells (mixed deterministic/judge signals).

*44 cells were skipped — chat and cowork have human-in-the-loop drivers and the operator chose not to drive every cell. Agreement % is computed over ran cells only.*

| bucket | ran | agree | optimistic | pessimistic | gray-zone |
|---|---|---|---|---|---|
| own | 22 | 13 (59.1%) | 5 | 3 | 5 |
| official | 12 | 7 (58.3%) | 2 | 0 | 10 |
| community | 10 | 7 (70.0%) | 1 | 0 | 8 |

This sample is exploratory, not statistically powered. Findings here justify
detector improvements proposed in a follow-up PR, scoped per the
`docs/validation-rule-design.md` rule-addition bar.

## Methodology

- **Runtimes covered:** claude-code
- **Sample size:** 22 skills (own + official named in findings; community aggregated)
- **VAT version:** 0.1.38
- **Judge model:** claude-sonnet-4-6
- **Auth mode:** subscription (judged via the subscription-authenticated `claude` CLI; no API billing)
- **Judge system-prompt SHA:** a882397ee0c6f884
- **Trigger-prompts SHA:** 910a08771866b499
- **Manifest SHA:** 69dc8b4e873816b9
- **Run date:** 2026-06-01T17:36:38.052Z
- **Driver modes observed:**
- claude-code:scripted

"Completion" is judged two ways per cell, both stored: a deterministic
presence-check (invocation detected? non-empty output? exit status?) and an
LLM judge run through the subscription `claude` CLI. The judge's structured
verdict is parsed from its JSON output (not tool-forced), validated strictly,
and retried once on a parse failure. Cells where the two signals disagree are
themselves findings; they get a callout below.

## Confusion matrices

### Own bucket (named)

| skill | target | prompt | predicted | observed (det / judge) | agreement |
|---|---|---|---|---|---|
| `syn-browser-azlogin` | Code | syn-browser-azlogin-neg | needs-review | runtime-error (3/3) / failed (3/3) | ⚠ pessimistic |
| `syn-browser-azlogin` | Code | syn-browser-azlogin-pos | needs-review | runtime-error (3/3) / failed (3/3) | ✓ |
| `syn-browser-azlogin` | Cowork | - | incompatible | skipped | ? |
| `syn-browser-azlogin` | Chat | - | undeclared | skipped | ? |
| `syn-cli-docker` | Code | syn-cli-docker-neg | needs-review | runtime-error (3/3) / failed (3/3) | ⚠ pessimistic |
| `syn-cli-docker` | Code | syn-cli-docker-pos | needs-review | runtime-error (3/3) / failed (3/3) | ✓ |
| `syn-cli-docker` | Cowork | - | undeclared | skipped | ? |
| `syn-cli-docker` | Chat | - | undeclared | skipped | ? |
| `syn-cli-gh` | Code | syn-cli-gh-neg | needs-review | runtime-error (3/3) / failed (3/3) | ⚠ pessimistic |
| `syn-cli-gh` | Code | syn-cli-gh-pos | needs-review | runtime-error (3/3) / failed (3/3) | ✓ |
| `syn-cli-gh` | Cowork | - | undeclared | skipped | ? |
| `syn-cli-gh` | Chat | - | undeclared | skipped | ? |
| `syn-mcp-postgres` | Code | syn-mcp-postgres-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `syn-mcp-postgres` | Code | syn-mcp-postgres-pos | expected | invoked-output (3/3) / partial (3/3) | ? |
| `syn-mcp-postgres` | Cowork | - | undeclared | skipped | ? |
| `syn-mcp-postgres` | Chat | - | undeclared | skipped | ? |
| `syn-net-httpfetch` | Code | syn-net-httpfetch-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `syn-net-httpfetch` | Code | syn-net-httpfetch-pos | expected | runtime-error (3/3) / failed (3/3) | ⚠ optimistic |
| `syn-net-httpfetch` | Cowork | - | undeclared | skipped | ? |
| `syn-net-httpfetch` | Chat | - | expected | skipped | ? |
| `syn-shell-gitstatus` | Code | syn-shell-gitstatus-neg | expected | runtime-error (3/3) / failed (3/3) | ✓ |
| `syn-shell-gitstatus` | Code | syn-shell-gitstatus-pos | expected | runtime-error (3/3) / failed (3/3) | ⚠ optimistic |
| `syn-shell-gitstatus` | Cowork | - | undeclared | skipped | ? |
| `syn-shell-gitstatus` | Chat | - | incompatible | skipped | ? |
| `vat-audit` | Code | vat-audit-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `vat-audit` | Code | vat-audit-pos | expected | invoked-output (4/5) / completed (3/5) | ✓ |
| `vat-audit` | Cowork | - | expected | skipped | ? |
| `vat-audit` | Chat | - | incompatible | skipped | ? |
| `vat-enterprise-org` | Code | vat-enterprise-org-neg | expected | runtime-error (3/3) / failed (3/3) | ✓ |
| `vat-enterprise-org` | Code | vat-enterprise-org-pos | expected | runtime-error (3/3) / failed (2/3) | ⚠ optimistic |
| `vat-enterprise-org` | Cowork | - | expected | skipped | ? |
| `vat-enterprise-org` | Chat | - | incompatible | skipped | ? |
| `vat-knowledge-resources` | Code | vat-knowledge-resources-neg | expected | runtime-error (3/3) / failed (2/3) | ✓ |
| `vat-knowledge-resources` | Code | vat-knowledge-resources-pos | expected | runtime-error (3/3) / failed (3/3) | ⚠ optimistic |
| `vat-knowledge-resources` | Cowork | - | expected | skipped | ? |
| `vat-knowledge-resources` | Chat | - | incompatible | skipped | ? |
| `vat-rag` | Code | vat-rag-neg | expected | runtime-error (3/3) / failed (3/3) | ✓ |
| `vat-rag` | Code | vat-rag-pos | expected | runtime-error (3/3) / failed (3/3) | ⚠ optimistic |
| `vat-rag` | Cowork | - | expected | skipped | ? |
| `vat-rag` | Chat | - | incompatible | skipped | ? |
| `vat-skill-authoring` | Code | vat-skill-authoring-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `vat-skill-authoring` | Code | vat-skill-authoring-pos | expected | invoked-output (3/3) / completed (1/3) | ✓ |
| `vat-skill-authoring` | Cowork | - | expected | skipped | ? |
| `vat-skill-authoring` | Chat | - | expected | skipped | ? |


### Official bucket (named)

| skill | target | prompt | predicted | observed (det / judge) | agreement |
|---|---|---|---|---|---|
| `frontend-design` | Code | frontend-design-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `frontend-design` | Code | frontend-design-pos | expected | timeout (3/5) / partial (2/5) | ⚠ optimistic |
| `frontend-design` | Cowork | - | expected | skipped | ? |
| `frontend-design` | Chat | - | expected | skipped | ? |
| `kw-code-review` | Code | kw-code-review-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `kw-code-review` | Code | kw-code-review-pos | expected | invoked-output (3/3) / completed (1/3) | ✓ |
| `kw-code-review` | Cowork | - | expected | skipped | ? |
| `kw-code-review` | Chat | - | expected | skipped | ? |
| `kw-sql-queries` | Code | kw-sql-queries-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `kw-sql-queries` | Code | kw-sql-queries-pos | expected | not-invoked-engaged (3/3) / off-task (3/3) | ⚠ optimistic |
| `kw-sql-queries` | Cowork | - | expected | skipped | ? |
| `kw-sql-queries` | Chat | - | expected | skipped | ? |
| `mcp-server-dev` | Code | mcp-server-dev-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `mcp-server-dev` | Code | mcp-server-dev-pos | expected | invoked-output (3/3) / partial (2/3) | ? |
| `mcp-server-dev` | Cowork | - | expected | skipped | ? |
| `mcp-server-dev` | Chat | - | expected | skipped | ? |
| `plugin-dev-skill` | Code | plugin-dev-skill-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `plugin-dev-skill` | Code | plugin-dev-skill-pos | expected | invoked-output (4/5) / partial (2/5) | ? |
| `plugin-dev-skill` | Cowork | - | expected | skipped | ? |
| `plugin-dev-skill` | Chat | - | incompatible | skipped | ? |
| `skill-creator` | Code | skill-creator-neg | expected | not-invoked-engaged (3/3) / completed (3/3) | ✓ |
| `skill-creator` | Code | skill-creator-pos | expected | invoked-output (3/3) / partial (3/3) | ? |
| `skill-creator` | Cowork | - | incompatible | skipped | ? |
| `skill-creator` | Chat | - | incompatible | skipped | ? |


### Community bucket (aggregated)

Per the two-bucket discipline named in `docs/validation-rule-design.md`,
community-bucket findings are reported as patterns and counts, not as named
skills.

| target | predicted | observed (det / judge) | agreement | count |
|---|---|---|---|---|
| Chat | expected | skipped | ? | 2 |
| Chat | incompatible | skipped | ? | 3 |
| Code | expected | invoked-output / completed | ✓ | 2 |
| Code | expected | invoked-output / partial | ? | 2 |
| Code | expected | not-invoked-engaged / completed | ✓ | 5 |
| Code | expected | not-invoked-engaged / off-task | ⚠ optimistic | 1 |
| Cowork | expected | skipped | ? | 5 |


## Callouts

### Gray-zone (mixed-signal) cells

Cells where deterministic and judge signals diverge, or where the deterministic
class itself is a gray-zone signal (invocation detected with no output; agent
engaged but didn't pick the skill). Grouped by pattern. Community-bucket cells
are aggregated as counts only, per the two-bucket discipline.

#### judge-softer-than-det (6 cells)

_det says skill produced output but the judge graded it partial or failed._

- `official:mcp-server-dev` / Code: det=invoked-output, judge=partial
- `official:plugin-dev-skill` / Code: det=invoked-output, judge=partial
- `official:skill-creator` / Code: det=invoked-output, judge=partial
- `own:syn-mcp-postgres` / Code: det=invoked-output, judge=partial
- community: 2 cells (aggregated; not named)

#### not-invoked-engaged (17 cells)

_agent produced output but never picked the skill — possible DESCRIPTION_TOO_VAGUE signal._

- `official:frontend-design` / Code: det=not-invoked-engaged, judge=completed
- `official:kw-code-review` / Code: det=not-invoked-engaged, judge=completed
- `official:kw-sql-queries` / Code: det=not-invoked-engaged, judge=completed
- `official:kw-sql-queries` / Code: det=not-invoked-engaged, judge=off-task
- `official:mcp-server-dev` / Code: det=not-invoked-engaged, judge=completed
- `official:plugin-dev-skill` / Code: det=not-invoked-engaged, judge=completed
- `official:skill-creator` / Code: det=not-invoked-engaged, judge=completed
- `own:syn-mcp-postgres` / Code: det=not-invoked-engaged, judge=completed
- `own:syn-net-httpfetch` / Code: det=not-invoked-engaged, judge=completed
- `own:vat-audit` / Code: det=not-invoked-engaged, judge=completed
- `own:vat-skill-authoring` / Code: det=not-invoked-engaged, judge=completed
- community: 6 cells (aggregated; not named)


### High-variance cells (N=5, still ambiguous)

_No high-variance cells in this run._


## Failure-mode taxonomy

_(Authored by hand on top of this scaffold using the matrix above and the
per-skill transcript artifacts. Each named (skill, target) example is drawn
from the own or official bucket; community cells contribute aggregate counts
only.)_

## Detector-improvement proposals

_(Authored by hand. Each proposal must cite one or more matrix cells above
as evidence, per the rule-addition bar.)_

## Reproducibility

Re-run with:

```bash
bun run -F @vibe-agent-toolkit/dev-tools compat-empirical all \
  --manifest packages/dev-tools/corpus/compat-empirical/manifest.yaml \
  --prompts packages/dev-tools/corpus/compat-empirical/trigger-prompts.yaml \
  --out packages/dev-tools/corpus/compat-empirical/runs/<DATE>/
```

Pinned: VAT version `0.1.38`, judge model `claude-sonnet-4-6`,
manifest SHA `69dc8b4e873816b9`, prompts SHA `910a08771866b499`.
