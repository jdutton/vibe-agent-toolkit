---
# Spec metadata — keep these comments
title: Billing Spec
version: 0.3.0            # bump this on every release
status: active
parent_spec: /docs/specs/platform-overview.md
related-specs:
  - /docs/specs/auth-spec.md   # auth governs which usage is billable
owner: billing-team
---

# Billing Spec

Cross-references the [auth spec](/docs/specs/auth-spec.md) for token rules.

Usage is metered per request and reconciled nightly.
