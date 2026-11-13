# vibe-agent-toolkit Skills Marketplace

Skills for building, testing, and distributing AI agent skills with [vibe-agent-toolkit](https://github.com/jdutton/vibe-agent-toolkit) (VAT).

**What you get:** skills that teach Claude Code how to author, audit, test and package agent skills, publish Claude plugins and marketplaces, and validate, index and query knowledge resources — all from within your editor.

## Install

### From the terminal

```bash
claude plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace
claude plugin install vibe-agent-toolkit@vat-skills
```

### From within Claude Code

```
/plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace
/plugin install vibe-agent-toolkit@vat-skills
```

### For your project (shared with team)

Add `--scope project` to write to `.claude/settings.json` (committed to git). Team members who clone the repo will be prompted to install the marketplace automatically.

```bash
claude plugin marketplace add jdutton/vibe-agent-toolkit#claude-marketplace --scope project
```

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

Start with the **vibe-agent-toolkit** skill: it is the router, and its table names the sub-skill
for each kind of task — adoption and configuration, skill authoring, audit, knowledge resources,
distribution, RAG, skill review, skill testing, enterprise org admin, markdown rewriting and
coherence audits.

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
