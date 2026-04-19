---
name: vibe-agent-toolkit
description: Use when starting VAT work or deciding which VAT sub-skill applies. Router that points at sub-skills for adoption, skill/agent authoring, audit, distribution, RAG, knowledge resources, skill review, and enterprise org admin.
---

# Vibe Agent Toolkit

**Vibe Agent Toolkit (VAT)** is a modular toolkit for building, packaging, and distributing portable AI agents and skills that work across multiple Claude surfaces and adjacent frameworks. Write skill or agent content once; VAT handles validation, packaging, plugin/marketplace layout, and npm publishing.

This is a router skill. Load the sibling sub-skill that matches the work you're doing — each sub-skill owns one slice of VAT's surface and is designed to be pulled in on demand.

## When to Use VAT

Good fits:

- Publishing a Claude skill or plugin to npm with a proper marketplace layout
- Multi-runtime agent projects (Vercel AI SDK, LangChain, OpenAI, Claude Agent SDK)
- Validating plugins / skills / marketplaces with `vat audit` before shipping
- Enforcing frontmatter schemas across large markdown corpora
- Wiring RAG indexing into an agent project

Poor fits:

- Simple one-off scripts where the framework is already decided
- Non-TypeScript/JavaScript projects
- Cases where you need deep framework-specific features with no reuse goal

## Picking a Sub-skill

| If you're working on... | Load |
|---|---|
| New project setup, `vibe-agent-toolkit.config.yaml` orientation, repo structure, vibe-validate integration, npm postinstall | `vibe-agent-toolkit:vat-adoption-and-configuration` |
| Writing or revising a SKILL.md — frontmatter, body, references, packagingOptions, validation overrides | `vibe-agent-toolkit:vat-skill-authoring` |
| TypeScript agent archetypes, `agent.yaml`, result envelopes, orchestration, runtime adapters | `vibe-agent-toolkit:vat-agent-authoring` |
| `vat audit` on plugins, marketplaces, skills, or settings — including `--compat`, `--exclude`, `--user`, CI use | `vibe-agent-toolkit:vat-audit` |
| Markdown collections, `resources:` config, frontmatter schema validation, `vat resources validate` | `vibe-agent-toolkit:vat-knowledge-resources` |
| `vat build`, `vat verify`, plugin/marketplace layout, npm publishing, postinstall | `vibe-agent-toolkit:vat-skill-distribution` |
| `vat rag index` / `vat rag query`, embedding providers, vector stores, chunking | `vibe-agent-toolkit:vat-rag` |
| Pre-publication quality review, `vat skill review`, validation-code triage | `vibe-agent-toolkit:vat-skill-review` |
| Anthropic Admin API: org users, cost/usage, workspace skills, `ANTHROPIC_ADMIN_API_KEY` | `vibe-agent-toolkit:vat-enterprise-org` |

## CLI Surface at a Glance

```bash
vat --help                 # top-level help
vat build                  # build all artifacts (skills → claude plugins)
vat verify                 # validate all artifacts
vat skills validate        # validate skill quality
vat resources validate     # validate markdown collections
vat audit                  # audit plugins/skills/marketplaces/settings
vat rag index docs/        # index markdown for RAG
vat skill review <path>    # pre-publication review
vat claude org --help      # enterprise admin surface
```

Each sub-skill covers its slice of the CLI in depth — don't memorize this table, load the sub-skill when you need detail.

## Getting Help

- `vat --help` and `vat <group> --help --verbose` for CLI depth
- Repo docs: the VAT repository's `docs/` directory carries the full setup guide, architecture notes, and design references (not bundled with this plugin)
- Contributor reference docs (debugging VAT, install architecture) live under `docs/contributing/` in the VAT repo
