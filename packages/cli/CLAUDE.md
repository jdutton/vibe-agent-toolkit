# CLI Package Development Guidelines

This document provides guidance specific to developing the vat CLI tool.

## Validation Framework References

Audit and related commands (`vat audit`, `vat skills validate`, `vat resources validate`) rely on VAT's unified validation framework. Before changing validator logic, read:

- [`../../docs/skill-quality-and-compatibility.md`](../../docs/skill-quality-and-compatibility.md) — VAT's stance; the three-layer evidence/observation/verdict model.
- [`../../docs/validation-codes.md`](../../docs/validation-codes.md) — Every code by name, default severity, and what triggers it.
- [`../../docs/validation-rule-design.md`](../../docs/validation-rule-design.md) — Rule-addition discipline; never ship an `error`-severity code without corpus evidence.
- [`../../docs/architecture/skill-packaging.md`](../../docs/architecture/skill-packaging.md) — The four recognized artifact shapes and which codes apply to each.

## CLI Package Architecture Principles

### The CLI Must Remain "Dumb"

**Critical Rule**: The CLI package sits at the top of the dependency chain. No other package can depend on it. This means:

✅ **CLI SHOULD contain**:
- Command definitions and argument parsing (Commander.js)
- User-facing help text and documentation
- Orchestration logic (calling other packages in sequence)
- Error handling and user-friendly error messages
- Output formatting (YAML, progress indicators)

❌ **CLI SHOULD NOT contain**:
- Business logic that other packages might need
- Path resolution algorithms
- File system utilities
- Validation logic
- Build/conversion logic
- Any reusable functionality

Rationale, the "right place for logic" table, and a before/after worked example live in
[`../../docs/architecture/cli.md`](../../docs/architecture/cli.md#why-the-cli-layer-stays-dumb).

### Quick Check: Does This Belong in CLI?

Ask yourself:
1. **"Could another package need this logic?"** → If yes, move to utils or the specific runtime package
2. **"Is this about user interaction?"** → If yes, CLI is probably fine
3. **"Does this involve file paths/resolution?"** → Probably belongs in utils or the consumer package
4. **"Is this domain logic?"** → Belongs in the domain package (agent-config, rag, runtime-*, etc.)

`vat audit`'s scanning logic is an intentional exception to "reuse everything" — see
[`.claude/rules/audit-scanning-independence.md`](../../.claude/rules/audit-scanning-independence.md),
which fires automatically when you touch the audit command.

### Skill Reference Resolution

Project-aware skill-reference resolution lives in `src/skill-resolution/`. Any command that takes a skill by name or path resolves it through `resolveSkillReference(ref, cwd)` there — so **future CLI work extends that module, not a new copy.** (This is the exception to "the CLI must be dumb": the resolver is CLI-only because its sole consumers are CLI commands.) See [`../../docs/architecture/skill-packaging.md`](../../docs/architecture/skill-packaging.md#skill-reference-resolution) — "Skill Reference Resolution".

**Current state, so you extend the right thing:** `resolveSkillReference` has exactly one caller — `commands/skill/test/run.ts`. `vat audit` and `vat skill review` are path-only and have not been converged onto it; `vat skill review` still carries its own `resolveSkillPath`. Both call `skill-resolution/packaging-config.ts` (`resolveSkillPackagingConfig`) — that answers "what packaging options apply to this skill", not "what subject does this reference name", so it is not the resolver. Do not read the rule above as a description of what the code already does.

## Writing CLI Help Text

Help-text authoring conventions — what makes good `--help` output, Commander.js patterns, help
text testing, the new-command checklist — are enforced by
[`.claude/rules/cli-help-text.md`](../../.claude/rules/cli-help-text.md). It fires automatically
whenever you touch a command file under `src/commands/` or a doc under `docs/`.

## Command Implementation, Output, and Testing Patterns

The command file skeleton, the `handleCommandError` pattern, and CLI-specific system-test
patterns live in [`../../docs/architecture/cli.md`](../../docs/architecture/cli.md) — see
"Command Structure", "Error Handling", and "Testing Patterns".
