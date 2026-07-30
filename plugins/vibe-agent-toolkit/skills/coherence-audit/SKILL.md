---
name: coherence-audit
description: Use when auditing code for coherence rather than bugs — whether
  every lane implements one contract, whether a status or report tells the
  truth, whether a passing test suite is blind, or whether a vendor claim is
  stale.
---

# Coherence Audit

A bug review asks *"is this line correct?"* A coherence audit asks a different
question:

> **Is there ONE intended contract here, and does every lane implement the same one?**

That reframing is the whole method. A codebase can pass every test, ship no
crashes, and still be incoherent: two commands that disagree about the same
artifact, a field whose meaning depends on which producer wrote it, a status that
cannot express the answer it is being asked for. None of that shows up as a
failure, which is exactly why it survives.

Use this when reviewing a subsystem, before a release that consolidates behavior,
or when someone reports "the output is confusing" — which is usually a coherence
defect wearing a UX costume.

## The five questions

These do most of the damage. Ask each one of *every* lane, not of the code you
happen to be reading.

1. **Do two lanes agree about the artifact?** Specifically: is one looking at the
   SOURCE tree and the other at the BUILT/STAGED tree? Source ≠ dist wherever a
   build step rewrites, strips, or injects anything.
2. **What is this thing's NAME?** Ask it of every lane that names the thing.
   Directory basename, a frontmatter field, a config key, and a manifest entry are
   four different answers, and code that keys a map by the wrong one collides
   silently.
3. **Does anything VERIFY this claim, or only its SHAPE?** A schema that requires a
   `version` string does not check that the version is the one that shipped. A test
   asserting `status` is one of three strings does not check it is the right one.
4. **Does an internally-resolved distinction SURVIVE serialization?** Code often
   knows more than its output can say. Find the narrowing.
5. **Is this field's REFERENT unique within the document it appears in?** If two
   distinct things can produce the byte-identical value, every consumer that
   groups, counts, de-duplicates, or links by that field is silently wrong.

## The failure-direction tell

This is the highest-leverage idea here. When a rich type narrows to a poorer one,
the ambiguous case has to map somewhere — and it is almost always mapped to the
**reassuring** outcome:

| Rich answer | Narrowed to | Direction |
|---|---|---|
| info-severity findings | `success` | reassuring |
| warnings present | "All validations passed" | reassuring |
| could-not-determine | `passed: true` | reassuring |
| exit 2 (system error) | exit 1 (validation failure) | reassuring |
| "I did not look" | `[]` (looked, found nothing) | reassuring |

**That direction is why none of it is ever reported as a bug.** It produces
silence, never a false alarm — so no user ever files it, and no CI job ever goes
red. The alarming direction gets fixed the week it ships; the reassuring direction
lives forever.

**Search for it mechanically: find every place a rich type narrows to two or three
values.** Boolean returns, status enums, `X ? a : b` over a multi-valued input,
functions whose *signature* cannot see one of their inputs' dimensions. Then ask
where the unrepresentable case went.

The fix is rarely "make the status richer". Usually it is: keep the narrow status,
and **publish the distribution beside it** — so a consumer that disagrees with the
collapse can recompute it.

## The codebase tells on itself

The cheapest high-yield sweep available: **read doc comments and look for one that
states the correct rule directly above code implementing something weaker.**

Someone understood the contract well enough to write it down, then did not
implement it — or implemented it and a later change eroded it. Either way the
comment is a free oracle. Real examples of the shape:

- A helper documented "a caller with no root must decide one rather than silently
  falling back to an absolute path" — while three of its callers did exactly that.
- A field documented as "all emitted issues (errors + warnings)" that also carried
  a third severity nothing downstream rendered.
- A comment enumerating three ways to be exempt from a rule, above code
  implementing two.

Grep for the aspirational vocabulary: *must*, *never*, *always*, *exactly*, *only*,
*the single source of*.

## Bounding a class honestly

When you find one instance, you have found a class. Bound it and **report the size
as a number**, because "and similar issues elsewhere" is not actionable.

- **A keyword scan cannot define the population.** A regex tells you where to look;
  it does not tell you what is true. Hand-verify every row, and use the scan only
  to argue completeness. A scan-derived verdict is wrong often enough to be
  worthless — and a legitimate refactor can *delete* the keyword a scan keys on,
  silently shrinking the population to zero.
- **Report the real number.** "179 of 330 missing", not "some entries missing".
- **Say what you did not cover.** A bounded sweep with a stated boundary is
  evidence; an unbounded one is a vibe.

## Auditing the tests, not just the code

A green suite is not evidence of coherence. Three specific blindnesses:

- **A fixture that cannot distinguish the two answers.** Before hunting a "two
  lanes, one question" defect, check whether ANY fixture makes the right and wrong
  answers differ. If none does, the suite was never watching that axis, and adding
  the fixture is the fix.
- **A test helper that structurally cannot express the failing case.** A factory
  typed `status: 'error' | 'warning'` cannot build the info-only result whose
  rendering is broken. Widen the helper *forward*; a later reader who "repairs" the
  resulting red test by narrowing it back undoes the work.
- **An assertion over a named subset.** `expect(issues[0].code).toBe(...)` cannot
  catch a renderer that drops an entire severity class. Assert over EVERY item.

## Claims about the outside world

Any claim about someone else's software — another vendor's install paths, a CLI's
behavior on another OS, semantics read out of a binary, a number attributed to a
third party's guidance — has no test that can contradict it, and rots silently.

- **Check attribution.** "Based on <vendor> guidance" over a table of six numbers,
  four of which the team invented, is a false provenance claim. Say which are
  whose.
- **Verify before repeating.** Claims go stale in both directions: a "not available
  on macOS" caveat can become false when the tool ships.
- **Annotate what cannot be tested** with a greppable marker carrying the date it
  was last verified and the procedure to re-verify. Then a gate can surface it once
  the review window lapses. A refresh procedure that cites a deleted file is
  unfollowable — which is usually why the cache is overdue.

## Probing: read the output, not the exit code

- **Probe against inputs that PRODUCE findings.** A healthy tree emits nothing and
  proves nothing. Deliberately-broken fixtures are the instrument.
- **Read the OUTPUT.** An exit code is one bit; most defects here live in the other
  bits.
- **A suspiciously fast command usually never ran.** Check.
- **Verify a probe actually MUTATED the file** before believing it proved anything.
  A no-op edit yields a green run that looks like a passing test and is nothing.
- **Prove the fix backward.** Write the failing test first, watch it fail *for the
  right reason*, fix it, then revert the fix and confirm it goes red again. A test
  that passes both ways is not a test.

## Landing the findings

- **Fix forward, never backward.** When a corrected behavior turns a test red, the
  test was encoding the defect.
- **Ratchet, do not warn.** A warning on twenty existing sites is a warning everyone
  learns to scroll past. A ratchet lists the known-bad sites explicitly and asserts
  BOTH directions: a listed site that becomes conforming fails the build until its
  entry is removed, and a new site in no bucket fails until it is classified. The
  list can then only shrink.
- **Record why each exception is an exception.** "Why is this not in scope" is
  exactly the judgement a future reader needs and cannot reconstruct.
- **Name the failure direction in the commit message.** It is the part that
  explains why nobody noticed, and the part a reviewer most needs.
