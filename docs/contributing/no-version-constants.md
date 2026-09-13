# No version constants — rationale and the replacement table

The rule is in the root [`CLAUDE.md`](../../CLAUDE.md#no-version-constants--the-npm-package-version-is-the-only-version):
the npm package version is the only version this project has, and no hand-maintained number decides
whether stored data is still valid. This page holds the reasoning and the mechanisms that replace
the integer, so the rule can stay one paragraph.

## Why it is a hard rule and not a preference

A version integer is tech debt with no guard on it. The number and the shape it claims to describe
drift apart silently, because nothing fails when you forget to bump — the failure surfaces later as a
reader confidently mis-parsing data it should have refused, or refusing data it should have read. It
buys nothing that deriving does not buy automatically, and it costs a permanent human obligation
that is discharged from memory. When the constants were expelled from this repo, every one of them
turned out to be answering a question a `.strict()` Zod schema already answered, and answering it
worse: an integer only refuses when a human remembered to move it, and one seam shipped two meaning
changes ahead of its bump before anyone noticed.

This extends to version **labels** in VAT's own output: no `schema:` / `vat.*/v1alpha` discriminator
for a consumer to read. Under pre-1.0 the package version is the only contract.

## Three questions the integer conflated, and what answers each now

| The real question | What answers it |
|---|---|
| *Can I read this stored artifact?* | The reader's own **strict schema**. It moves when the shape moves, for whoever made the edit. |
| *Did these two artifacts come from the same shape?* | Both sides validated against **this build's** schema — stronger than comparing them to each other, which a matched pair of pre-change artifacts passes. |
| *Can this build see the work at all?* | The artifact **declares its own capabilities** — `CrawlTimingDump.charges` is the worked example, and the shape a meaning-only change should take. |

## Do this instead

- **Derive it from the shape itself** — a digest of the schema's own declaration, as
  `parseFactsShapeSource()` does for the parse cache and `parseTimingShapeSource()` does for the
  timing dumps. Adding, renaming or reordering a field moves the digest with zero human action;
  rewording prose does not move it.
- **Or invalidate explicitly** — delete the stored data when it stops being valid.
- **Or ask a different question.** Most "version" checks conflate *"can I parse this?"* (a schema
  validation already answers that) with *"did these two things come from the same shape?"* (a carried
  digest answers that, and neither side has to know the right value). Separate the two and the
  version usually disappears.

## The one thing no schema catches

A field whose **meaning** moves while its name and type stay put. No version integer caught that
either — it had to be *told*. When it happens, make the build declare what moved (row 3 above) or
invalidate explicitly by deleting the stored artifacts. There is a live instance documented at
`readIoBody` in `packages/lab/src/facets/io/compare.ts`; read it before proposing anything.

## Not offenders

`ANTHROPIC_VERSION` (an external API header value), `SUPPORTED_PYTHON_VERSIONS` (a real list),
regexes that *parse* versions, and `const VERSION = '…'` in test fixtures. The ban is on a number
**deciding whether stored data is still valid** — not on the word. Vendoring an upstream artifact
under `docs/external/` and recording "fetched on `<date>`; upstream declares `<version>`" is an
external fact, not a validity decision.

## The config file's `version:` key

`vibe-agent-toolkit.config.yaml` used to open with `version: 1`, checked by a `z.literal(1)` — the
exact shape this rule bans, and the last one the tree carried. The key is now **accepted and
ignored** (`version: z.unknown().optional()`): the strict schema decides whether a config can be
read, and no integer in the file gets a vote. A config still carrying `version: 1` loads
unchanged; a new config need not carry the key at all. Nothing reads it.

## Enforcement

`local/no-version-literal` (`packages/utils/eslint/rules/no-version-literal.cjs`) flags
`z.literal(<number>)` on a `version`-named property and `const <X>_VERSION = <number>` /
`<X>_REVISION` / `CACHE_VERSION` declarations; its allowlist option names the non-offenders above.
Any PR that introduces a new one must call it out under its own heading so it is removed before
merge — a version constant that arrives un-announced in a diff is a defect regardless of how good the
rest of the change is.
