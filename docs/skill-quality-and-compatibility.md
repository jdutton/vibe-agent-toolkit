# Skill Quality and Compatibility — VAT's Stance

This document names the stance the vibe-agent-toolkit project takes on what makes Claude skills good, what makes them compatible with the various Claude runtimes, and what counts as enough of a concern to warrant a validation warning. It is the bridge between what VAT *believes* and what VAT *does* — every `defaultSeverity` in [`docs/validation-codes.md`](./validation-codes.md), every pattern a detector looks for, every default excluded from `vat audit` comes from an opinion expressed (or implied) here.

## Posture

VAT is opinionated about what makes skills good. This document names those opinions explicitly, because we'd rather be clear about our stance than pretend neutrality. Our opinions come from experience, adopter feedback, and pattern observation — they are not objective truths. We will be wrong sometimes, and where we used to be right, circumstances will change. This document evolves alongside the project. Every opinion here can be overridden by adopters via `validation.severity` and `validation.allow` with a reason; those overrides are part of the conversation, not failures of conformance.

## How This Doc Works

Each section below names one category of skill property VAT forms opinions about. For each opinion, we try to state:

- **What we currently believe.** The position itself.
- **Why we believe it.** The reasoning or adopter experience behind it.
- **How confident we are.** `high` for well-tested stances; `medium` for plausible but under-calibrated; `exploring` for tentative positions we expect to revise.
- **What might change it.** Signals that would cause us to update the stance.
- **Which codes enforce it.** Cross-reference into [`docs/validation-codes.md`](./validation-codes.md).

Stubs below (Structure, Packaging, Length and Shape, Authoring, Configuration Meta) contain one-paragraph summaries and links into the code reference. They expand over time as adopters surface gaps and we invest in articulating our reasoning.

## Compatibility

### The evidence substrate

VAT's compat reasoning is layered. Parsers produce neutral **evidence records** (pattern matches with file + line + confidence); a derivation step rolls evidence into **observations** (capability claims like "this skill requires local shell"); a verdict engine compares observations against the plugin's declared targets and their runtime profiles to produce **verdicts** (`COMPAT_TARGET_INCOMPATIBLE`, `_NEEDS_REVIEW`, `_UNDECLARED`).

This separation is load-bearing. Evidence is low-confidence by nature — regex can match things it shouldn't — and keeping evidence separate from judgment lets us refine patterns without changing the observation contract. When an adopter reports a false positive, `vat audit --verbose` surfaces the exact pattern that fired; we add the skill content to a regression corpus, refine the pattern, and keep the observation shape stable.

The code-level semantics live in [`docs/validation-codes.md`](./validation-codes.md) — this doc names *why* the split exists; that doc is the reference for what each code does.

### The three Claude runtimes

VAT models compatibility against three runtimes that differ in what a skill can physically do:

| Runtime | Description | Shell | Browser | Network | Custom scripts |
|---|---|---|---|---|---|
| `claude-chat` | Cloud-based chat UI; tool use is MCP-only. | No | Yes | Full | No |
| `claude-cowork` | Managed VM with Python 3.10 + Node 22 pre-installed; restricted network. | Yes | No | Restricted | Yes (within VM) |
| `claude-code` | Local runtime with full environment. | Yes | Yes | Full | Yes |

"Claude Desktop" is an *application* that can host any of the three, not itself a runtime — do not confuse them. The earlier `claude-desktop` target name in VAT was architecturally wrong and was retired in 0.1.32 (renamed to `claude-chat`). `cowork` was likewise renamed to `claude-cowork` for namespace consistency.

### Capability axes (what VAT currently reasons about)

| Axis | Values | What it captures |
|---|---|---|
| `localShell` | `yes` / `no` | Can the runtime execute local shell commands and mutate the local filesystem? |
| `browser` | `yes` / `no` | Does the runtime have a browser available for interactive auth or external links? |
| `network` | `full` / `restricted` / `none` | Can the runtime reach arbitrary internet endpoints? |
| `customScripts` | `yes` / `no` | Can the runtime execute scripts packaged with a plugin (Python, Node, shell)? |
| `preinstalledBinaries` | `Set<string>` | Which external CLIs does the runtime guarantee on PATH? |

