---
name: vibe-agent-toolkit
description: Use when building, adopting, or learning vibe-agent-toolkit (VAT). Covers agent creation, CLI commands (vat skills, vat resources, vat audit, vat rag), runtime adapters, skill packaging, and resource validation. Routes to specialized sub-skills.
---

# Vibe Agent Toolkit Skill

**Vibe Agent Toolkit (VAT)** is a modular toolkit for building portable AI agents that work across
multiple LLM frameworks and deployment targets. Write your agent logic once as plain TypeScript,
then deploy it to Vercel AI SDK, LangChain, OpenAI, Claude Agent SDK, or any other runtime using
framework adapters. No vendor lock-in.

## Purpose: For Users, Not Contributors

- **This skill** = How to USE VAT to build agents
- **`vibe-agent-toolkit:debugging`** = When VAT itself behaves unexpectedly or you need to test a fix
- **Root CLAUDE.md** = How to DEVELOP the VAT codebase itself

## When to Use VAT

**VAT is great for:** Multi-framework projects, reusable agent libraries, testing across LLM
providers, complex multi-agent orchestration, human-in-the-loop workflows.

**VAT may not be needed for:** Simple one-off scripts where the framework is already decided,
non-TypeScript/JavaScript projects, or cases where you need deep framework-specific features.

## Skill Routing Table

| If you're working on... | Use this skill |
|---|---|
| Writing or structuring a `SKILL.md` file | `vibe-agent-toolkit:authoring` |
| Agent archetypes, orchestration patterns, result envelopes | `vibe-agent-toolkit:authoring` |
| `packagingOptions` (linkFollowDepth, excludeReferencesFromBundle) | `vibe-agent-toolkit:authoring` |
| Resource collections, frontmatter schema validation | `vibe-agent-toolkit:resources` |
| `vat resources validate`, collection config | `vibe-agent-toolkit:resources` |
| Setting up `vat build` + `vat claude build` for a project | `vibe-agent-toolkit:distribution` |
| Configuring `claude:` section in vibe-agent-toolkit.config.yaml | `vibe-agent-toolkit:distribution` |
| npm publishing with plugin postinstall | `vibe-agent-toolkit:distribution` |
| `vat build` / `vat verify` orchestration | `vibe-agent-toolkit:distribution` |
| `--target claude-web` ZIP format | `vibe-agent-toolkit:distribution` |
| Install/uninstall methods, enterprise deployment, Desktop vs CLI paths | `vibe-agent-toolkit:install` |
| `vat audit`, `--compat`, CI validation | `vibe-agent-toolkit:audit` |
| `vat claude org`, Admin API, org users/cost/usage/skills, ANTHROPIC_ADMIN_API_KEY | `vibe-agent-toolkit:org-admin` |
| VAT behaves unexpectedly, debugging VAT, testing local VAT changes, VAT_ROOT_DIR | `vibe-agent-toolkit:debugging` |

## Agent Archetypes (Quick Reference)

Four patterns cover most use cases. For full code examples, see `vibe-agent-toolkit:authoring`.

| Archetype | When to Use |
|---|---|
| **Pure Function Tool** | Stateless validation, transformation, computation — no LLM needed |
| **One-Shot LLM Analyzer** | Single LLM call for analysis, classification, or generation |
| **Conversational Assistant** | Multi-turn dialogue with session state across turns |
| **External Event Integrator** | Waiting for human approval, webhooks, or third-party APIs |

## Core CLI Commands

```bash
# Install VAT CLI globally
npm install -g vibe-agent-toolkit

# Or run without installing (works anywhere vat commands appear below)
npx vibe-agent-toolkit <command>    # npm/Node.js
bunx vibe-agent-toolkit <command>   # Bun

# Top-level orchestration
vat build                                # build all artifacts (skills then claude plugins)
vat verify                               # verify all artifacts (resources, skills, claude)

# Claude plugin commands
vat claude build                         # generate plugin artifacts from built skills
vat claude verify                        # validate plugin artifacts

# Skills
vat skills list                          # list skills in current project
vat skills list --user                   # list user-installed skills
vat skills install npm:@org/my-skills    # install from npm (routes through plugin system)
vat skills build                         # build portable skills only
vat skills validate                      # validate skill quality

# Resources
vat resources validate                   # validate collections (reads config)
vat resources validate docs/ --frontmatter-schema schema.json

# Audit
vat audit                                # audit current directory recursively
vat audit --user                         # audit entire Claude installation
vat audit ./plugins/ --compat            # check surface compatibility

# RAG
vat rag index docs/                      # index markdown into vector DB
vat rag query "my question" --limit 5    # semantic search

# Get help for any command
vat --help
vat skills --help
```

