---
paths:
  - "packages/agent-skills/src/validators/**"
  - "packages/cli/src/commands/audit*"
  - "packages/resources/src/link-*.ts"
---

# Dogfood `vat audit --user` before committing changes here

Best-effort QA, not a hard gate — `bun run validate` and pre-commit hooks don't enforce this.
After validation passes but before committing a change to audit, skill validation, or link
traversal logic, run the audit against real installed skills/plugins to catch regressions in
real-world usability:

```bash
# Dogfood: audit the user's installed skills/plugins
bun run vat audit --user --verbose 2>&1 | head -20

# Check for unexpected errors in our own dist skills
bun run vat audit packages/vat-development-agents/dist/skills/
```

Look for: new errors/warnings that weren't there before (regression), crashes or unhandled
exceptions (bug in audit code), false positives on valid skills (overly strict validation),
skills scanning 0 linked files when they should scan more (link traversal not triggering). If
something looks wrong, investigate before committing.
