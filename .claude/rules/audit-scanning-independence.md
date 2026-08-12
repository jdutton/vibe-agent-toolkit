---
paths:
  - "packages/cli/src/commands/audit.ts"
  - "packages/cli/src/commands/audit/**"
  - "packages/cli/src/commands/audit-settings.ts"
---

# `vat audit`'s scanning logic is independent of `discovery.scan()` — do not converge them

**Intentional Architectural Decision**: The `vat audit` command maintains custom scanning logic
rather than using `discovery.scan()`.

**Why**:
- `discovery.scan()` is optimized for VAT agent resources (finds markdown files, extracts
  frontmatter)
- Audit needs to find multiple file types in specific directory structures (`.claude-plugin/`
  directories, JSON manifests, TypeScript/JavaScript files)
- Different scanning requirements = different scanning implementations

**What IS shared** — reuse these, don't reimplement:
- ✅ Skill validation logic (uses shared `validateSkill` from agent-skills)
- ✅ Validation result formatting (uses shared `validate` function)
- ✅ Claude paths resolution (uses `@vibe-agent-toolkit/utils/claude-paths`)

**What is NOT shared** — do not try to unify these:
- ❌ Directory scanning (audit's requirements differ from discovery's design)
- ❌ File type detection (audit looks for `.claude-plugin/` structure, not markdown)

**This is not technical debt.** It's recognition that discovery and audit have fundamentally
different scanning needs. Forcing them to share scanning logic would violate single
responsibility principle and make both implementations more complex.
