# Validation Rule Design — How VAT Decides What to Flag

This document is the rubric VAT follows when adding, promoting, demoting, or removing a validation code — especially the skill-smell codes that grew out of the unified validation framework (`0.1.30+`). It is a stance doc, not a tutorial. Every default in [`docs/validation-codes.md`](./validation-codes.md) traces back to a principle here.

The sibling doc [`docs/skill-quality-and-compatibility.md`](./skill-quality-and-compatibility.md) names *what* VAT believes about skill shape and runtime compatibility. This doc names *how* those beliefs get translated into rules — the authorial discipline that keeps the linter humble.

## The Bar for Adding a New Rule

A rule must describe a pattern that appears in real corpora. Rules follow observation; they do not precede it.

"I can imagine someone doing this and it seems wrong" is not evidence. Neither is "another linter has this rule." What qualifies is a concrete artifact — a SKILL.md, a `plugin.json`, a hook script — where the pattern was observed, captured, and can be pointed at when the rule is proposed. Pre-v1, the three adopter corpora (`vibe-agent-toolkit`, `vibe-validate`, `avonrisk-sdlc`) are the minimum evidence floor. Post community scanning (Workstream B in the strategy spec), the corpus expands and the evidence bar rises with it.

Rules added against synthetic, theoretical, or aesthetic-only cases get rejected. This is not a matter of taste; it is a matter of keeping false-positive rates low enough that adopters still trust the tool. A linter that cries wolf in plausible-but-unobserved territory trains users to ignore it.

## Default Severity Posture

New rules ship at `info` or `warning`. `error` requires demonstrated harm, not disagreement with the pattern.

The reasoning is asymmetric. A false `error` forces adopters to suppress with `validation.severity` or add `validation.allow` entries — both of which cost author attention and pollute config files with exception records. A false `info` or `warning` is visible, mildly annoying, and gets ignored until the adopter has a reason to care. The cost of being wrong at `error` is high; the cost of being wrong at `warning` is low. We choose the forgiving failure mode by default.

`error` is reserved for patterns where the skill genuinely cannot function as written — a link target that doesn't exist (`LINK_MISSING_TARGET`), a link that escapes the project root (`LINK_OUTSIDE_PROJECT`), a packaged file that has no way to be discovered by the agent (`PACKAGED_UNREFERENCED_FILE`). In those cases, the skill is broken in a demonstrable way; blocking the build is the honest signal.

A new smell-style rule — "this description seems short," "this skill uses a binary not guaranteed on the target" — defaults to `warning` or `info` no matter how confident the author of the rule is. Confidence without corpus evidence is the most common mistake in linter design; the severity floor enforces humility.

## Graduation Path

Defaults can change, but the evidence requirement is symmetric. A severity promotion (`info` → `warning`, `warning` → `error`) and a demotion both require corpus data showing the change is warranted: a promotion when false-positive rates drop below an acceptable threshold across observed skills; a demotion when the rule fires on too many legitimate patterns to justify its current severity.

A severity promotion is a breaking change. Adopters whose configs assume `warning` may suddenly have a blocking `error`. Promotions go through SemVer minor releases at minimum (pre-1.0) and major releases post-1.0, with migration notes in `CHANGELOG.md` and, where reasonable, a grace-period release where the new severity ships behind an opt-in config knob.

Demotions are not breaking, but they are still evidence-gated — we do not quietly loosen rules because they are inconvenient. If a rule is demoted, the rationale goes in the changelog so the history is legible.

Rule removal is the last resort and follows the same logic: if a rule is wrong often enough that demotion doesn't help, remove it and document why. Dead rules in the registry are worse than no rules at all.

## Attribution and Humility Conventions

Every VAT finding is attributed. When output is rendered in contexts where it might be confused with authorial voice — description badges, audit summaries, future community scan reports — it is prefixed with `[vat: ...]`. This is borrowed from Clippy's `clippy::` lint attribution and serves the same purpose: the tool owns the opinion, the author is not accused.

The framing language matches. VAT emits **smells**, **observations**, and **findings** — not **violations**, **errors of judgment**, or **quality failures**. The vocabulary is deliberate: a smell is something worth sniffing at, not a verdict.

Every rule links back to the codes registry at [`docs/validation-codes.md`](./validation-codes.md). A rule that does not appear there does not exist — there is no hidden validation, no undocumented smell, no finding the adopter cannot look up.

## The Non-Judgment Line (for Rule Designers)

The non-judgment principle is usually stated as advice to CLI output consumers: "VAT reports patterns, it does not grade plugins." That version is true but incomplete. The stronger version applies to rule designers themselves: **rule descriptions must describe the pattern, not attack the author.**

Compare:

- "Skill declares a target it cannot fulfill" — neutral, describes the static-analysis finding.
- "Skill makes false compatibility claims" — judgmental, ascribes intent.

Both describe the same underlying code (`COMPAT_TARGET_INCOMPATIBLE`). The first lets the author read the finding and correct it without feeling accused. The second reads as prosecution. The rule author's word choice shapes how the rule feels in a real audit report; choose language that describes the artifact, not the person.

This matters most in rules about *quality* rather than *correctness*. "This description is short" is a fact; "this description is bad" is a judgment. Stay on the fact side.

## Configurability-First

Every rule must be suppressible — either class-wide via `validation.severity` (promote, demote, or ignore the code) or per-instance via `validation.allow` (allowlist specific `(code, path)` pairs with a required human-readable `reason`).

