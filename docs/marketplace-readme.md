# vibe-agent-toolkit Skills Marketplace

Development agents and skills for building with [vibe-agent-toolkit](https://github.com/jdutton/vibe-agent-toolkit).

## Install

```
/plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace
```

## Skills

| Skill | Description |
|-------|-------------|
| vibe-agent-toolkit | Router skill — covers agent creation, CLI commands, skill packaging |
| distribution | Build, publish & install pipeline for Claude plugins |
| resources | Resource collections, frontmatter validation, link checking |
| audit | Plugin and skill validation with `vat audit` |
| authoring | SKILL.md authoring and agent architecture design |
| debugging | Debug unexpected VAT behavior and test fixes |
| install | Install/uninstall architecture reference |
| org-admin | Anthropic org administration for Enterprise/Team admins |

## Running VAT

```bash
vat <command>                     # Global install
npx vibe-agent-toolkit <command>  # npm (no install)
bunx vibe-agent-toolkit <command> # Bun (no install)
```

## License

MIT
