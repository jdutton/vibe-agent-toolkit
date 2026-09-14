---
paths:
  - "packages/*/examples/**"
  - "docs/demo-guidelines.md"
---

# Every demo goes through a runtime adapter and supports every compatible runtime

A demo never executes an agent directly: it selects a runtime adapter and runs the agent through
it, so the same demo works on every runtime the agent is compatible with. A demo that reaches into
one runtime's SDK is a second execution contract beside the adapters and stops proving the
adapters work. (not enforced)

Reference implementation: `packages/vat-example-cat-agents/examples/conversational-demo.ts`
(runtime selection + CLI transport); patterns, helper layout and the checklist:
[`docs/demo-guidelines.md`](../../docs/demo-guidelines.md). Authoring the agent itself: the
`vat-agent-authoring` skill.
