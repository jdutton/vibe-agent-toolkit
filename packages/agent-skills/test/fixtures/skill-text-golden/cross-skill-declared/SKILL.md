---
name: cross-skill-declared
description: Needs the admin api key and org key, plus vat-enterprise-org, helper-skill, upper-ref, spaced-ref, singular-ref, depend-ref and edge-in.
---
# Declared

This fixture requires `vat-tools:vat-enterprise-org` to run.
It depends on `other:helper-skill` as well.
Needs `other:helper-skill` again, a duplicate with no intro.
Requires ANTHROPIC_ADMIN_API_KEY in the environment.
Requires ANTHROPIC_ORG_KEY too, and ANTHROPIC_ADMIN_API_KEY twice.
Bare default: requires ANTHROPIC_API_KEY here, which is excluded.
Not an env key: requires ANTHROPIC_KEY and ANTHROPIC_FOO_BAR here.
No intro nearby: `no-intro:ref-skill` is mentioned alone.
Upper case: REQUIRES `case:upper-ref` and Depends   on `case:spaced-ref` here.
Singular and plural: require `form:singular-ref` and depend on `form:depend-ref`.
No colon is never a ref: requires `plain-word` here.
Mixed case ref: requires `Mixed:Case-Ref` here.
