# Agent Commands

Manage and execute AI agents defined in agent.yaml manifests.

## Overview

VAT agents are defined using Kubernetes-style YAML manifests that specify:
- Agent metadata (name, version, description)
- LLM configuration (provider, model, parameters)
- Tools (RAG, functions, APIs)
- Prompts (system, user templates)
- Resources (documentation, templates, examples)

## Commands

### `vat agent validate <path>`

Validate agent manifest and check prerequisites.

**Usage**:
```bash
vat agent validate ./my-agent
vat agent validate ./my-agent/agent.yaml
vat agent validate packages/vat-development-agents/agents/agent-generator
```

**Validation checks**:
- Manifest schema validation (apiVersion, kind, metadata, spec)
- LLM provider and model configuration
- Tool configurations (RAG databases, function files)
- Resource file existence (prompts, docs, templates)
- Prompt references ($ref paths)

**Output**: the report envelope (YAML) on stdout; the findings, human-readable, on stderr.
One manifest per run, so `examined` is 1. Every finding is located at the manifest,
relative to `data.root` (the working directory):

- `AGENT_MANIFEST_INVALID` (error) — one per schema violation; `field` is the dotted key path
- `AGENT_REFERENCE_MISSING` (error) — a prompt `$ref`, a resource path or the RAG database does not exist
- `AGENT_REFERENCE_UNREADABLE` (error) — a referenced path exists but the OS refused access
- `AGENT_RAG_NO_SOURCES` (warning) — `spec.rag` names no sources

```yaml
status: findings          # ok | findings | error
examined: 1
findings:
  - code: AGENT_REFERENCE_MISSING
    severity: error
    message: "System prompt not found: ./prompts/system.md"
    location: my-agent/agent.yaml
summary: { errors: 1, warnings: 0, info: 0 }
gate: { strict: false }
durationMs: 12
data:
  root: /abs/path/to/project
  manifest: { name: my-agent, version: 0.1.0, path: my-agent/agent.yaml }   # name/version null when the manifest does not validate
```

**Exit codes** (derived from the document):

| Exit | `status` | When |
|---|---|---|
| `0` | `ok` / `findings` | No error-severity finding (a warning never fails the run) |
| `1` | `findings` | An error-severity finding — a schema violation or an unreachable reference |
| `2` | `error` | No manifest to judge; `error.code` says why: `USAGE_INVALID` (the path or name names no manifest, or no `projectRoot`), `INPUT_UNREADABLE` (the OS refuses the manifest, or it is not YAML, or — for a name — an agent search path it must look in) |

### `vat agent build <pathOrName>`

Build an agent as an Agent Skill (`--target skill`, the one target VAT builds).
The default output is `<package root>/dist/vat-bundles/skill/<agent-name>/`, so
without `--output` the agent must sit inside an npm package.

**Output**: the report envelope (YAML) on stdout. One agent per run: `examined`
is 1 when it was built, and a build publishes `ok` or `error` — nothing it
reports is a finding.

```yaml
status: ok                # ok | error
examined: 1
data:
  agent: my-agent
  target: skill
  output: /abs/path/dist/vat-bundles/skill/my-agent
  files: [/abs/path/dist/vat-bundles/skill/my-agent/SKILL.md, ...]
```

**Exit codes** (derived from the document): `0` built; `2` nothing built, with
`error.code`: `USAGE_INVALID` (a `--target` other than `skill`, no `projectRoot`,
no manifest at the path or name, or no `package.json` for the default output),
`CONFIG_INVALID` (the manifest does not validate, declares no
`spec.prompts.system.$ref`, or that `$ref` names no file), `INPUT_UNREADABLE` (an
agent search path a name is looked up in cannot be read, the
manifest is unreadable or not YAML, or the OS refuses its system prompt,
`scripts/`, `LICENSE.txt` or `package.json` — only an absence is "not there"; a named pipe,
socket or device under `scripts/` is refused unopened),
`RUN_INCOMPLETE` (the packager refused the bundle's content, e.g. a stale nested
`SKILL.md` in the output: one `SKILL_PACKAGING_FAILED` error finding at the agent,
relative to the project root; or an output the OS will not let the build write — a
full disk, a read-only or unwritable `--output`, a file in its way — with no finding).

### `vat agent import <skillPath>`

Convert a SKILL.md into an agent.yaml (see [docs/cli/import.md](../../../docs/cli/import.md)).

**Output**: the report envelope (YAML) on stdout, `data: { agentPath }`. One skill
per run: `examined` is 1 when agent.yaml was written; an import publishes `ok` or
`error`.

