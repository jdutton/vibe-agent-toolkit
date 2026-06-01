---
title: Cowork Driver Spike — Investigation Findings
date: 2026-05-27
status: closed
parent_issue: 100
parent_pr: 108
spec_ref: docs/research/2026-05-23-compat-empirical-harness-v2-design.md (§4a)
---

# Cowork Driver Spike — Investigation Findings

## Question

Can we replace the `claude-cowork` runtime's human-in-loop driver
(`driverMode: 'scripted-assisted'`) in the empirical compat harness with
something programmatic, today?

Spec: §4a of the harness v2 design doc (on PR #108's branch at
[`docs/research/2026-05-23-compat-empirical-harness-v2-design.md`](https://github.com/jdutton/vibe-agent-toolkit/pull/108)).
Time-box: ~4 hours, docs-only investigation.

## TL;DR

**For the spike's specific question — no, not feasible.** Cowork is
architecturally a Claude Desktop app product (macOS/Windows desktop
client with an embedded "cowork tab"), not an API or CLI surface. None
of the four candidate paths land us on cowork itself.

Stay on `scripted-assisted` for the `claude-cowork` driver until one of
the unblocking events in [What would change this answer](#what-would-change-this-answer)
fires.

**Adjacent finding worth recording (not a cowork driver):** Anthropic
ships a public-beta Skills API (`POST /v1/skills`, beta header
`skills-2025-10-02`, no allowlist) plus `container.skills[]` on
`/v1/messages`. That is a *fully-automatable* runtime over the API
code-execution sandbox surface — but it does not model cowork's
runtime, so it's a new runtime ("`claude-api-messages-skills`" or
similar), not a cowork driver replacement. Captured below for the
record; whether to add it to the harness is a separate decision.

## Methodology

Documentation review of:

- Anthropic API docs (`docs.claude.com`, `platform.claude.com`,
  `docs.anthropic.com`), including the beta-headers index, Files API
  reference, and Skills API reference.
- Claude Code CLI docs (`code.claude.com`), CHANGELOG, npm metadata for
  `@anthropic-ai/claude-code` (latest 2.1.150 as of May 2026).
- Cowork product pages: research-preview blog, help-center articles,
  third-party guides.
- VAT's existing wiring for the regular Anthropic API (`packages/claude-marketplace/src/org/org-api-client.ts`).

We did **not** build a working driver. The deliverable is the answer.

Sources are cited per path below.

## Findings by path

### Path 1 — Anthropic Files API as a skill bundle target

**Status: Wrong abstraction.** Not a path to cowork or to skill loading.

What's possible today: `POST /v1/files` (beta
`files-api-2025-04-14`) accepts user files (PDFs, images, documents,
code-execution inputs) for reference from later Messages calls. There
is no `purpose=skill` value or any documented mechanism by which a
Files upload becomes a discoverable skill bundle. Skills are a peer
surface, not a Files purpose.

What's blocked: Skill bundles live on a *different* endpoint —
`POST /v1/skills` (see Path 2). Files API is the wrong door.

What would unblock it: N/A — the path doesn't lead anywhere relevant.

Sources:
- [Upload File — API Reference](https://docs.anthropic.com/en/api/files-create)
- [Files API guide](https://platform.claude.com/docs/en/build-with-claude/files)

### Path 2 — Messages API beta with the `skills` feature flag

**Status: Feasible today as an API runtime — but it is not cowork.**

What's possible today: `anthropic-beta: skills-2025-10-02` is a public
beta (no allowlist as of May 2026, per multiple independent sources).
Two-step flow:

```bash
# 1. Upload bundle
POST /v1/skills
Headers: x-api-key, anthropic-version: 2023-06-01,
         anthropic-beta: skills-2025-10-02
Body: multipart/form-data with files[]=@bundle/...
→ { "id": "skill_01...", "latest_version": "..." }

# 2. Invoke via Messages API
POST /v1/messages
Headers: ..., anthropic-beta: skills-2025-10-02,code-execution-2025-08-25
Body: {
  "model": "...",
  "container": { "skills": [
    { "type": "custom", "skill_id": "skill_01...", "version": "latest" }
  ]},
  "tools": [{ "type": "code_execution_20250825", "name": "code_execution" }],
  "messages": [{ "role": "user", "content": "..." }]
}
```

Limits: 30 MB bundle, ≤8 skills per request, workspace-scoped, unique
`display_title` per workspace.

What's blocked / caveat (the load-bearing one): **Skills always
execute inside the code-execution sandbox.** That sandbox does not
expose Claude Code's broader surface — no bash outside the container,
no MCP, no hooks, no filesystem beyond the sandbox root. A skill that
depends on any of those gets a false-negative here even when the
bundle itself is fine. This makes the API path a *different* runtime
from `claude-code` with a narrower capability surface — adding it to
`RUNTIME_PROFILES` would need its own profile, not an alias.

What's blocked for cowork specifically: Skills uploaded via
`/v1/skills` are scoped to API consumers and "do not surface in the
Claude UI for end users" — they are not visible to cowork. There is
no programmatic bridge from a `skill_id` to a cowork session.

What would unblock cowork via this path: a `container.runtime: "cowork"`
parameter (or equivalent) that runs the same uploaded skill under
cowork's orchestration layer. Not announced.

Sources:
- [Using Skills with the API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)
- [Skills API reference (beta)](https://platform.claude.com/docs/en/api/beta/skills)
- [Skill versions endpoint](https://platform.claude.com/docs/en/api/beta/skills/versions)
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Beta headers index](https://docs.anthropic.com/en/api/beta-headers)
- [`anthropics/skills` GitHub](https://github.com/anthropics/skills)

### Path 3 — `claude` CLI cowork mode in the 2.1.x line

**Status: Not feasible. No such mode exists.**

What's possible today: nothing. The Claude Code CLI
(`@anthropic-ai/claude-code`, latest 2.1.150 as of May 2026) does not
expose any subcommand, flag, or `--target cowork` value that drives
the Cowork product. Cowork is a Claude Desktop product — desktop app
(macOS/Windows) with an embedded "cowork tab" — not a CLI surface.

What's blocked:

- **Surface mismatch.** Cowork is desktop-app-only. The CLI's command
  set is well-documented; there is no hidden or undocumented cowork
  subcommand to discover.
- **Remote Control is the wrong direction.** The closest-looking CLI
  feature, `claude remote-control` / `--rc`, lets `claude.ai` or the
  mobile app drive a local CLI session — not the reverse. The cowork
  tab is not a Remote Control client.
- **Auth gap even if it shipped.** Remote Control requires a `claude.ai`
  subscription and OAuth tokens from `claude auth login` — it
  explicitly rejects API keys. Our CI environment uses API keys; a
  hypothetical cowork CLI mode with similar auth requirements would
  still be unscriptable in CI without an OAuth provisioning story we
  don't have.

What would unblock it:

1. Anthropic ships `claude cowork -p "<prompt>"` (or `--target cowork`
   on `claude -p`) emitting stream-json. The existing `claude-code`
   driver could be forked in ~20 lines. No public roadmap signal.
2. Cowork exposes an API surface (overlaps with Path 4's outcome).

Sources:
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Cowork research preview](https://claude.com/blog/cowork-research-preview)
- [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [`@anthropic-ai/claude-code` on npm](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- [Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)

### Path 4 — `console.anthropic.com` admin / workspace surface

**Status: Admin API has no skills surface; the regular API does (= Path 2).**

What's possible today: The Admin API (`/v1/organizations/...`) covers
users, workspaces, API keys, and usage/cost reports — it does not
touch skills. Skills are workspace-scoped on the regular Anthropic
API and managed by the workspace's API key, not by the Admin key.

VAT already has the upload half wired up:

- `packages/claude-marketplace/src/org/org-api-client.ts` —
  `uploadSkill`, `deleteSkill`, `getSkills`, version management.
- `packages/cli/src/commands/claude/org/` — CLI commands exercising
  that client.
- `packages/vat-development-agents/resources/skills/vat-enterprise-org.md`
  — the skill that documents this surface.

What's missing for an API runtime: a `messages.create` wrapper to
drive the invoke side. Trivial to add once we decide whether to.

What's blocked for cowork specifically: Console has no cowork-adjacent
surface. The Admin API does not model cowork's orchestration layer
(action streams, interventions, multi-turn coordination); skills under
the regular API run in the code-execution sandbox, not under cowork.
For *skill-compat probing* this is sufficient; for testing
cowork-specific runtime semantics it is not.

What would unblock cowork-specific testing: a "Cowork Sessions API"
exposing the cowork orchestration layer under the same `skill_id`
upload. Not announced.

Sources:
- [Admin API overview](https://docs.anthropic.com/en/api/administration-api)
- [Skills API reference (beta)](https://platform.claude.com/docs/en/api/beta/skills)
- VAT wiring (this repo): `packages/claude-marketplace/src/org/org-api-client.ts`

## Verdict

**For driving `claude-cowork` programmatically: not feasible today.**

Cowork has no public API/CLI/scriptable surface. The
`scripted-assisted` driver in
`packages/dev-tools/src/compat-empirical/runtimes/claude-cowork.ts`
remains the only honest option. Do not re-litigate this question
quarterly absent one of the events listed below — the answer is
"still no" until the surface ships.

**Separately, an API runtime is feasible and trivial to wire.** Whether
to add a `claude-api-messages-skills` runtime to the harness (as a
*new* fourth target, not a cowork replacement) is a downstream
decision. The mechanics are documented above; VAT already owns the
upload client. The reason this is not auto-actioned by this spike:

- The new runtime would test skill behavior under the API
  code-execution sandbox, which is narrower than either `claude-code`
  or `claude-cowork`. False-negatives are likely for skills that need
  bash/MCP/hooks.
- Adding it requires a new `RUNTIME_PROFILES` entry, judge-prompt
  awareness, and corpus annotations — non-trivial scope that should
  be its own design discussion, not bolted into a "cowork driver"
  follow-up.

If/when the team wants that runtime, open a new issue referencing this
doc; the API-shape sections of Paths 2 and 4 are the spec.

## What would change this answer

Re-investigate when any of the following ships or is publicly
announced (with citation, not vibes):

1. A **`claude cowork -p` CLI subcommand** (or equivalent on the
   existing `claude` binary) producing stream-json. Forks the
   existing `claude-code` driver in ~20 lines.
2. A **Cowork Sessions API** — a programmatic upload + invoke surface
   that exercises cowork's actual orchestration layer (action streams,
   interventions), not just skill execution.
3. **Cowork importing skills from a documented filesystem location**
   (e.g., `~/.claude/skills/`). If true, a "drop bundle in path, start
   cowork, capture output" driver is feasible without an API. Worth
   empirical confirmation via `lsof`/strace on cowork's plugin-import
   flow before committing.
4. **Remote Control gains a programmatic client surface AND a cowork
   client.** Both pieces needed; either alone insufficient.

Default cadence: do not re-open this question on a calendar. Re-open
when (and only when) one of the above appears in Anthropic's release
notes, the cowork product page, the Claude Code CLI changelog, or a
public roadmap entry.

## References

- v2 design doc, §4a (the spec for this spike): on PR #108's branch at
  [`docs/research/2026-05-23-compat-empirical-harness-v2-design.md`](https://github.com/jdutton/vibe-agent-toolkit/pull/108).
  Will be at `docs/research/2026-05-23-compat-empirical-harness-v2-design.md`
  once PR #108 merges.
- Parent issue: [#100 — Empirical Chat | Cowork | Code compat research](https://github.com/jdutton/vibe-agent-toolkit/issues/100)
- v1 scaffold PR: [#108](https://github.com/jdutton/vibe-agent-toolkit/pull/108)
- Existing scripted-assisted driver (lands with PR #108):
  `packages/dev-tools/src/compat-empirical/runtimes/claude-cowork.ts`
- Existing Skills API upload wiring:
  `packages/claude-marketplace/src/org/org-api-client.ts`
- VAT's enterprise/admin documentation:
  `packages/vat-development-agents/resources/skills/vat-enterprise-org.md`
- Cached Anthropic skill-authoring best-practices:
  [`docs/external/anthropic-skill-authoring-best-practices.md`](../external/anthropic-skill-authoring-best-practices.md)