## agent-generator: Creating New Agents

The **agent-generator** is a built-in meta-agent that guides you through designing
high-quality agents via a 4-phase workflow:

1. **GATHER** — Understand your intent and goals
2. **ANALYZE** — Identify agent pattern and requirements
3. **DESIGN** — Make architecture decisions (LLM, tools, prompts)
4. **GENERATE** — Create validated agent package

Minimum input needed:
```json
{
  "agentPurpose": "Review PRs for security issues",
  "successCriteria": "Catches 100% of critical vulnerabilities"
}
```

The generator produces: `agent.yaml`, `prompts/system.md`, `prompts/user.md`,
`schemas/input.schema.json`, `schemas/output.schema.json`, and `README.md`.

**Tips for better results:**
- Be specific about success criteria ("Under 30s, zero false negatives") not vague ("fast enough")
- Name the tools the agent needs upfront (file readers, APIs, etc.)
- Describe domain context (OWASP Top 10, company coding standards, etc.)

## Packaging Markdown for Reuse

VAT's resource compiler transforms markdown files into type-safe TypeScript modules,
enabling prompt libraries, RAG knowledge bases, and shared content across projects.

```bash
npm install -D @vibe-agent-toolkit/resource-compiler
npx vat-compile-resources compile resources/ generated/resources/
```

```typescript
import * as Doc from './generated/resources/doc.js';

Doc.meta.title;                        // type-safe frontmatter
Doc.fragments.introduction.text;       // H2 section content
Doc.text;                              // full markdown
```

Use cases: agent prompt libraries, RAG knowledge bases packaged as npm modules,
multi-project content sharing with versioning.

## Common Workflows

**Create a new agent:**
```bash
# Use agent-generator interactively, then:
vat agent import my-skill/SKILL.md   # import to VAT format
vat skills validate                   # check quality
vat skills build                      # package for distribution
```

**Install and use a community skill:**
```bash
vat skills install npm:@vibe-agent-toolkit/vat-cat-agents
vat skills list --user
# Plugin-aware packages register in Claude's plugin system
# Skills are invoked as /plugin-name:skill-name in Claude Code
```

**Build and publish your own skill package:**
```bash
# Configure vat.skills in package.json + claude: in vibe-agent-toolkit.config.yaml, then:
vat build                 # builds skills + claude plugin artifacts
vat verify                # validates everything
npm publish               # publishes to npm (postinstall registers the plugin)
# Users install with: vat skills install npm:@myorg/my-skills
```

## Success Criteria

You've successfully adopted VAT when:
- Agents have clear input/output schemas (Zod-validated)
- Errors are handled as data (result envelopes), never thrown
- Tests cover success and error paths without real API calls (mock mode)
- Agents work across multiple runtimes via adapters
- Multi-agent pipelines compose via `andThen()` / `match()` helpers

## Documentation Index

- Getting Started Guide
- Agent Authoring Guide — patterns and code examples
- Orchestration Guide — multi-agent workflows
- RAG Usage Guide
- Resource Compiler Guide
- Runtime Adapters
- Examples: `@vibe-agent-toolkit/vat-example-cat-agents`

## Running VAT

VAT can be run without a global install:

```bash
vat <command>                     # If installed globally
npx vibe-agent-toolkit <command>  # npm (downloads on demand)
bunx vibe-agent-toolkit <command> # Bun (downloads on demand)
```

All `vat` commands in this skill and sub-skills accept these alternatives.

## Getting Help

- **CLI Help:** `vat --help`, `vat skills --help`, etc.
- **Examples:** `packages/vat-example-cat-agents/`
- **GitHub Issues:** Report bugs or ask questions

Happy agent building!
