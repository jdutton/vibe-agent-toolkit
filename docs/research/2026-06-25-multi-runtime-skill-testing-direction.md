---
title: Multi-Runtime Skill Testing — Direction
date: 2026-06-25
status: proposed
related_issues: [100]
related_prs: [108, 132, 135]
related_docs:
  - docs/research/2026-05-23-compat-empirical-harness-v2-design.md
  - docs/architecture/compatibility.md
  - docs/skill-quality-and-compatibility.md
  - docs/validation-rule-design.md
---

# Multi-Runtime Skill Testing — Direction

> **What this doc is.** A committed, forward-looking direction note for where VAT's
> skill-*testing* capability is heading: from "test a skill in Claude Code" to "test a
> skill against every runtime it claims to support." It is a *direction*, not an
> implementation spec — it names the thesis, the target architecture, and the build
> sequence so the load-bearing decisions are discoverable by contributors and don't get
> silently violated. Concrete per-phase specs/plans branch off from here.
>
> **Reviewed 2026-06-25** by an adversarial panel (architecture / runtime-landscape /
> test-methodology / forward-compat). The corrections below are folded in; the biggest were:
> OpenAI *does* have a native SKILL.md runtime (Codex CLI) so "Microsoft is the singular
> second runtime" was wrong; the shared layer is the **driver + transcript**, *not* the
> judge; **repeat-N** (non-determinism) is a first-class axis the chassis was missing; and
> the generic matrix-engine was both over-built and the wrong primitive, so it is **no longer
> mandated** (pre-1.0 break-freely makes the later reshape cheap).

## 1. Thesis

VAT already does two of the three things a mature toolchain does about runtime
compatibility:

1. **Declare** intended compatibility — the `compatibility` frontmatter target(s) a skill
   claims (see `docs/architecture/compatibility.md`, `docs/skill-quality-and-compatibility.md`).
2. **Assert statically** — analysis that flags when a skill *violates* what it claims (the
   "linter" layer; `docs/validation-rule-design.md`).

The missing third capability is **compatibility _testing_**: confirm empirically by
*executing* the skill in each runtime and observing whether it works. This is the
integration/e2e layer of the same shift-left ladder VAT climbs everywhere else — declared
targets are the "types," static analysis is the "lint," and compat testing is "run it on
the real thing and watch."

It catches the bug class static analysis structurally cannot: a skill green in one runtime
but broken in another's **environment** (an isolated-network sandbox, a missing interpreter,
a tool-approval prompt) — "wrong-but-green" behavior that only surfaces on execution.

**Corollary — the matrix is informed by, but not strictly derived from, `compatibility`.**
Test what you claim, *and* test what you're *considering* claiming. A skill's declared
targets seed the gating set (and a lint warns if you gate on a runtime you don't declare, or
declare one you never test), but you can run an **undeclared** runtime as a non-gating
**canary** whose result *informs* the declaration. (Deriving the matrix *strictly* from
`compatibility` would make the "should I declare this runtime?" workflow impossible — see §6.)

## 2. Two harnesses today — and the narrow layer they should share

VAT has **two** skill-execution harnesses, for different audiences. They are **separate code
today** (no shared runtime layer), and an adopter only ever touches the second:

| Harness | Audience | Published? | Purpose | Runtime support today |
|---|---|---|---|---|
| **`compat-empirical`** (`packages/dev-tools/src/compat-empirical/`, issue #100 / PR #108) | VAT-internal | **No** (`@vibe-agent-toolkit/dev-tools`, `private: true`) | Calibrate VAT's static compat *detectors* against reality — run a corpus across runtimes, judge transcripts, render a reality-vs-prediction matrix | Multi-runtime via `runtimes/driver.ts`: `claude-code` (scripted), `claude-cowork`/`claude-chat` (manual). Spawns via its **own** `runClaude`/`runClaudeSubscription` |
| **`vat skill test`** (adopter-facing CLI; PR #132 v1, PR #135 v2 eval runner) | Adopters | **Yes** (`@vibe-agent-toolkit/cli` + `agent-skills`) | Test *their own* skill against its `evals.json` | Claude Code only — `spawnHeadlessClaude` (published `@vibe-agent-toolkit/utils`); v1/v2 fuse executor + grader in one session |

The two **independently implement the same kernel** — "drive a Claude runtime against a
staged skill + prompt, get output back" — on two different entrypoints (`runClaude*` vs.
`spawnHeadlessClaude`). That's a parallel implementation that can silently drift (jscpd
doesn't flag it; the code differs enough).

**The dogfooding move (not a merge).** Extract *only* that kernel — the **RunnerAdapter +
normalized transcript** — into a **published** layer, and have **both** harnesses consume it.
Then VAT's own calibration harness exercises the exact runner abstraction adopters get, so
multi-runtime adapter bugs surface in **VAT's own CI**, not in an adopter's lap. Each new
adapter (Agent SDK, MS-AF) is then a new calibration column *and* a new adopter-testable
runtime, written once.

What is **not** shared:

- **The judge is per-harness, not shared.** The two grade different things: compat-empirical
  emits a *trigger/compat* verdict (`completed|partial|failed|off-task|refused`); the adopter
  runner must emit skill-creator's **exact pass/total** grading shape (byte-compatible,
  published schema). One fixed judge can't be both. The *decoupling* principle (judge is a
  separate phase over the transcript) holds within each harness; the judge *implementation*
  is not shared.
