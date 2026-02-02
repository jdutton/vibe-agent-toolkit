---
name: invalid-version
description: This skill has an invalid semantic version format
version: not-a-version
---

# Invalid Version Skill

This skill has an invalid version. The schema requires semantic version format (^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$), but "not-a-version" doesn't match.

Expected error: "version" must match pattern ^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$
