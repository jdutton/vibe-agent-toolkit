---
name: local-helper
description: Plugin-local skill that demonstrates how plugins ship their own skills alongside commands, hooks, agents, and MCP configs.
---

# local-helper

A minimal skill that lives inside the plugin directory. `vat skills build` auto-discovers this file under `plugins/full-plugin/skills/` and routes its output to `dist/plugins/full-plugin/skills/local-helper/`.
