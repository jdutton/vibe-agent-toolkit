---
title: Full-plugin example
description: End-to-end example of a Claude Code plugin with every asset type (commands, hooks, agents, MCP, skills, files[]).
---

# Full-plugin example

This directory is a self-contained working example of a Claude Code plugin that uses every supported asset type.

See [`docs/guides/marketplace-distribution.md`](../../guides/marketplace-distribution.md#full-plugin-authoring) for the authoring guide.

## Layout

- [`vibe-agent-toolkit.config.yaml`](./vibe-agent-toolkit.config.yaml) — marketplace declaration with pool skills, `source`, and `files[]`.
- `plugins/full-plugin/`:
  - `commands/hello.md` — slash command.
  - `hooks/hooks.json` — hook registry (JSON, parse-validated).
  - `agents/reviewer.md` — subagent definition.
  - `.mcp.json` — MCP server config (JSON, parse-validated).
  - `skills/local-helper/SKILL.md` — plugin-local skill.
  - `.claude-plugin/plugin.json` — author metadata (VAT merges identity fields on top).

## Building

Copy this directory into a scratch project and run:

```bash
vat skills build && vat claude plugin build
```

Output lands at `dist/.claude/plugins/marketplaces/examples/plugins/full-plugin/`.
