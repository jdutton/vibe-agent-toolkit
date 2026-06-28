---
# Spec metadata — these comments explain the fields, keep them intact
title: Authentication Spec
version: 0.3.0            # bump this on every release
status: active
parent_spec: /docs/specs/platform-overview.md   # the umbrella spec
related-specs:
  - /docs/specs/billing-spec.md   # cost rules
  - /docs/specs/session-spec.md
owner: platform-team
---

# Authentication Spec

See the [platform overview](/docs/specs/platform-overview.md) for context,
and the [billing spec][billing] for how token usage is charged.

Tokens are validated against the session store before any request proceeds.

```ts
// Example only — the link in this code block must NOT be rewritten
const specPath = "/docs/specs/auth-spec.md";
```

Inline code like `/docs/specs/auth-spec.md` must also be left untouched.

[billing]: /docs/specs/billing-spec.md
