# @vibe-agent-toolkit/vat-development-agents

VAT's own Claude Code plugin, `vibe-agent-toolkit`: the skills an agent loads to work with
vibe-agent-toolkit. The package is also VAT's dogfood: it is built, verified and published with
VAT's own commands.

Skill sources live in [`resources/skills/`](resources/skills/); the router `SKILL.md` lists every
sub-skill and when to load it.

## Installing the plugin

**Install from npm:**
```bash
vat claude plugin install npm:@vibe-agent-toolkit/vat-development-agents
```

**Install from local directory (development):**
```bash
# From the monorepo root — builds, then symlinks the built plugin into Claude Code
vat claude plugin install --build --cwd packages/vat-development-agents
```

**Verify installation:**
```bash
vat claude plugin list
vat skills list --user
```

The plugin lands under `~/.claude/plugins/marketplaces/vibe-agent-toolkit/…` and its skills appear in Claude Code after restarting or running `/reload-plugins`.

## License

MIT © VAT Team
