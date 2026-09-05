# Validation Rule Design — How VAT Decides What to Flag

This document is the rubric VAT follows when adding, promoting, demoting, or removing a validation code — especially the skill-smell codes that grew out of the unified validation framework (`0.1.30+`). It is a stance doc, not a tutorial. Every default in [`docs/validation-codes.md`](./validation-codes.md) traces back to a principle here.

The sibling doc [`docs/skill-quality-and-compatibility.md`](./skill-quality-and-compatibility.md) names *what* VAT believes about skill shape and runtime compatibility. This doc names *how* those beliefs get translated into rules — the authorial discipline that keeps the linter humble.

## The Bar for Adding a New Rule

A rule must describe a pattern that appears in real corpora. Rules follow observation; they do not precede it.

"I can imagine someone doing this and it seems wrong" is not evidence. Neither is "another linter has this rule." What qualifies is a concrete artifact — a SKILL.md, a `plugin.json`, a hook script — where the pattern was observed, captured, and can be pointed at when the rule is proposed. Pre-v1, the two adopter corpora (`vibe-agent-toolkit`, `vibe-validate`) are the minimum evidence floor. Post community scanning (Workstream B in the strategy spec), the corpus expands and the evidence bar rises with it.

Rules added against synthetic, theoretical, or aesthetic-only cases get rejected. This is not a matter of taste; it is a matter of keeping false-positive rates low enough that adopters still trust the tool. A linter that cries wolf in plausible-but-unobserved territory trains users to ignore it.

**A rule's population is a design decision, and declaring it is part of proposing the rule.** Whatever the project's config declares as **test input** must be excluded from a quality check's *population*, not merely from its packaging. VAT already honours that declaration when it builds an artifact — a path under `skills.config.<name>.test.evals` is dropped from the bundle, and the drop is receipted as [`PACKAGED_TEST_INPUT`](./validation-codes.md#packaged_test_input) so a silently skipped copy is never mistaken for one that worked. The same declaration binds a check that is only counting. Fixtures are *supposed* to be minimal variations on one another; a detector that reads them as ordinary artifacts is measuring the test harness and reporting it as the corpus.

The measurement, 2026-08: run over every `SKILL.md` in the tree, a prototype description-collision check reported **9 colliding pairs on VAT — and all nine were test fixtures** (`plugin-a-example`/`plugin-b-example`, `test-skill-1`/`test-skill-2`, `matching-skill`/`mismatch-skill`, and two files both named `foo`). Excluding declared test-input paths took VAT from 9 pairs to **0**, and the corpus from 59 descriptions to 23. The detector did not change. Every finding it had was an artifact of who was in the room.

**The part worth writing down is why it nearly shipped anyway.** The exclusion changed *nothing* on the marketplace and adopter corpora — neither has fixture-shaped paths — so a reviewer sanity-checking the rule against those two would have seen stable, plausible numbers and no reason to suspect the population at all. The corpus that exposed the bug was the authoring project, and it exposed it only because nine-out-of-nine was too bad to believe. That is the general shape: a population bug is invisible by construction on any corpus that lacks the shape being wrongly included, so the corpora where a check looks best calibrated are often the ones where it had nothing to get wrong. A rule validated only against other people's corpora would have shipped with this intact.

So the population is stated and defended when the rule is proposed — which paths are in, which are excluded, and on whose declaration — and it is sanity-checked against **the authoring project specifically**, never only against foreign corpora. The two adopter corpora named above are the floor for whether a pattern is *real*; the authoring project is the corpus where a wrong answer is recognizable on sight, which is the only property that catches a population containing things it should not. Report the denominator with the count — `N findings over M artifacts`, with the exclusions named — so the next reader can challenge the population and not just the threshold. And treat a result that is too bad to believe as evidence about the population before it is evidence about the corpus: check the denominator first. This is the rule-design half of [`.claude/rules/tests-that-prove-nothing.md`](../.claude/rules/tests-that-prove-nothing.md) — a suite that collected zero tests and a check scored over the wrong population both exit clean carrying a confident number, and neither is visible in a diff.

## Check Families — One Code, Many Variants

Not every new check deserves its own top-level code. When a check is a *variant* of an existing concern — same underlying problem, remediation only slightly different — model it as a member of a **family**: one registry code that internally dispatches to a table of labeled sub-checks.

A family is the right shape when:

- the sub-checks share a severity and a remediation theme (e.g. "reference bundled assets portably", "avoid non-portable shell utilities"), and
- an adopter who wants to silence one almost always wants to silence the whole concern for that file.

The mechanics: each variant is a `{ label, pattern, fix }` row; every finding emits the single family code but names its variant (`[<label>]`) and carries the variant's tailored `fix`. Because they share one code, a single `validation.allow` / `validation.severity` entry governs the **entire family** — adding an esoteric variant never multiplies the override surface an adopter has to manage, and a per-file allow silences the whole concern in one line instead of an exception per sub-check. Reference implementation: `NON_PORTABLE_ASSET_REFERENCE` (`packaging-validator.ts` → `NON_PORTABLE_ASSET_VARIANTS`).

Prefer a family over a new code for small or esoteric checks. Reserve a new top-level code for a genuinely distinct concern that needs its own severity story and its own override. Collapsing *already-shipped* distinct codes into a family is a breaking change (adopter configs reference code names), so this guidance governs *new* checks, not retroactive consolidation.