**Exit codes** (derived from the document): `0` written; `2` nothing written, with
`error.code`: `USAGE_INVALID` (no SKILL.md at the path, or agent.yaml exists and
`--force` was not given), `INPUT_UNREADABLE` (the SKILL.md cannot be read, its
frontmatter is not YAML, or no Agent Skills schema accepts it), `RUN_INCOMPLETE`
(the agent.yaml write failed). An `--output` whose directory does not exist is
`USAGE_INVALID`.

### `vat agent installed`

List installed agent skills across scopes (`--scope user|project|all`, default
`all`): `user` is `skills/` under the Claude config dir (`$CLAUDE_CONFIG_DIR`,
else `~/.claude`), `project` is `.claude/skills/` under the working directory
(the one `--cwd` names, when given).

**Output**: the report envelope (YAML) on stdout; the human list on stderr.
`examined` counts the scopes scanned. An absent scope directory is scanned and
empty. One the OS will not list is a `SCAN_PATH_UNREADABLE` warning finding —
the list is then a floor, not the answer — located at the scope directory's
last two path segments (`.claude/skills` by default), with `field` naming the
scope (both scopes can share that location) and the full path in the message; the other scopes are still listed.

```yaml
status: ok                # ok | findings | error
examined: 2
data:
  scanned: [user, project]
  skills:
    - { name: my-agent, scope: user, type: directory, path: /home/me/.claude/skills/my-agent }
    - { name: dev-agent, scope: project, type: symlink, path: /repo/.claude/skills/dev-agent }
```

`type` is `symlink` for a `--dev` install and `directory` for a copied one.

**Exit codes** (derived from the document): `0` listed (an unreadable scope is a
warning); `2` `USAGE_INVALID` for a `--scope` or `--runtime` it does not know.

### `vat agent list`

List the agents discovered under `packages/vat-development-agents/agents/`,
`agents/` and `.` (resolved against the working directory).

**Output**: the report envelope (YAML) on stdout; the human list on stderr.
`examined` counts the search paths scanned (3); an absent one is scanned and
empty. A search path, agent directory or manifest the OS will not read is a
`SCAN_PATH_UNREADABLE` warning finding located relative to `root` — the list is
then a floor, not the answer — and every readable path is still listed.

```yaml
status: ok                # ok | findings | error
examined: 3
data:
  root: /repo             # the working directory: the one absolute path
  agents:
    - { name: my-agent, version: 0.1.0, path: agents/my-agent }
```

**Exit codes** (derived from the document): `0` listed (an unreadable path is a
warning); `2` only for a defect in VAT (`INTERNAL_ERROR`).

### `vat agent install <agentName>`

Install a built agent's bundle (`dist/vat-bundles/<runtime>/<name>/` in the
agent's package) into a scope: `user` (`skills/` under `$CLAUDE_CONFIG_DIR`,
else `~/.claude/skills/`; default) or `project` (`.claude/skills/` under the
working directory, which `--cwd` sets). `vat agent uninstall` resolves both
scopes the same way. `--dev` symlinks instead of copying (not on
Windows); `--force` replaces an existing install.

**Output**: the report envelope (YAML) on stdout, `examined: 1`, and
`data: { agent, installPath, symlink }`. An install publishes `ok` or `error`.

**Exit codes** (derived from the document): `0` installed; `2` nothing
installed, with `error.code`: `USAGE_INVALID` (an unknown `--scope` or
`--runtime`, a name that is not one path segment or names no agent, already
installed without `--force`, or no `package.json` encloses the agent),
`NOT_IMPLEMENTED` (`--dev` on Windows), `CONFIG_INVALID` (the manifest does not
validate), `INPUT_UNREADABLE` (the bundle was never built, or a search path, the
manifest, the bundle or the install path cannot be read), `RUN_INCOMPLETE` (a
write under the scope directory failed; under `--force` the message says when
the previous install was already removed).

### `vat agent uninstall <agentName>`

Remove an install from a scope (`--scope user|project`). A `--dev` install —
a dangling one included — has only its link removed, never its target.

**Output**: the report envelope (YAML) on stdout, `examined: 1`, and
`data: { agent, installPath, wasSymlink }`. An uninstall publishes `ok` or
`error`.

**Exit codes** (derived from the document): `0` removed; `2` nothing removed,
with `error.code`: `USAGE_INVALID` (an unknown `--scope` or `--runtime`, a name
that is not one path segment, or the agent is not installed in that scope),
`INPUT_UNREADABLE` (the install path cannot be read), `RUN_INCOMPLETE` (the
removal failed).

---

## Manifest Format

VAT uses Kubernetes-style manifests for agent configuration:

```yaml
apiVersion: vat.dev/v1
kind: Agent

metadata:
  name: "agent-name"
  version: "0.1.0"
  description: "Agent description"

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5
    temperature: 0.7

  prompts:
    system:
      $ref: ./prompts/system.md

  tools:
    - name: tool_name
      type: library
      description: Tool description

  resources:
    resource_id:
      path: ./path/to/file
      type: template
```

