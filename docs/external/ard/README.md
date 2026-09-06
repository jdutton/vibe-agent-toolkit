# ARD (Agentic Resource Discovery) — vendored upstream schema

> **Source:** <https://raw.githubusercontent.com/ards-project/ard-spec/main/spec/schemas/ard-entry.schema.json>
> **Spec:** <https://github.com/ards-project/ard-spec> · rendered at <https://agenticresourcediscovery.org/spec/>
> **Fetched:** 2026-09-06 (8,373 bytes)
> **Spec declares:** v0.91, status **Proposal**, dated 2026-08-26
> **License:** Apache-2.0 — © the ARD project / Linux Foundation working group. Reproduced verbatim.
>
> @vendor-claim reviewed=2026-09-06 verify=Re-fetch the Source URL and diff it against `ard-entry.schema.json` byte for byte. The `$id` is a `main`-branch URL on a Proposal-status spec, so it moves with no signal and no version in the path. Check specifically whether `EntryFields.properties.TrustManifest` has been corrected to `trustManifest` (see Divergences below) — that is the one difference VAT's emitter works around.
>
> **Refresh policy:** re-fetch when ARD publishes a version past v0.91, or every ~90 days,
> whichever is sooner. `docs/external/` normally caches prose; this directory caches a machine
> artifact, so the diff is mechanical — a byte diff of the JSON, not a reading.

## Why this file is vendored and not fetched

The schema self-identifies as:

```
$id: https://raw.githubusercontent.com/ards-project/ard-spec/main/spec/schemas/ard-entry.schema.json
```

That is a **`main`-branch URL** — unpinned, on a spec whose own status is *Proposal*. It will move,
and nothing will signal that it has. So the `$id` is useful for *identifying which schema this is*
and worthless as a live contract. VAT vendors it and **never fetches at runtime**.

⛔ There is deliberately **no version constant** anywhere in the code that reads this file. Recording
*"fetched from `<url>` on `<date>`; the spec declares v0.91"* is an external fact, the same category
as an API version header. An `ARD_SCHEMA_VERSION` integer someone must remember to bump is the thing
[CLAUDE.md](../../../CLAUDE.md) forbids outright.

## How VAT uses it

As an **oracle, not a source**. VAT constructs entries through a Zod schema (it must *build* entries,
not merely check them, and JSON Schema yields no typed builder), then validates the emitted JSON
against this vendored document with Ajv in the test suite.

VAT does **not** diff its Zod schema against this one. JSON Schema subsumption is not decidable in
general, and generated output differs from a hand-written document in `$defs` layout and `allOf`
nesting in ways that mean nothing — such a check would alarm on style and stay silent on substance.
Comparing *instances* against the authority is the stronger test.

Ajv is reached through the shared `createAjvWithUriFormats` factory exported from
`@vibe-agent-toolkit/resources`, which is exactly the case
[`.claude/rules/schema-strictness.md`](../../../.claude/rules/schema-strictness.md) reserves it for:
an externally-authored JSON Schema validated against data. VAT does not hand-write JSON Schema for
anything Zod already models, and this file is not authored by VAT at all.

## What was read from this schema, so a reader is not negotiating against a summary

Verified by parsing the file on 2026-09-06, not by reading prose about it:

- `$defs.ArdEntry.required` is **`["identifier", "displayName", "type"]`** — three fields. `url` XOR
  `data` is expressed separately as a `oneOf`, and is **not** a fourth required field.
- `identifier` carries a pattern: `^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$`.
- `EntryFields.additionalProperties` is **`true`, deliberately** — the schema's own `$comment` says
  constraining it "would defeat the namespace extension mechanism", since `@context`-declared terms
  (e.g. `okf:taxonomy`) are valid entry members.
- `representativeQueries` has **no** presence or count constraint in the schema. Its description
  says so explicitly: absence, or a count outside 2–5, is flagged by the conformance tester as a
  **warning** (§D.2), so an entry emitted without them still validates.
- `ArdManifest` requires only `entries`; `@context` is **not** required at the manifest level, and
  §4.1 confirms carrying `@context` in an entry is OPTIONAL.
- `metadata` values are constrained to `string | number | boolean | null` — not arbitrary objects.
- `TrustManifest.required` is `["identity"]`; everything else, `trustSchema` included, is
  `additionalProperties: true` by design.

## 🚨 Divergences between this schema and the spec prose

**`TrustManifest` vs `trustManifest` — a casing mismatch, upstream.** The schema declares the entry
member as `EntryFields.properties.TrustManifest` (PascalCase). The specification prose spells it
`trustManifest` (camelCase) in **all 11** of its occurrences in `spec/ard.md`; `TrustManifest`
appears in the prose **zero** times.

Consequence, and why it matters to VAT: because `EntryFields.additionalProperties` is `true`, an
entry emitting the spec-correct `trustManifest` **validates** against this schema — but it validates
as an *unknown extension term*, so none of `TrustManifest`'s own constraints (the required
`identity`, the shapes of `attestations` and `provenance`) are ever applied to it. A validator that
passes here is therefore not evidence that a trust manifest is well-formed.

VAT follows the **prose**, emitting `trustManifest`, because that is what the specification defines
and what a consumer implementing the spec will read. The test suite asserts this explicitly rather
than letting the permissive branch hide it. Re-check on every refresh: if upstream corrects the
casing, VAT's emitted entries start being genuinely validated and the workaround note can go.
