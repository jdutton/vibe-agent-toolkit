# Drift classes — the quality problems that grow, and the fix for each

A drift class is a shape of code that is harmless the day it appears and expensive by the time
anyone notices. Every class below was found in this repository by adversarial review, not by the
gate: each had compiled, linted and passed its tests the whole time it grew. The root
[`CLAUDE.md`](../../CLAUDE.md) states the policy — **fix the class, not the instance, in the same
change** — and this page holds what each class looks like, the tell that identifies it in review,
and the fix that actually closes it.

The common thread: every one of these makes a green result mean less than it appears to. That is
why they are found by review and not by the gate, and why the fix is never to make the finding go
quiet.

## What is not a fix

When a review surfaces an instance of a class, these responses leave the class in place and are
refused on sight:

- a compatibility shim, a re-export "for convenience", or an old API kept beside the new one
  (pre-1.0: the old one is deleted, every consumer updated);
- an allowlist, baseline or exemption entry for the instance;
- an `eslint-disable`, `NOSONAR` or `@ts-expect-error` on the instance;
- widening a factor, threshold or timeout until the instance passes;
- a `TODO`, a follow-up ticket, or a "known limitation" sentence in a doc;
- fixing the one site the reviewer named while the sibling sites keep the shape.

The cheap fix and the right fix are usually the same size at the moment of discovery. The gap
between them is what the class charges later.

## 1. Two contracts for one thing

**Shape.** A second exit-code table, severity vocabulary, report envelope, error base class,
containment predicate, path resolver or enumeration lane, where one already exists. Each was
written because the first was one import too far away, or its shape was slightly wrong for the new
caller, or the author did not know it existed.

**How it grows.** Nobody adds a *fifth* vocabulary on purpose; they add a second, and the second
makes a third cheaper to justify. Every adopter-facing surface then has as many behaviours as it
has authors: the same failure exits 0 from one verb and 1 from its neighbour; the same finding is
`warn` in one report and `warning` in another, bridged by a helper whose own comment admits it.

**Tell.** Two names for the same concept in one grep (`warn`/`warning`, `findings`/`issues`/
`errors`, `filePath`/`file`/`path`); a doc that lists N lanes when the code has N+1; a
`normalize*` or `to*` helper whose only job is to bridge two vocabularies; a table in a doc that
says "all commands exit 0/1/2" next to a command that exits 3.

**Fix.** One definition in the lowest package that every consumer can import from (`schema` for
contracts, `utils` for predicates), with a `.strict()` schema or a pinned barrel so its shape is
the contract. Delete the others and migrate every caller in the same change — a lint rule against
the old shape (`no-literal-process-exit`, `commands-import-boundary`) is what stops the second copy
from coming back.

## 2. An optional seam whose omission is the failure

**Shape.** A `field?:` on a report whose absence makes a denominator lie; a defaulted parameter
whose default is the unsafe behaviour; a `.passthrough()` schema on config that swallows a typo the
strict version would have warned about; an opt-in check nobody opts into; a new parameter added by
a fix that every existing caller silently omits.

**How it grows.** Every caller that ignores the seam compiles. A fix that adds an optional seam
therefore fixes the one call site the reviewer named and none of the others, and the miss surfaces
one review round later as a new finding with the same root. Six rounds of "high" findings on one
branch traced to this shape.

**Tell.** A fix whose diff adds `?:` or `= default` to a signature; a test that constructs the
report without the field and still passes; a schema with `.passthrough()` and no comment naming the
adopter key it is preserving; a guard the caller must remember to call.

**Fix.** Make it required and let the compiler enumerate the callers. Where a default is genuinely
right, the default is the *safe* value and the unsafe one is spelled out at the call site. A
schema is `.strict()` unless a comment names the foreign key it must tolerate, and the reason is
proved by a probe, not assumed.

## 3. A rule nothing enforces

**Shape.** A sentence in `CLAUDE.md`, a docstring, or a README that states a rule the code below
does not implement; an `(enforced by: X)` tag naming a check that does not check it; a list of
what the tree contains — scripts, skills, docs, call sites — that was `ls` output the day it was
written; a "generated" artifact with no `--check` in the gate.

**How it grows.** Prose is never executed, so it is never wrong in a way that fails. Eleven false
claims accumulated in the one file every agent session reads first. A hand-maintained list is
correct for a month and then permanently stale in the direction nobody notices (missing entries,
never extra ones).