## Default Severity Posture

New rules ship at `info` or `warning`. `error` requires demonstrated harm, not disagreement with the pattern.

The reasoning is asymmetric. A false `error` forces adopters to suppress with `validation.severity` or add `validation.allow` entries — both of which cost author attention and pollute config files with exception records. A false `info` or `warning` is visible, mildly annoying, and gets ignored until the adopter has a reason to care. The cost of being wrong at `error` is high; the cost of being wrong at `warning` is low. We choose the forgiving failure mode by default.

`error` is reserved for patterns where the skill genuinely cannot function as written — a link target that doesn't exist (`LINK_MISSING_TARGET`), a link that escapes the project root (`LINK_OUTSIDE_PROJECT`), a packaged file that has no way to be discovered by the agent (`PACKAGED_UNREFERENCED_FILE`). In those cases, the skill is broken in a demonstrable way; blocking the build is the honest signal.

There is a second, narrower class that also ships at `error`, and it is worth naming because it is *not* a judgement about the skill at all: **run-integrity** codes, which report that VAT could not complete its own inspection. `RESOURCE_UNREADABLE` is the reference case — a file was enumerated but could not be admitted (a committed dangling symlink, an unreadable file), so it is silently absent from `filesScanned` and from bundle contents. The severity floor above does not apply to this class, because the forgiving failure mode is the *dangerous* one here: a `warning` would leave a green run that silently inspected less than it claimed, which is the "zero rows looks like a clean bill of health" failure. A run-integrity code says "this result is incomplete, do not trust it", not "your skill is wrong" — so it is exempt from the corpus-evidence bar, but it must be reserved strictly for VAT's own inability to look, never for anything it looked at and disliked.

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

**Corpus evidence carries a second coordinate that is easy to drop: *where in the packaging pipeline the artifacts were read*.** A corpus is not simply a set of skills; it is a set of skills at a particular point between source repository and installed tree, and those are different populations with different contents. The measurement, 2026-08: one near-duplicate-document detector (MinHash over document shingles, reporting pairs at Jaccard ≥ 0.7) run unchanged over three corpora. On the VAT source tree — **148 documents, 0 pairs, 0 documents implicated, 0.0%**. On a large adopter monorepo, also read in source form — **1,430 documents, 9 pairs, 22 documents implicated, 1.5%**. On a community marketplace tree, the same class of content one packaging step later — **1,553 documents, 281 pairs, 295 documents implicated, 19.0%**. Same detector, same threshold, comparable corpus sizes; the finding rate rose more than twelvefold across a step that changes no author's writing.

**The jump is not a publisher's habit, and it is not a defect in anyone's authoring — it is VAT's own distribution model working exactly as designed.** The packaged findings were spread across **6 of 9 publishers** (178 intra-publisher pairs, 132 cross-publisher), which is the shape of a community-wide pattern rather than one author's carelessness. The mechanism is mechanical: a skill must bundle the references it links, so a reference file shared by four sibling skills is *correctly* copied four times — surfacing at Jaccard **1.0**, the strongest signal such a detector can emit, from artifacts that are all precisely right. Three design consequences follow, and all three are settled before a line of the detector is written. A check of this kind belongs on the `vat audit` lane over installed trees. It would find **nothing** on the `vat validate` source lane — not "few findings", nothing, because the copies do not exist yet. And it must ship at `warning` and **never** `error` until a plugin-level shared-resource mechanism exists, since at `error` VAT would be failing builds over duplication VAT itself required.

**This is the population argument from [The Bar for Adding a New Rule](#the-bar-for-adding-a-new-rule) arriving from the opposite direction, and the pairing is the durable idea.** There the population was too *wide* — declared test input left in, so a detector reported nine collisions that were nine fixtures, and every finding it had was an artifact of who was in the room. Here a population can be too *narrow* in a way no exclusion list fixes: the source lane contains no packaged trees, so the pattern is absent by construction and the check reads clean forever while never once meeting its subject. **A population bug is silent in both directions.** Scored too wide, a check invents findings out of artifacts that were never in scope; scored too narrow, it retires undefeated having been asked a question it could not have answered. Both exit green carrying a confident number. So the population a rule states at proposal names not only which paths are in and which are excluded, but **which lane the rule runs on and why the pattern it looks for can occur there** — and evidence gathered on packaged trees is evidence for `vat audit`, never for `vat validate`.

**One implementation note belongs with this, because a detector's cost is part of whether it can be an automated check at all** (see [Code Check or Manual Checklist?](#code-check-or-manual-checklist)): a MinHash signature must be **stored sliced into LSH bands**, not held as one array. Measured 2026-08 on the packaged corpus above, the obvious Jaccard estimate — a lambda over the whole signature, evaluated per pair — took **13.4 s for 1.12 M pairs, 17× slower than the 384-dimensional float cosine it was supposed to undercut**, which is to say the cheap approximation lost to the thing it was approximating. Standard banding (16 bands × 8 rows, candidates generated by an equality join on a band hash) does the same work in **15 ms at recall 1.0** — an **890×** speedup, and the difference between a check that can sit in a routine lane and one that can only ever be run by hand.

## Related Docs

- [`docs/validation-codes.md`](./validation-codes.md) — code-level reference for every rule VAT emits.
- [`docs/skill-quality-and-compatibility.md`](./skill-quality-and-compatibility.md) — VAT's stance on what makes a skill good and compatible.
