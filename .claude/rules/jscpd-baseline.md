---
paths:
  - ".github/.jscpd-baseline.json"
  - "packages/dev-tools/src/duplication-check.ts"
  - "packages/dev-tools/src/jscpd-*.ts"
---

# The duplication baseline tracks progress to zero — it never accepts new duplication

When `bun run duplication-check` fails, refactor: extract the clone into a shared helper. Never run
`duplication-update-baseline` or edit `.github/.jscpd-baseline.json` without the owner's explicit
permission — the baseline is the set of clones still to be removed, and an entry added to make a
red go green is a one-way ratchet that hides the clone forever
([drift class 4](../../docs/contributing/drift-classes.md#4-a-one-way-ratchet)).
(enforced by: `bun run duplication-check`)

Duplication is judged by the gate (both tiers), never by the per-file signal an implementer runs,
so a "move/rename" task must delete the original in the same task — a copy left behind for a later
task is a clone the gate will report.