The `reason` field is non-negotiable. An allowlist without reasons becomes hidden state: entries accumulate, their original justification is forgotten, and the config is no longer a record of considered exceptions — it is a wall. The `reason` turns each entry into documentation: *why did a human decide this instance is fine?* The optional `expires` date goes further, giving time-boxed overrides a forced re-review prompt via `ALLOW_EXPIRED`.

A rule that adopters cannot opt out of is a rule VAT cannot ship at `warning` or above. If VAT believes a constraint is universal enough that suppression should be impossible, that is evidence the rule belongs in a hard schema validator (Zod), not in the smell framework.

## Code Check or Manual Checklist?

Every proposed rule must be classified as either an **automated check** (emitted by `vat audit` / `vat skills validate` with a code in [`docs/validation-codes.md`](./validation-codes.md)) or a **manual checklist item** (rendered as a `[ ]` line in `vat skill review`'s walkthrough output). The wrong classification erodes trust in either direction: noisy automated checks train users to ignore findings; "judgment calls" buried as automated `warning`-level codes generate false positives that adopters rightly silence.

**Codeable signals** — make it an automated check when:

- The pattern has a single right answer that does not depend on audience or context.
- A regex, schema diff, file-system check, link resolver, or word count can decide it.
- A representative slice of corpus shows the detector firing with a low false-positive rate at the chosen severity (rule of thumb: <10%).
- The fix is mechanically reproducible from the rule message + path + location, without further inspection.

Examples that qualify: `name`/`description` presence in frontmatter (parse + key existence); plugin manifest required fields like `version` and `author` (JSON parse + key existence); kebab-case naming (regex); description length thresholds (string length); body word count (counter); bundled-but-unreferenced files (link resolver across body); broken `[link](path)` references (file-system check); non-standard frontmatter keys (schema diff). These all decide cleanly.

**Judgment-call signals** — keep it on the manual checklist when:

- Multiple acceptable answers exist depending on the skill's audience, scope, or sibling context.
- Cross-skill semantic comparison is required (e.g., disambiguation from siblings in the same plugin).
- Runtime testing or execution would be needed to verify (e.g., "examples are complete and working").
- A heuristic exists but generates enough false positives that an automated finding would be silenced more often than acted on.

Examples that qualify: "Does the description disambiguate from sibling skills?" (semantic + cross-skill); "Is the body imperative throughout?" (heuristic-but-noisy on dialog/example text); "Are concrete scenarios concrete *enough*?" (subjective threshold); "Does the skill trigger on expected user queries?" (interactive).

**The gray zone is real.** A few classes of rule sit between code and checklist — for example, "description leads with trigger keywords" or "body avoids second-person openers." Default to the **info-severity automated check** in the gray zone: code flags it, but at info level so a reviewer can override the call without config-file pollution. If the false-positive rate stays low across corpus runs, the rule graduates to `warning` per the [Graduation Path](#graduation-path) above; if it stays high, the automated check is removed and the concern moves to the manual checklist with a `[VAT]` annotation.

**The rule designer's hand-off:** when classifying a proposed rule, write *both* the candidate automated detector spec **and** the equivalent checklist item. If the checklist item is the higher-fidelity expression of the concern, the rule belongs there and the automated detector is dropped. If the automated detector hits the rule's intent without imposing on the reviewer's judgment, ship the code-check and add a brief reference line to the checklist (so manual review still surfaces the concept when no automated finding fired). The two surfaces are complementary, not redundant.

## Per-Rule Documentation

Every code in [`docs/validation-codes.md`](./validation-codes.md) follows the same four-field template:

- **Default** — severity the code ships at.
- **What** — the pattern the detector matches, phrased as a neutral observation.
- **Why it matters** — the reasoning connecting the pattern to a real concern. This is where the stance shows; this is also where rule designers must resist the urge to over-claim.
- **Fix** — concrete actions an adopter can take, including the allow-entry pattern when the finding is intentional.

This is Clippy's template, lightly adapted. The test at `packages/agent-skills/test/docs/validation-codes.test.ts` enforces that every code in `CODE_REGISTRY` has a documented entry — new codes cannot merge without their docs. The docs are part of the code; they ship together or not at all.

When the Why-it-matters section extends beyond a paragraph, it belongs in [`docs/skill-quality-and-compatibility.md`](./skill-quality-and-compatibility.md) instead, with the codes reference linking out. The code entry stays short; the stance doc carries the longer argument.

## Data-Driven Evolution

Rule additions, severity changes, and rule removals are all driven by corpus evidence. The community-scanning workstream is designed to produce this evidence at ecosystem scale. Before that lands, adopter corpora are the substrate.

Decisions of the form "I think this is a smell" without corpus data are rejected, no matter how confident the proposer. This is not pedantry; it is survivorship. The linter tools that remain useful across years — ESLint, Clippy, gofmt's vet — earned their authority by being empirical about their rules. The ones that did not are remembered as noise. VAT aims for the first category.

An implication worth stating: if community scanning reveals that a currently-shipped rule fires too often, we fix the rule, not the corpus. The ecosystem's actual shape is the ground truth. Our rules serve it, not the other way around.

## Related Docs

- [`docs/validation-codes.md`](./validation-codes.md) — code-level reference for every rule VAT emits.
- [`docs/skill-quality-and-compatibility.md`](./skill-quality-and-compatibility.md) — VAT's stance on what makes a skill good and compatible.