### Declaration

A plugin declares its intended runtimes in `plugin.json`:

```json
{ "name": "my-plugin", "targets": ["claude-code"] }
```

A marketplace may declare a default for all plugins it owns:

```json
{ "name": "my-marketplace", "defaults": { "targets": ["claude-code"] } }
```

Plugin-level declaration overrides marketplace default. `vibe-agent-toolkit.config.yaml` (`skills.defaults.targets` / `skills.config.<name>.targets`) supplies a per-skill declaration when neither plugin nor marketplace covers it. All three absent means *no declaration* — not "assumed compatible with all runtimes." A skill's `CAPABILITY_*` observations are informational regardless of declaration state; the verdict engine only produces a `COMPAT_TARGET_INCOMPATIBLE` or `COMPAT_TARGET_NEEDS_REVIEW` warning when a declared target lacks the capability. Without any declaration, the missing declaration itself surfaces as `COMPAT_TARGET_UNDECLARED` at `info`.

### What we currently detect

VAT's parsers look for patterns in a skill's markdown (SKILL.md and transitively linked files) that correlate with runtime capability requirements:

- Fenced `bash` / `sh` / `zsh` code blocks → `CAPABILITY_LOCAL_SHELL` (confidence: high — the pattern is explicit).
- `allowed-tools: [Bash, Edit, Write, NotebookEdit]` frontmatter → `CAPABILITY_LOCAL_SHELL` (confidence: high).
- External CLI names (`az`, `aws`, `gcloud`, `kubectl`, `docker`, `terraform`, `gh`, `op`) at start of a line inside a shell block → `CAPABILITY_EXTERNAL_CLI:<binary>` (confidence: high for presence, medium for severity — a doc-only shell block and an agent-instruction shell block look identical).
- Interactive auth flows (`az login`, `gcloud auth login`, `aws sso login`, `from msal`, `@azure/msal-*`, `webbrowser.open(...)`) → `CAPABILITY_BROWSER_AUTH` (confidence: high for explicit auth commands, medium for library imports — an MSAL import could be in a library consumed via a service principal, not an interactive flow).

Confidence is shown in `vat audit --verbose`. Observations with lower confidence should be read with more skepticism; corroboration across multiple patterns increases signal.

### What we know we can't yet detect

The parser is a regex-based heuristic; it will be wrong. Known gaps:

- **Prose intent.** Whether a fenced shell block is documentation (shown for reference, not meant to be run) vs. agent instruction (the agent is expected to execute it) is a semantic distinction that regex cannot make. We currently treat both the same.
- **Parameterized binary availability.** VAT detects that a skill uses `az` but cannot know whether a specific runtime instance has `az` installed — that's environmental. `CAPABILITY_EXTERNAL_CLI` observations produce `needs-review` verdicts for any runtime that doesn't explicitly guarantee the binary in its profile.
- **Skill workflow as written.** "Does this skill's description actually trigger well?" requires semantic understanding of the description and the tasks it targets. Future AI-based observers (the forthcoming skill-reviewer skill) will cover these.
- **Plugin hooks and MCP server requirements.** Plugin-level compat (hooks.json, .mcp.json) is covered by the legacy `vat audit --compat` analyzer; skill-level and plugin-level compat are being unified in the 0.1.32 refactor.

### What might change our compatibility stance

- A new Claude runtime entering the ecosystem adds a column to the profile table and may introduce new capability axes.
- Adopter bug reports of false-positive observations get added to a regression corpus; we tighten or replace patterns and re-verify.
- Calibration data from community-wide plugin scanning (workstream B, deferred) will likely surface patterns we don't yet detect and patterns we detect but shouldn't.
- Severity defaults may shift as we learn which observations correlate with real incompatibility vs. which are near-cosmetic.