- **Corpus, report, staging, target vocabulary** stay harness-specific (the `Target` enums
  overlap on exactly one value, `claude-code`).

```
              ┌──────────────────────────────────────────┐
              │  PUBLISHED shared layer (the only shared)  │
              │     RunnerAdapter  ──→  normalized          │
              │     (per runtime)       transcript          │
              └───────▲───────────────────────▲────────────┘
                      │                        │
        ┌─────────────┴────────┐   ┌───────────┴───────────────┐
        │ compat-empirical     │   │ vat skill test (adopter)   │
        │ + own judge/corpus   │   │ + own (skill-creator) judge│
        │ (dogfoods the layer) │   │ + `runner` variant axis    │
        └──────────────────────┘   └────────────────────────────┘
```

## 3. Why now — the landscape moved

Research (2026-06-25; **dates/API names should be re-confirmed against live docs before
external quotation** — the *capabilities* are well-supported across sources):

- Anthropic published **Agent Skills as an open standard** (~Dec 18 2025). Multiple non-
  Anthropic runtimes adopted it natively, fast.
- **Microsoft Agent Framework** loads **unmodified `SKILL.md`** via `SkillsProvider` /
  `AgentSkillsProvider` with the *same* frontmatter (incl. `compatibility`), `references/
  assets/scripts` layout, and the *same* progressive-disclosure tools (`load_skill` →
  `read_skill_resource` → `run_skill_script`), incl. script execution. In-process; **no M365
  tenant — a model endpoint only.** *(This "same tool surface" is specific to the Agent
  Framework; e.g. Azure AI Foundry Agent Service shapes skills as **MCP resources** instead —
  the surface is per-runtime, not MS-wide.)*
- **OpenAI Codex CLI** also reads `SKILL.md` natively (`.codex/skills/`), with progressive
  disclosure, and runs **headless** via `codex exec` — i.e. a native, CLI-spawn, automatable
  runtime in the *same class as Claude Code*. **Gemini CLI** and others are similar.
- Where OpenAI lacks a SKILL.md unit is the **raw model APIs** (Responses API / Agents SDK):
  there a skill must be *flattened* (instructions → prompt, scripts → tools), losing
  progressive disclosure and description-driven triggering. Its consumer surfaces (Custom
  GPTs, ChatGPT Apps) are UI-only / not headless.

So there are now **several native non-Anthropic skill runtimes**; **Microsoft is the
*enterprise-relevant* one** for an M365 shop (not the *only* one). The next non-Anthropic
runtime to support is therefore chosen on *enterprise relevance*, not exclusivity. And
`compatibility` is a field more than one runtime now **accepts/preserves** (none yet *acts
on* it behaviorally).

## 4. The runtime ladder

