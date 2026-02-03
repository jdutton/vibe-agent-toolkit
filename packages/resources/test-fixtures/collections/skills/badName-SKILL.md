---
name: badName
description: This skill has a name that doesn't match the required kebab-case pattern
version: 1.0.0
---

# Bad Name Skill

This skill has an invalid name. The name "badName" uses camelCase, but the schema requires kebab-case (^[a-z0-9-]+$).

Expected error: "name" must match pattern ^[a-z0-9-]+$
