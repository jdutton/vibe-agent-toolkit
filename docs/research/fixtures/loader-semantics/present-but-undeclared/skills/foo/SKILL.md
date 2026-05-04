---
name: foo
description: Test skill foo for loader-semantics fixture (present-but-undeclared case).
---

# Foo Skill

This skill is present on disk but the plugin.json has no "skills" field.
Used to test whether Claude Code auto-discovers skills/ subdirectories
when the manifest does not declare them.
