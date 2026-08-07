# Plugin Distribution: Findings and Open Questions

**What this is:** a running evidence log behind VAT's plugin-shape rules, plus the
design questions those rules keep running into.

**Why it exists:** VAT's rule-addition discipline ([validation-rule-design.md](../validation-rule-design.md))
says severity must be justified by evidence. That only works if the evidence is
written down somewhere durable. Without this file, a rule shipped at `warning`
because we had exactly one observation is indistinguishable — six months later —
from a rule shipped at `warning` because we were being polite. The first should be
promoted when more evidence arrives; the second should not.

**How to extend it:** append to the Evidence Log with a date and a confidence
label. When new evidence changes a rule's severity, record the change under
Decisions with a pointer to the entry that justified it.

Confidence labels used throughout:

| Label | Meaning |
|---|---|
| **DOCUMENTED** | Stated in Anthropic's published docs. Quote it and link it. |
| **OBSERVED (n=N)** | Seen in the wild N times. Not documented. Note the surface it was seen on. |
| **INFERRED** | Reasoned from adjacent facts. Never sufficient on its own for an `error`. |

> **Adopter privacy.** Findings that originate from a private adopter repo are
> recorded here as *shapes*, never identities — no repo, plugin, skill, or file
> names from proprietary projects. A shape ("two skills in one plugin sharing a
> 34 MB binary") is what makes a rule; the name adds nothing and does not belong
> in a public repo.

---

## The failure class: silent hosted-sync divergence

The unifying theme behind most findings here. A plugin works on the Claude Code
CLI, publishes cleanly, and is then **silently absent** after syncing to a
claude.ai marketplace. There is no failing build, no error in the publishing
repo, and often no signal at all until someone notices the plugin missing from an
admin console.

This is the failure mode VAT is uniquely placed to catch, because VAT is the only
tool standing between the source repo and the marketplace.

Known members:

| Divergence | Confidence | Source |
|---|---|---|
| Non-kebab-case plugin names rejected by sync | **DOCUMENTED** | *"Claude Code accepts other forms, but the claude.ai marketplace sync rejects them"* — [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) |
| `npm` / `pip` marketplace source types unsupported | **DOCUMENTED** | *"The `npm` and `pip` source types are not supported."* — [Manage plugins for your organization](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization) |
| `github` / `url` / `git-subdir` sources require **public** repos | **DOCUMENTED** | same article |
| 50 MB plugin ZIP upload limit | **DOCUMENTED** | same article (also: 100 plugins/marketplace manual, 500 via GitHub sync, 64-char name limit, 30-min sync timeout) |
| Symlinks resolving outside the plugin are skipped | **DOCUMENTED** | [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — *"the symlink is skipped for security"* |
| Top-level `bin/` causes the plugin to be skipped | **OBSERVED (n=1)** | See Evidence Log entry below |

Only the last of these is currently implemented as a VAT rule. The documented
ones are stronger candidates precisely *because* they need no inference — see
Open Questions.

---

## Evidence log

### 2026-07-20 — `bin/` and hosted sync

**OBSERVED (n=1).** An org admin console reported *"Some plugins couldn't sync"*
— the marketplace synced, one plugin was silently skipped. Verbatim, with the
adopter's filename generalized:

> Plugin contains a top-level `bin/` directory (`bin/<tool>.mjs`). claude.ai-hosted
> plugins may not ship `bin/` executables because they are added to PATH on the CLI
> but are not shown on the admin approval surface. Declare executable entry points
> via hooks, commands, or mcpServers instead.

The sync itself reported success; the plugin simply never appeared, and the
absence went unnoticed for a day. Note that the error's own suggested remedy is
*hooks / commands / mcpServers* — i.e. declared entry points that the approval
surface renders. VAT's rule instead recommends `scripts/`, which is the right
advice for a **helper script invoked by path** (not an entry point at all) and is
what the plugin-dev skill documents. Both remedies are consistent with the stated
mechanism: neither puts an un-reviewed executable on PATH.

**DOCUMENTED, and it points the other way.** `bin/` is a supported Claude Code
plugin component, shipped in v2.1.91:

> **Executables** | `bin/` | Executables added to the Bash tool's `PATH`. Files
> here are invokable as bare commands in any Bash tool call while the plugin is
> enabled — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)

A search of Anthropic's docs, help center, and the `anthropics/claude-code` issue
tracker found **no** published restriction on `bin/` for hosted installs, and no
occurrence of the observed error strings.

**DOCUMENTED.** `scripts/` is the conventional home for helper scripts. The
plugin-dev skill's recognized-directory list names `scripts/` and never mentions
`bin/`. Helper scripts there are invoked by path, not as bare commands.

**INFERRED (and load-bearing for the rule's framing).** The CLI installer's
"Will install" panel enumerates commands, agents, skills, hooks, MCP and LSP
servers — `bin/` appears in neither that list nor the installed-plugin detail
view. An executable that silently joins PATH with no review surface is a coherent
thing for a hosted, admin-approved context to refuse. This is a plausible
*mechanism* for the observation, not a substitute for it.

**Resolution.** `PLUGIN_TOPLEVEL_BIN_DIR` at `warning`, never escalated by strict
validation. The rule's durable justification is the documented `bin/` vs
`scripts/` distinction — a plugin invoking its executables by explicit path is
paying `bin/`'s cost without using PATH exposure — which holds regardless of
whether the hosted restriction is ever documented. The observation is reported as
an observation.

**What would change this:** Anthropic documenting the restriction, or further
independent observations, would justify promotion. A statement that `bin/` is
fine on hosted would justify dropping the hosted framing while keeping the
`bin/`-vs-`scripts/` advice.

### 2026-07-20 — cross-skill asset duplication is correct, not a defect

**OBSERVED.** A corpus scan of installed plugins found byte-identical (SHA-256
matched) large binaries duplicated across sibling skills within single plugins —
in the worst case a 34 MB binary in two skills and a 13 MB bundle in the same
two, with a separate plugin carrying four copies of one ~2 MB CLI bundle. Tens of
megabytes of redundancy per plugin.

**This was initially proposed as a lint rule ("duplicate identical blobs in one
plugin") and the proposal was wrong.** Deduplicating requires a single
plugin-level copy, which requires skill bodies to reference it via
`${CLAUDE_PLUGIN_ROOT}` — exactly what `NON_PORTABLE_ASSET_REFERENCE` correctly
forbids, because that anchor does not exist under a standalone skill mount. **The
duplication is the price of skill portability.** A rule telling adopters to
dedupe would be telling them to break the property that makes a skill a skill.

**Do not add this rule.** What survives is a different check with a documented
basis: total packaged size against the 50 MB hosted limit. (For calibration: the
99 MB-on-disk plugin above compressed to 21 MB, so on-disk size is a poor proxy —
measure the archive.)

**Guidance shipped instead:** `vat-skill-authoring` gained a section on the
per-skill vs. plugin-level `files:` fork, naming the deciding question — *does
this skill ever need to run outside its plugin?* — and the scoped
`validation.allow`-with-a-reason pattern for skills that legitimately don't.

**Discoverability is the real gap here (2026-07-20).** An adopter filed
plugin-level `files:` as their single highest-priority feature request, having
concluded from a source read that "there is no supported way to express one
asset shared by several skills" — and shipping four copies of a 2.43 MB bundle
(~7.3 MB waste per publish, compounding, since bundles are not byte-reproducible
across builds). **The feature already exists** and was verified end-to-end
against this branch. They looked in `@vibe-agent-toolkit/claude-marketplace`;
the schema lives in `resources` (`ClaudeMarketplacePluginEntrySchema.files`) and
the applier in `cli` (`plugin-files.ts`).

A capability nobody can find is worth approximately zero. The gap to close is
documentation and error-message signposting, not implementation — specifically,
the skill-level `dest` containment error (`joinUnderRoot: result … escapes root`)
is thrown at exactly the moment an author is reaching for this feature, and says
nothing about it existing.

### 2026-07-20 — detection was not the gap; gating was

**OBSERVED.** The plugin whose sync failed was *already* being flagged by VAT.
A single one of its skills produced **10** `NON_PORTABLE_ASSET_REFERENCE`
warnings, every one pointing at the exact executable that broke the sync. The
warnings fired and the plugin shipped anyway.

**Implication.** Adding an eleventh warning to a pile of ten that were ignored is
not a fix. Findings that are *fatal to distribution* need to fail at the publish
gate, while style and portability advice stays advisory in audit. Those two
categories currently share a severity space, which is how ten accurate findings
became background noise.

This is the strongest argument in this document for the preflight described
below, and against continuing to add one-off codes.

---

## Decisions taken

| Decision | Rationale |
|---|---|
| `PLUGIN_TOPLEVEL_BIN_DIR` ships at `warning`, never escalated by `strict` | One undocumented observation against a documented, supported feature. Pinned by a test in `plugin-validator.test.ts` so it cannot be promoted silently. |
| The rule recommends `scripts/`, not a novel directory | `scripts/` is the documented convention. An invented name would be VAT inventing ecosystem policy. |
| No "duplicate blobs" rule | Would contradict `NON_PORTABLE_ASSET_REFERENCE`. See Evidence Log. |
| Adopter-sourced findings recorded as shapes, never identities | See privacy note above. |

---

## Open design questions

### 1. `targets`-conditional suppression

**Two independent rules now point at this**, which is the main reason it is
written down rather than left as a hallway remark:

- `PLUGIN_TOPLEVEL_BIN_DIR` only matters if you sync to claude.ai. A CLI-only
  plugin using `bin/` for PATH exposure is using it exactly as designed.
- `NON_PORTABLE_ASSET_REFERENCE` only matters if the skill is ever mounted
  standalone. A skill that only ever ships inside its plugin has no such concern.

In both cases the finding is **conditional on where the artifact is meant to
run** — which is precisely what VAT's existing `targets` model
(`claude-code` / `claude-chat` / `claude-cowork`) expresses, and what the verdict
engine already uses to suppress compat codes on declared targets.

Today neither rule consults `targets`. `PLUGIN_TOPLEVEL_BIN_DIR` was implemented
with an ad-hoc `strict` flag (since removed), and `NON_PORTABLE_ASSET_REFERENCE`
requires a hand-written `validation.allow` entry. Both are workarounds for the
same missing wire.

Note the blocker: the verdict engine consumes *skill-document* observations,
while `PLUGIN_TOPLEVEL_BIN_DIR` is a *plugin directory-shape* observation. Making
plugin-shape findings target-aware means extending the observation model, not
just adding a lookup. That is the actual work, and it is why this is an open
question rather than a task.

### 2. A hosted-sync preflight, instead of more one-off codes

Every documented divergence in the table above shares a shape: publish succeeds,
plugin silently absent. A single preflight on `vat claude marketplace publish`
answering *"will this actually appear after I push?"* would cover them as a
group, seeded with the documented facts (archive size, `npm`/`pip` sources,
private-repo sources, reserved marketplace names, kebab-case) that need no
inference and are hard failures.

The Evidence Log entry on gating is the argument for putting these at the publish
gate as errors rather than adding them to audit as warnings.

### 3. `NON_PORTABLE_ASSET_REFERENCE` conflates two unlike variables

Raised by an adopter, and correct. The rule fires identically on
`CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR`, but they denote different kinds
of thing:

- **`CLAUDE_PLUGIN_ROOT`** → where the plugin's *own bundled assets* live. A
  skill-relative alternative usually exists, so the advice "use a path relative
  to the skill directory" is actionable.
- **`CLAUDE_PROJECT_DIR`** → *the user's repository*, the thing the skill
  operates **on**. This is not an asset reference at all, and **no skill-relative
  path can express it.** The emitted fix is therefore not merely unhelpful:
  following it is impossible, and the adopter reports that the pattern VAT flags
  (`--project-dir` → `$CLAUDE_PROJECT_DIR` → `cwd`) was itself the *fix* for a
  real bug where user artifacts were anchored on the plugin install directory.
  VAT currently advises reverting a correct fix.

Both variants also fire on **prose and shell comments**, not just executable
references — three of four hits in one skill were a fenced-code comment or an
inline-backtick mention. That penalizes documenting what a skill does with these
variables, which is backwards.

And the matcher over-captures inside nested parameter expansion:
`PROJECT_DIR="${VAR:-$CLAUDE_PROJECT_DIR}"` is reported as
`` "$CLAUDE_PROJECT_DIR}" `` — the trailing brace belongs to the *enclosing*
expansion. Independently reproduced. It reads like the typo `$FOO}` and costs
review time.

Splitting the variants (or dropping `CLAUDE_PROJECT_DIR` to its own code with
target-oriented advice) is the fix. Note this interacts with Open Question 1: the
`CLAUDE_PLUGIN_ROOT` half is exactly the conditional-on-targets case.

### 4. Should validation config reach the plugin validator family?

`detectMissingRecommendedFields`, `detectHostedIncompatibleShape`, and the
`PLUGIN_MISSING_VERSION` check all emit at hardcoded severities.
`vat claude marketplace validate` loads no validation config, so
`validation.severity` and `validation.allow` do not reach any of them — the
opt-out documented for `PLUGIN_TOPLEVEL_BIN_DIR` works in `vat audit` but not on
the marketplace path. This is a pre-existing inconsistency the `bin/` work
surfaced rather than introduced, and it constrains how strict any future
plugin-level rule can safely be.

---

## Rules NOT to add

Recorded so they are not re-proposed:

| Proposed rule | Why not |
|---|---|
| Duplicate identical blobs within a plugin | Contradicts skill portability — see Evidence Log |
| Unknown/undocumented top-level plugin directory | A corpus scan found 11 undocumented directory names, overwhelmingly referenced correctly via `${CLAUDE_PLUGIN_ROOT}`. Pure noise. |
| Shebang/exec-bit on files outside `hooks/` and `commands/` | Normal and documented for `skills/*/scripts/`. Also prone to false positives from `#!` inside fenced code blocks in markdown. |
| Absolute paths in `plugin.json` / `hooks.json` / `.mcp.json` | Documented as prohibited, but a corpus scan found **zero** violations. Regression insurance at best; not worth a rule until something regresses. |