| Rung | Runtime | Skill fidelity | How it's driven | Auth / friction | Phase |
|---|---|---|---|---|---|
| 1 | **Claude Code (CLI)** | Native | Spawn `claude -p` (today's `spawnHeadlessClaude`) | CC subscription / api-key | shipped |
| 1 | **Codex CLI / Gemini CLI** | Native | CLI-spawn (`codex exec` etc.) — the rung-1 driver generalizes | api-key | cheap; build on demand |
| 2 | **Claude Agent SDK** | Native | **In-process library** (likely driven unit-per-child-process for isolation, §5.2) | api-key | **first new adapter** |
| 3 | **Microsoft Agent Framework** | Native (same SKILL.md + progressive disclosure) | In-process library | **model endpoint only — no tenant/license** | **second adapter (proves cross-ecosystem)** |
| 4 | Raw model APIs w/o a skills-aware harness (e.g. OpenAI Responses API directly) | **Flattened** — no SKILL.md unit; lose progressive disclosure + auto-trigger | shim SKILL.md→prompt, scripts→function/MCP tools | api-key | **horizon — documented, not built** |
| 5 | claude.ai Chat · M365 Copilot declarative agents · Azure AI Foundry Agent Service · ChatGPT Apps | UI / manifest / tenant-bound | Not headless (browser-drive at best) / tenant deploy | heavy | **assisted/manual tier; deferred until an adopter ships on one** |

- **Claude Agent SDK is the first new adapter** — inside the Anthropic walled garden (shares
  skill semantics exactly → lowest-risk proof the adapter *seam* is real), and the
  **run-agents-as-a-service** path (standing services, not developer/session-spawned). High
  value independent of the cross-ecosystem story.
- **Codex/Gemini CLI** are *native* and *headless*, so they reuse the rung-1 spawn driver for
  near-free — build when an adopter wants them; they strengthen the generality argument but
  don't compete with Agent-SDK-first.
- **Microsoft Agent Framework is the second adapter** — cleanest **non-Anthropic** contender
  (native skill unit + near-tenant-free in-process), proves the seam reached beyond Anthropic,
  M365-aligned. (Azure AI Foundry Agent Service is the likely *production* target for that
  shop, but its tenant/MCP-resource shaping makes it a rung-5 deferral until an adopter ships
  on it; the in-process Agent Framework is the testable proxy, with a hosted-container
  fidelity gap.)
- **Raw-API flatten is a horizon rung**, not next: it tests *less of the skill*. Build only
  when an adopter need pulls it in.
- **The "Chat isolated-network" concern** is reproduced by a **sandboxed code-execution /
  container tool** on the env axis — *not* by driving a chat UI. To actually catch the bug
  class, the stand-in must replicate the properties that flip green→red: **no-egress by
  default** and a **matching preinstalled package/interpreter manifest**. The faithful native
  analog is Anthropic's **Code Execution tool + Files API** (what claude.ai itself uses), not
  an arbitrary container. *(Open: does the stand-in reproduce claude.ai's specific isolation,
  or merely a different sandbox? §9.)*

## 5. Target architecture

### 5.1 `runner` as a variant axis

The v2 eval runner's matrix is `variant = (model, env)`. The direction adds a third axis:

```
variant = (model, env, runner)
```

Today's behavior becomes the `claude-code` adapter; each other runtime is a new adapter.
This is the *execution-side* sibling of VAT's existing *build-side* runtime adapters
(Vercel / OpenAI / LangChain / Claude Agent SDK), reuniting the test side with the toolkit's
portable-agent roots. The v2 matrix's gating-vs-canary, `errored(...)` taxonomy, and
variant-in-cache-key all extend to the runner axis. The matrix shape needed to carry it is a
**deferred reshape**, not a pre-built generic engine (§5.5).

### 5.2 The `RunnerAdapter` contract — library-first, but it carries more than "drive + return"

Rungs 1–3 consume the **same unmodified `SKILL.md` + progressive-disclosure tool surface**,
so the adapter is designed around *that* — not around CLI-spawn (today's coupling in
`run-harness.ts` and in compat-empirical's `runtimes/`). But "given a staged dir + prompt,
drive a loop, return a transcript" is **underspecified**; the contract must also carry the
fields that are load-bearing today and differ per runtime:

> **A `RunnerAdapter`, given** a staged (read-only) skill dir + deps, a prompt, a resolved
> model, an env assignment, and an isolated writable sandbox, **drives an agentic loop and
> returns a normalized transcript + artifacts + usage + a structured outcome** — and the
> contract additionally specifies:
> - **loop-control owner** — who enforces turn/budget caps (the CLI today via `maxTurns`/
>   `maxBudgetUsd`; an in-process SDK must self-limit);
> - **streaming-vs-batch capability** — the stall-watchdog needs a token stream; a batch
>   library call can't emit stall signals, so `stall` is meaningless for it;
> - **tool / MCP / permission provisioning** — `--permission-mode`, plugin/MCP wiring are
>   CC-specific; MS/OpenAI authorize tools differently (the compat corpus has an MCP bucket);
> - **isolation-guarantee level** — see below.

**The hard part — in-process fs isolation.** A subprocess gets its own `HOME`/`TMPDIR`/`cwd`
for free; an **in-process library adapter shares the harness's Node process** and *cannot*.
So a "library-first" sandbox promise is hardest to keep for exactly the adapters it's designed
around (rungs 2–3). **Likely resolution:** in-process SDKs are still driven **unit-per-child-
process** for isolation — i.e. "in-process" means *library-driven*, not *same-process*. (Open
question, §9.)

The adapter does **not** grade.

**Multi-turn is out of v1.** Both `evals.json` prompts and compat-empirical's
`triggerPrompt` are single strings; nothing models a conversation or injected tool-results.
v1 measures **single-shot** behavior; the matrix carries a stated *single-shot* caveat
(on par with the flatten caveat). Multi-turn is deferred.

### 5.3 "Flatten" is an optional, fidelity-degrading capability — and *fidelity is environmental*

Translating a skill into a foreign runtime's primitives (SKILL.md → prompt, scripts →
function/MCP tools) is **not** in the core contract — it's an **optional capability an adapter
may declare**, explicitly fidelity-degrading. *Leave the socket; don't build the shim now.*

But **native ≠ full fidelity**. The motivating bug class lives in *environmental* differences
that vary even *between native runtimes*: **interpreter availability** (a skill calling
`python3`/`uv` passes on a dev box, fails in a no-toolchain sandbox), **network egress
policy**, **filesystem writability conventions**, and **tool/script-approval prompts** (CC
auto-allows in-boundary; MS Agent Framework added a Python script-approval gate; a headless
runner that auto-denies records a spurious red). Therefore the per-unit **fidelity record is
multi-dimensional** — `{ skill-loading: native|flattened, interpreter, egress, fs-writable,
approval-model }` — not a single `native|flattened` bit. Two "native" runs must not both read
as full-fidelity while differing on the axis that broke the skill. A sampled/flattened pass is
never silently read as a full/native pass.

### 5.4 Grader / runner decoupling — and a hardened, *per-harness* judge

The adopter runner currently fuses executor + grader into one Claude Code session (vendored
skill-creator grader). You can't fairly compare runtimes if the judge is entangled with one
contestant. **Direction:** the judge is a separate phase over the **transcript**, held
constant *across runtimes within a run* — but it is **per-harness, not the shared layer**
(§2: two rubrics). Hardening requirements:

- **Pin the judge** — an *immutable model snapshot id* + a judge-prompt SHA (compat-empirical
  already pins `judgePromptSha`); an API alias silently re-pointing breaks cross-*run*
  comparability.
- **`errored(judge)`** — the judge is its own API call that can 429 or fail; it gets its own
  error bucket, separate from the unit's `errored(rate-limit|environment|other)`, never scored
  as a content failure.
- **`judge ∉ models-under-test`** — a constraint, not an open question: with the runner axis,
  "judge = strongest Claude model" while testing `claude-agent-sdk` is the common case;
  correlated errors inflate agreement.
- **Judge non-determinism** is a second coin-flip on top of the run's; repeat-N (§5.6)
  partially averages it.

### 5.5 The variant space — concrete now, reshape when the runner axis lands

A 2-axis chassis (model, env) does **not** need a generic matrix engine, and pre-building one
would be speculative *and* the wrong primitive: a flat `{name, values[]}` can't model
**runner-dependent axes** (sonnet/haiku don't exist on MS/OpenAI; `ENGINE=native` is
meaningless off claude-code) without per-value metadata. Given the repo's **break-freely
pre-1.0** policy, the reshape you'd spend complexity now to avoid is cheap later.

**Decision:** ship the **concrete `(model, env)`** matrix now. When the `runner` axis lands,
reshape to whatever it then needs — most likely **per-value metadata records** (`values: {id,
auth?, applicableWhen?, …}[]`) and *constrained/conditional* axes (model ⊂ runner), **not** a
flat independent-cartesian `Dimension[]`. Coverage modes (§5.6) and per-tier scoping are
functions over *whatever* the matrix shape is; they don't require the generic engine now.

### 5.6 Coverage, sampling, and the depth axis the chassis was missing

**repeat-N is a first-class axis (was absent, is load-bearing).** Agent skill invocation is
**non-deterministic** — a single run is a Bernoulli draw, not a measurement (compat-empirical
already uses N=3 → adaptive 5 + Wilson CIs). The v2 chassis is single-shot; layering sampling
on top would *worsen* this. So:

- **Cost is counted in *runs*, not variants:** `runs = covering-array-size × repeatN`. The
  guardrail and any cost preview count runs.
- **Breadth vs. depth is a real budget tradeoff:** spend on more variants (sampling) *or* more
  repeats per variant (confidence). **Invariant: sampling may reduce variant count but must
  never reduce `repeatN`.**
- **The gating variant runs repeat-N with an explicit pass rule** (k-of-N, or a Wilson
  lower-bound ≥ threshold — exact rule a plan-time decision) *before* deriving an exit code. A
  single-shot gate flips red/green at random; "runs fully" is necessary but **not sufficient**
  — it must run *deeply*. And a flaky-green gate must **not** be frozen in cache (cache the
  rate, or refuse to cache a gating green whose CI is too wide).

**Coverage modes** trade breadth for cost over the **non-gating canary space only** (the
gating bar always runs, fully and deeply). Parameterize **strength `t`** rather than hardcoding
named modes:

| `t` | Name | Guarantee | Note |
|---|---|---|---|
| 1 | diagonal | every *value* appears ≥ once (round-robin) | **floor.** Aliases pairs: 2 models × 2 envs only runs `(m0,e0)`/`(m1,e1)`, never off-diagonal — proves each value works *somewhere*, not *together* |
| 2 | pairwise | every *pair* co-occurs ≥ once | **recommended breadth default** (catches "native fails *specifically* on haiku"). Cost ≈ lower-bound `v1·v2`, grows with factor count + construction |
| 3 | — | every triple co-occurs | pointless at 3 axes (= full), but the headline cross-env bug may be a **3-way interaction** (model × env=sandbox × runner) once a 4th axis lands — so `t` is a knob, not three fixed modes |

**Two levers compose.** (1) **Sample the variant space** (covering array; every eval still
runs) — the principled default. (2) **Distribute coverage across the eval suite** (each eval
runs on one variant) — cheapest, but it **destroys per-eval regression tracking, defeats the
skip-cache** (assignment shifts ⇒ every key misses unless pinned), and **compounds non-
determinism** (N=1 per eval×variant). Opt-in only; *incompatible with repeat-N reduction*.

**Correctness constraints:**
- **Deterministic + seeded selection, never random** (cache, comparability, no-`Math.random`).
  Separate concerns: *variant selection* is seeded-deterministic; *repeat count* may be
  adaptive. Seeding gives reproducibility within a fixed axis set — **not** stability across
  axis edits: greedy/IPOG arrays renumber when a value is added, orphaning cache keys. So
  either use an **order-stable/incremental construction** or **accept full cache invalidation
  on any axis change** (decide at plan time, §9).
- **Trigger precision needs negative prompts.** compat-empirical *requires* ≥1 negative prompt
  per entry to measure false-positive trigger rate; without negatives you measure recall only.
  Coverage methodology must carry the positive/negative distinction (and how sampling interacts
  with per-prompt repeat-N).
- **A sampled green ≠ a full green** — `run.json` records coverage mode + skipped variants
  (mirrors the fidelity discipline of §5.3).

## 6. Config surface evolution

The v2 `skills.config.<name>.test` block determines what's deferrable. The runner axis,
coverage, and grader decoupling are **all additive** to it. Because the design controls both
producer and the (single, RC) adopter, near-term churn is cheap — and **break-freely pre-1.0**
means we do **not** pre-build a generic engine to avoid a later reshape. The strategy is
**minimal now; reshape freely later.**

```yaml
skills.config.<name>.test:
  # ── ships now (v2 eval runner) ─────────────────────────────────────────────
  models: [sonnet, haiku]        # Claude-family ids; per-runner model mapping is a FUTURE
                                 #   axis — semantics RESERVED, not promised global
  env: { ENGINE: [default, native] }

  gating:                        # SET-MATCHER (not scalar) — the bar can be multiple values
    models: [sonnet]             #   require ≥1; e.g. [sonnet, opus] = both must pass, haiku canary
    env: { ENGINE: [default] }
    # omitted entirely ⇒ the WHOLE matrix gates (no canaries). A teaching advisory then
    # nudges: "declare a gating subset to unlock non-blocking canaries + a cheap tier + sampling."

  checks:                        # TOP-LEVEL deterministic gate (T0), vibe-validate-phase-shaped
    - name: cli-opens-native     #   name + run + exit-0=pass + per-check timeout. Zero-token,
      run: "extract open ${fixturesDir}/s.xlsx --engine native"   # but RUNS SKILL CODE:
                                 #   isolated + allowlisted + time-bounded + acked ("safe to run")
  tiers:                         # PURELY the eval ladder now (no `smoke:` field collision)
    - { name: smoke, evals: ["1-2"] }   # cheap tier; its variant-scope = the gating set
    - { name: full,  evals: "*" }

  retry: { attempts: 4, baseMs: 2000, factor: 2, jitter: true, capMs: 60000 }  # rate-limit

  # ── additive later (no reshape of the above) ───────────────────────────────
  # runners: [claude-code, claude-agent-sdk]   # EXPLICIT axis (NOT derived from compatibility);
  # gating: { ..., runners: [claude-code] }     #   lint the gating subset against `compatibility`
  # repeatN: 3                                  # depth axis (adaptive→5); cost = variants × repeatN
  # coverage: { strength: 2 }                   # t-wise over the canary space (default: full)
  # coverageSeed: 1                             # deterministic sample
  # judge: { modelSnapshot: <pinned>, promptSha: <pinned>, auth: ... }   # per-harness, hardened
```

**The two cheap, durable choices to make now** (everything else reshapes freely later):
1. **`gating:` is a set-matcher block** (`{ models:[…], env:{…} }`), not scalar
   `gatingModel`/`gatingEnv` — because the bar is legitimately a *set* (multi-gating), and
   omitting it cleanly means "the whole matrix gates" with a teaching advisory. (This is the
   right *shape*, independent of forward-compat.)
2. **`models` documented as Claude-family / per-runner-mapping-deferred** — so no adopter
   assumes it is globally cartesian across runtimes.

**CLI cache control mirrors `vv`:** a single **`--force`** = run even on a cache hit, then
overwrite the entry (scoped to the units in this run; no `--no-cache`/`--clear-cache`, no env
pass-through). Caching is **green-only** — a deliberate divergence from `vv` (which caches
failures + offers `--retry-failed`): skill-test units are billable + non-deterministic, so a
red always re-runs and `--force` exists to bust a stuck flaky *green*.

**Explicitly deferred / dropped:**
- *No variant-explosion guardrail* — the caller sees the matrix they configured.
- *Eval-specific checks* (a check scoped to one eval) — `test.checks` is skill-level only in
  v1; eval-scoping is a future additive `evals:` field on a check entry.
- *Multi-turn eval prompts* (§5.2).

## 7. Build sequence

The shared **RunnerAdapter + transcript** layer is extracted only once it has a *second real
consumer* (rule-of-three: adopter runner + Agent SDK adapter + compat-empirical) — not before.

1. **Ship v2 concrete** — Claude Code only, concrete `(model, env)` matrix, the recovered
   `gating:`/`checks:`/`--force` config (above). No generic engine, no runner axis.
2. **`claude-agent-sdk` adapter** (rung 2) — the *second real consumer* and the
   run-as-a-service path. Resolve in-process fs isolation here (likely unit-per-child-process).
3. **Extract + publish the RunnerAdapter + normalized-transcript layer** — decide the owning
   **published** package (`spawnHeadlessClaude` already lives in published utils; either keep
   it there or graduate to a `@vibe-agent-toolkit/skill-runtime`-style package — *not*
   dev-tools, which is private). **Precondition:** the normalized-transcript schema is
   *specified first* (minimal shape: ordered events of `{ type/role, text, tool-calls (name +
   structured input + result), termination reason }` + final output + usage; liberal/passthrough
   ingestion of each runtime's native format, strict normalized emission — Postel). **Migrate
   compat-empirical onto it** (the dogfooding step), consolidating `runClaude*` ↔
   `spawnHeadlessClaude`. *(Plan-time: confirm exactly where `runClaude*` is defined.)*
4. **`runner` axis in the matrix** — reshape the concrete matrix to carry runner (per-value
   metadata / conditional axes, §5.5); wire gating/canary, per-unit fidelity record,
   variant-in-cache-key.
5. **repeat-N + coverage modes** — the depth axis + t-wise sampling over the canary space,
   with the gating pass-rule and deterministic-seeded selection.
6. **`ms-agent-framework` adapter** (rung 3) — proves cross-ecosystem; resolve C#/Python
   `SkillsProvider` driving (subprocess vs. hosted endpoint).
7. *(horizon, unbuilt)* raw-API flatten capability; Codex/Gemini CLI adapters on demand.

Steps 1–2 ship adopter-visible value with no extraction. Extraction (3) lands when it's
justified by real consumers + dogfooding, not speculation.

## 8. Non-goals / over-engineering guardrails

- **Do NOT pre-build a generic matrix engine** — concrete `(model, env)` now; reshape (to
  per-value-metadata / conditional axes) when the runner axis lands.
- **Do NOT build the foreign-framework flatten/shim machinery now** — only the *socket* until
  a rung-4 adopter need exists.
- **Do NOT extract the shared layer before a second real consumer exists** (rule-of-three).
- **Do NOT fork a second runtime layer** — publish *one* RunnerAdapter+transcript layer and
  dogfood it via compat-empirical; but **keep the judge per-harness** (two rubrics).
- **Do NOT drive chat UIs in CI** — assisted/manual tier; the automatable stand-in is a
  no-egress, matching-package sandbox (Code Execution tool + Files API).
- **Do NOT vary the judge per runtime within a run**, and **judge ∉ models-under-test**.
- **Do NOT treat a single-shot run as a measurement** — gating runs repeat-N with a pass rule;
  sampling never reduces repeatN.
- **Do NOT sample the gating variant, sample randomly, or read a sampled/flattened green as a
  full/native green** — record coverage mode + multi-dimensional fidelity in `run.json`.

## 9. Open questions

- **Owning package** for the published RunnerAdapter+transcript layer (utils vs. a new
  `skill-runtime` package); dependency direction so private compat-empirical and the published
  CLI both consume it.
- **In-process fs isolation:** confirm in-process SDKs run unit-per-child-process (likely), or
  define the weaker isolation guarantee they accept.
- **Reshaped matrix primitive:** per-value metadata + conditional axes (model ⊂ runner, env ⊂
  runner) — exact shape, decided when the runner axis lands.
- **Gating pass-rule threshold** (k-of-N vs. Wilson lower-bound), and **repeat-N defaults**
  (N=3 adaptive→5?) for the adopter runner.
- **Covering-array construction:** order-stable/incremental (cache-stable) vs. accept full
  invalidation on axis edits; how it composes with the locked gating rows.
- **Adapter packaging:** non-Claude-Code runtimes as lazy-loaded optional peer deps (per PR
  #124) so VAT doesn't hard-depend on the OpenAI/MS SDKs.
- **Auth matrix:** preflight expressing "this lane can run runtimes {X,Y} not {Z}" →
  `errored(environment)`.
- **MS Agent Framework driving:** C# vs. Python `SkillsProvider` from a Node CLI (subprocess
  vs. hosted endpoint) — does it reintroduce a spawn-shaped adapter for rung 3?
- **Chat stand-in fidelity:** does a no-egress sandbox reproduce claude.ai's *specific*
  isolation, or only a different sandbox?
- **Distribute-across-evals (lever 2):** keep opt-in only, given it destroys regression
  tracking + defeats cache + compounds non-determinism?

## 10. References

- Internal calibration harness: issue #100, PR #108; v2 design
  `docs/research/2026-05-23-compat-empirical-harness-v2-design.md`; code
  `packages/dev-tools/src/compat-empirical/` (`runtimes/driver.ts`, `judge/`).
- Adopter eval runner: PR #132 (v1), PR #135 (v2 tiered/parallel/cacheable runner); code
  `packages/agent-skills/src/skill-test/`, `packages/cli/src/commands/skill/test/`,
  `packages/utils/src/skill-test/spawn-claude.ts`.
- Compat stance: `docs/architecture/compatibility.md`,
  `docs/skill-quality-and-compatibility.md`, `docs/validation-rule-design.md`.
- Lazy-loaded provider precedent: PR #124. Cache model precedent: `vibe-validate` `vv run --force`.
- Brainstorm origin (uncommitted): `docs/superpowers/specs/2026-06-25-skill-compat-testing-runner-adapters-design.md`.