See `@vibe-agent-toolkit/schema` for complete schema reference.

## Examples

### Example 1: Validate agent-generator

```bash
cd packages/vat-development-agents
vat agent validate agents/agent-generator
```

### Example 2: Validate with custom path

```bash
vat agent validate ./my-custom-agent/agent.yaml
```

## Environment Variables

- `ANTHROPIC_API_KEY` - API key for Anthropic (Claude)
- `OPENAI_API_KEY` - API key for OpenAI
- `GOOGLE_API_KEY` - API key for Google (Gemini)

## Requirements

Each `vat agent` subcommand declares its own `projectRoot` and config policy:

| Subcommand | `projectRoot` | Config |
|---|---|---|
| `vat agent list` | optional (tolerates absence) | not used |
| `vat agent installed` | N/A | not used |
| `vat agent build <pathOrName>` | required (errors without `vibe-agent-toolkit.config.yaml` or `.git/` ancestor) | required file with `agents.*` fields populated |
| `vat agent run <pathOrName> <input>` | optional (path-explicit; tolerates absence) | optional (uses defaults if absent) |
| `vat agent validate <pathOrName>` | required | optional (uses defaults if absent) |
| `vat agent import <skillPath>` | N/A | not used |
| `vat agent install <agentName>` | N/A | not used |
| `vat agent uninstall <agentName>` | N/A | not used |

**Why `build` and `validate` require `projectRoot`:** both are explicit-adoption
operations. Building or source-validating an agent without an authoring
boundary would silently accept arbitrary trees as "the project" and would not
participate in the unified validation framework. `vat agent run` is
path-explicit and runs from anywhere; `vat agent list` discovers without
needing a project context.

See [Roots and Config — Canonical Concepts](../../../docs/concepts/roots-and-config.md)
for terminology.

## See Also

- [@vibe-agent-toolkit/schema](../../schema/README.md) - Schema reference
- [agent-generator](../../vat-development-agents/agents/agent-generator/README.md) - Example agent
- [RAG Commands](./rag.md) - Indexing documentation for RAG tools

## Example reports

Each block below is a real document from the built CLI, trimmed where noted; `packages/cli/test/integration/tagged-report-examples.integration.test.ts` validates every `vat-report=<verb>` block against that verb's registered schema.

### `agent list`

Agents discovered under the project. Produced by `vat agent list`.

```yaml vat-report=agent list
status: ok
examined: 3
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 19
data:
  root: /work/agents
  agents:
    - name: widget-reviewer
      version: 0.1.0
      path: widget-reviewer
```

### `agent validate`

One manifest validated. Produced by `vat agent validate widget-reviewer`.

```yaml vat-report=agent validate
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 49
data:
  root: /work/agents
  manifest:
    name: widget-reviewer
    version: 0.1.0
    path: widget-reviewer/agent.yaml
```

### `agent build`

The agent built as an Agent Skill. Produced by `vat agent build widget-reviewer`.

```yaml vat-report=agent build
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 2168
data:
  agent: widget-reviewer
  target: skill
  output: /work/agents/dist/vat-bundles/skill/widget-reviewer
  files:
    - /work/agents/dist/vat-bundles/skill/widget-reviewer/SKILL.md
    - /work/agents/dist/vat-bundles/skill/widget-reviewer/agent-manifest-guide.md
```

### `agent import`

A skill imported to `agent.yaml`. Produced by `vat agent import resources/skills/SKILL.md`.

```yaml vat-report=agent import
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 9
data:
  agentPath: /work/project/resources/skills/agent.yaml
```

### `agent install`

Installed to the user scope. Produced by `vat agent install widget-reviewer`.

```yaml vat-report=agent install
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 44
data:
  agent: widget-reviewer
  installPath: ~/.claude/skills/widget-reviewer
  symlink: false
```

### `agent installed`

What is installed. Produced by `vat agent installed`.

```yaml vat-report=agent installed
status: ok
examined: 2
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 2
data:
  scanned:
    - user
    - project
  skills:
    - name: widget-reviewer
      scope: user
      type: directory
      path: ~/.claude/skills/widget-reviewer
```

### `agent uninstall`

The install removed. Produced by `vat agent uninstall widget-reviewer`.

```yaml vat-report=agent uninstall
status: ok
examined: 1
findings: []
summary:
  errors: 0
  warnings: 0
  info: 0
gate:
  strict: false
durationMs: 2
data:
  agent: widget-reviewer
  installPath: ~/.claude/skills/widget-reviewer
  wasSymlink: false
```
