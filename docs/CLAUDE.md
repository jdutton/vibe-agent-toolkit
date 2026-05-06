# Documentation — Agent Navigator

@README.md

## Agent guidance

When working on anything validation-related, start with the stance docs linked above, not the code:

- **Audit/validation logic changes** → read `skill-quality-and-compatibility.md` first to understand the stance, then `validation-codes.md` for code semantics.
- **Adding/modifying a validation code** → consult `validation-rule-design.md` for the severity-default posture and rule-addition bar. Do not add `error`-severity codes without corpus evidence.
- **Understanding plugin vs skill vs marketplace artifacts** → `architecture/skill-packaging.md`.

The `validation-codes.md` index is the code-level reference; the stance doc is the reasoning behind every default.
