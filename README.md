# vibe-agent-toolkit Skills Marketplace

Development agents and skills for building, testing, and distributing AI agent skills with [vibe-agent-toolkit](https://github.com/jdutton/vibe-agent-toolkit) (VAT).

**What you get:** 8 skills that teach Claude Code how to build portable agent skills, package them into Claude plugins, publish marketplaces, validate resources, and debug issues — all from within your editor.

## Install

### For yourself (user-level)

```bash
claude plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace
claude plugin install vibe-agent-toolkit@vat-skills
```

### For your project (shared with team)

```bash
claude plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace --scope project
claude plugin install vibe-agent-toolkit@vat-skills
```

Project-scope writes to `.claude/settings.json` (committed to git). Team members
who clone the repo will be prompted to install the marketplace automatically.

### Update

```bash
claude plugin marketplace update vat-skills
```

Then start a new Claude Code session. Skills appear as `/vibe-agent-toolkit:skill-name`.

### Pre-release channel

To track the latest pre-release builds, use the `-next` branch instead:

```bash
claude plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace-next
```

## Skills

| Skill | When to use |
|-------|-------------|
| **vibe-agent-toolkit** | Router — agent creation, CLI commands, skill packaging, getting started |
| **distribution** | Build pipeline, npm publishing, marketplace publishing, plugin install |
| **resources** | Resource collections, frontmatter validation, link checking |
| **audit** | Plugin and skill validation with `vat audit` |
| **authoring** | SKILL.md structure, agent architecture, orchestration patterns |
| **debugging** | Reproduce bugs, test local fixes, validate with full build pipeline |
| **install** | Install/uninstall architecture reference for all deployment surfaces |
| **org-admin** | Anthropic org administration (Enterprise/Team admins, requires admin API key) |

## How it works

This branch is a **Claude plugin marketplace** — a structured directory that Claude Code can install directly from GitHub. No npm account or registry needed.

The marketplace is built from the [main branch](https://github.com/jdutton/vibe-agent-toolkit) source using `vat build` and published with `vat claude marketplace publish`. See the [Marketplace Distribution Guide](https://github.com/jdutton/vibe-agent-toolkit/blob/main/docs/guides/marketplace-distribution.md) for how to build and publish your own marketplace.

## Running VAT

```bash
vat <command>                     # Global install
npx vibe-agent-toolkit <command>  # npm (no install)
bunx vibe-agent-toolkit <command> # Bun (no install)
```

## License

MIT