## Structure

See [Skill Packaging Shapes](./architecture/skill-packaging.md) for the terminology reference — the four recognized artifact shapes (standalone skill, skill-claude-plugin, claude-plugin, claude-marketplace) and how their validation applies.

VAT believes skills should be **self-contained** and **progressively disclosed**: all linked resources live inside the skill directory, and long content is split into linked resources rather than loaded into a monolithic SKILL.md. Skills that reach outside their directory couple silently to project layout; skills that bundle everything into SKILL.md crowd the agent's context. See `LINK_OUTSIDE_PROJECT`, `LINK_TARGETS_DIRECTORY`, `LINK_TO_NAVIGATION_FILE`, `LINK_TO_GITIGNORED_FILE`, `LINK_TO_SKILL_DEFINITION`, `NO_PROGRESSIVE_DISCLOSURE`, and `REFERENCE_TOO_DEEP` in [`docs/validation-codes.md`](./validation-codes.md) for the code-level enforcement.

## Packaging

VAT believes **every packaged file should be reachable by a link from SKILL.md or another packaged file**, and that the link rewriter's output should match the source author's intent. Unreferenced packaged files signal dead weight; broken packaged links after rewrite signal a VAT bug. See `PACKAGED_UNREFERENCED_FILE`, `PACKAGED_BROKEN_LINK`, and `LINK_DROPPED_BY_DEPTH` in [`docs/validation-codes.md`](./validation-codes.md).

## Length and Shape

VAT believes **skills should fit comfortably inside an agent's context budget**, because triggering relies on the description and initial content and because large skills crowd out sibling skills. Length and size limits are advisory defaults that legitimate skills may exceed with a documented reason. See `SKILL_LENGTH_EXCEEDS_RECOMMENDED`, `SKILL_TOTAL_SIZE_LARGE`, and `SKILL_TOO_MANY_FILES` in [`docs/validation-codes.md`](./validation-codes.md).

## Authoring

VAT believes **skill descriptions are the primary trigger signal** — agents read them to decide whether to invoke the skill, so vague descriptions cost accuracy in both directions (missed triggers and spurious invocations). See `DESCRIPTION_TOO_VAGUE` and the frontmatter validation rules in [`docs/validation-codes.md`](./validation-codes.md).

## Configuration Meta

VAT believes **overrides should have half-lives**, because an allow entry that silences a check forever is a way to forget. `ALLOW_EXPIRED` gives time-boxed overrides a visible re-review prompt; `ALLOW_UNUSED` catches dead entries that no longer match anything. Both default to `warning` so adopters are nudged but not blocked. See [`docs/validation-codes.md`](./validation-codes.md) for code details.

---

## Changelog of stance changes

(Maintained going forward so adopters can see when and why our stance shifted. Initial entry: doc created in 0.1.31 stable.)

- **2026-04-18 (0.1.32)** — Companion stance doc [`docs/validation-rule-design.md`](./validation-rule-design.md) (originally named `skill-smell-philosophy.md`) added, articulating the rule-addition bar, default-severity posture, graduation path, and data-driven evolution that govern every code in [`docs/validation-codes.md`](./validation-codes.md).
- **2026-04-18 (0.1.32)** — Compat model refactored. v1 `COMPAT_REQUIRES_*` codes renamed to `CAPABILITY_*` (informational observations); new `COMPAT_TARGET_*` verdict codes fire only on declared-target mismatch. Runtime `claude-desktop` renamed to `claude-chat`. Evidence substrate added with `--verbose` output surface. Config-level `targets` declaration supported. Post-build validation runs full suite on built output.
- **2026-04-17 (0.1.31 stable)** — doc created. Compatibility section reflects the v1 detectors shipped in 0.1.31-rc.1, with pending changes named explicitly (runtime rename, evidence/observation split) shipping in 0.1.32.
