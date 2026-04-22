# Architecture — Agent Navigator

@README.md

## Agent guidance

Cross-cutting architectural concerns worth knowing before editing any validator or audit code:

- **Validation framework** — VAT uses a three-layer model: **Evidence** (neutral pattern matches), **Observation** (derived capability claims), **Verdict** (context-aware outcomes against declared targets). See [`../skill-quality-and-compatibility.md`](../skill-quality-and-compatibility.md#the-evidence-substrate). This is load-bearing — don't emit a validation issue without knowing which layer you're operating at.

- **Skill packaging shapes** — Four recognized artifact types (standalone skill, skill-claude-plugin, claude-plugin, claude-marketplace). See [`skill-packaging.md`](./skill-packaging.md). Audit's surface enumeration returns all present; never assume a single shape.

- **Validation codes reference** — [`../validation-codes.md`](../validation-codes.md) enumerates every emittable code by name, default severity, and when it fires.