**Tell.** A rule with no `(enforced by:)` tag, or whose tag names a step that does not reference
the rule; a number in prose (`< 100 ms`, `85 entries`) that the code does not carry as a constant;
a list whose last entry is older than the directory it describes.

**Fix.** Add the enforcer — a lint rule, a `validate-structure` rule, a `gen:` block with a
`--check` that runs in the gate — or delete the claim. A rule that is worth stating is worth
enforcing; one that is not worth enforcing is a preference, and preferences do not go in
`CLAUDE.md`. Numbers live in code as named constants and docs cite the constant.

## 4. A one-way ratchet

**Shape.** An allowlist, ceiling, backlog or exemption list asserted only against growth: the
test fails when a new entry is needed, and says nothing when an entry is no longer needed. Its
sibling: a per-file budget whose listed files are bound by *nothing* — the list was meant as a
temporary exemption and became a permanent one.

**How it grows.** Stale entries hide indefinitely because nothing reports them, so the list never
shrinks and stops being a measure of anything. Once the listed set is unbounded, a regression on a
listed file is invisible for as long as the file stays listed — which is forever.

**Tell.** A ratchet test with one `expect` (the ceiling) and no second `expect` (the floor); an
entry whose reason comment describes a state that no longer exists; a listed file whose measured
value is well under the budget it was exempted from; a gate that allowlists its *passing*
severities, so renaming a severity makes it pass silently.

**Fix.** Assert both ways: the list may not grow (new entries need a reason inline) and may not
carry an entry the tree no longer needs (the test reports the stale entry and fails). Listed files
still carry a ceiling — a multiple of their own measurement, never "no limit". The remedy for a red
is to shrink the list, not to extend it.

## 5. A check that cannot fail

**Shape.** A fixture that cannot distinguish the behaviour under test from its absence; an
assertion over a named subset that happens to exclude the failing case; a helper that cannot
express the failing input; a `describe.skipIf` that reads a flag set in `beforeAll` — evaluated at
collection time, so the suite never runs anywhere; a suite that no tier collects; a gate step
guarded by `import.meta.main` that is a silent no-op on the very runtime it declares; a fix that
makes a *neighbouring* test vacuous because the new fail-closed behaviour satisfies it for free.

**Its guard-side twin.** A guard that returns the reassuring value when it does not know: a
refused directory reported as absent; an unknown exit code collapsed to `error`; a crash exiting 1
(findings) instead of 2 (system); `Math.max(1, x)` as a "floor" when `x` can be `NaN`. Each turns
a failure into a value the caller cannot tell from success.

**How it grows.** Green is the only signal anyone reads. A test that has never been red is
indistinguishable from one that cannot be red, and a guard that always returns the safe-looking
value never produces the bug report that would expose it.

**Tell.** A test that was written from a reviewer's diagnosis and never seen red; a test that
still passes when the code under test is reverted; a `catch` that maps every error to one value; a
tier whose duration is under a second; a guard whose "unknown" branch returns the same value as
its "fine" branch.

**Fix.** Prove it red first — revert the code, or hand the guard a mode-000 directory, and watch
the assertion fail — and only then trust the green. Guards fail closed: a refusal is a refusal, a
crash is exit 2, an unknown is an error, and the fixture is hostile (`hostile-tree.ts`) rather
than friendly. When a fix widens what "yes" means, re-read the tests next to it.

## 6. A contract carried in text

**Shape.** `error.message.includes('…')` as dispatch; a caller that sniffs a prose prefix to
decide what kind of error it holds; a test regex over an error message; a status derived from a
string that was meant for a human.

**How it grows.** The message is edited for clarity and three packages silently take the other
branch. The test that would catch it matches the old message and is the only thing that fails, so
the regex is updated and the dispatch stays wrong.

**Tell.** A string literal that appears both in a `throw` and in an `includes`/`match`/`startsWith`
elsewhere; a test whose expectation is a fragment of prose.

**Fix.** A `code` on the error (`VatError` subclasses carry one), a typed field on the report, an
`instanceof` or a discriminant — and the test asserts that, not the sentence.

## Naming the class in review

A review finding that names its class is actionable; one that names only the instance invites the
cheap fix. A finding in this repo should say which class it is and what the class-level fix is, so
the fixer can answer "this was found, and per `CLAUDE.md` we fix the class" instead of patching
the line. The [`coherence-audit`](../../packages/vat-development-agents/resources/skills/coherence-audit.md)
skill is the review method that surfaces these; [`traps.md`](traps.md) holds the individual
failures that looked like something else.
