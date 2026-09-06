/**
 * The shape of an ARD entry VAT **emits**.
 *
 * ## Why Zod, when upstream ships a JSON Schema
 *
 * VAT has to *construct* entries, not merely check them. A JSON Schema yields
 * no typed builder and no TypeScript types, so a build path driven by it is a
 * pile of `unknown` casts with the validation bolted on afterwards. The
 * vendored `docs/external/ard/ard-entry.schema.json` stays the **authority** —
 * the test suite validates emitted instances against it with Ajv — while this
 * schema is what the emitter is written against.
 *
 * ⛔ Nothing here is diffed against the vendored document. JSON Schema
 * subsumption is not decidable in general, and a generated schema differs from
 * a hand-written one in `$defs` layout and `allOf` nesting in ways that carry
 * no meaning. Instances are compared to the authority instead.
 *
 * ## Why `.strict()`
 *
 * Upstream's `EntryFields` sets `additionalProperties: true` deliberately, so
 * that `@context`-declared namespace terms are legal members. That permissive
 * reading is right for a *consumer*. VAT is the *producer*: an unknown key in
 * an entry VAT built is VAT's bug, and the strictness rule
 * (`.claude/rules/schema-strictness.md`) puts our own output on the strict
 * side. Reading someone else's ARD document would be the passthrough case —
 * and VAT does not do that at all. **Emit, never depend.**
 *
 * ## Emit, never depend
 *
 * ARD is v0.91, status **Proposal** (as fetched 2026-09-06 — an external fact,
 * recorded, never a constant that decides validity). Nothing in VAT reads an
 * ARD entry back, and no VAT behaviour is derived from one.
 */

import { z } from 'zod';

/** Charset for the `<publisher>` segment. */
export const ARD_PUBLISHER_SEGMENT_PATTERN = /^[a-zA-Z0-9.-]+$/;

/** Charset for the `<namespace>` and `<name>` segments. */
export const ARD_NAME_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** The URN prefix every ARD identifier carries. */
const ARD_URN_PREFIX = 'urn:air:';

/**
 * The `identifier` pattern as upstream writes it, kept as **text**.
 *
 * Held as a string rather than a `RegExp` on purpose. Upstream's form nests a
 * quantifier — `(:[a-zA-Z0-9._-]+)+` — which is star-height 2 and therefore
 * refused by `security/detect-unsafe-regex` on sight. In this instance the
 * nesting is *not* ambiguous (the inner class excludes `:`, so each repetition
 * has exactly one way to start) and the pattern is linear — but a linter that
 * scores star height cannot see that, and arguing with it by rewriting the
 * regex into a shape that satisfies the score without changing the language is
 * the trap this repo has already walked into twice. So the grammar is checked
 * by {@link isArdIdentifier} instead, which is linear by construction, and the
 * upstream source stays here verbatim for the refresh diff and for error
 * messages.
 */
export const ARD_IDENTIFIER_PATTERN_SOURCE = '^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$';

/**
 * Whether a string is a well-formed ARD identifier.
 *
 * Shape: `urn:air:<publisher>:<namespace>:<name>`. The grammar requires only
 * *at least one* segment after the publisher, so a two-segment URN is
 * structurally valid; VAT always emits the three-segment form.
 */
export function isArdIdentifier(value: string): boolean {
  if (!value.startsWith(ARD_URN_PREFIX)) return false;
  const [publisher, ...rest] = value.slice(ARD_URN_PREFIX.length).split(':');
  if (publisher === undefined || !ARD_PUBLISHER_SEGMENT_PATTERN.test(publisher)) return false;
  if (rest.length === 0) return false;
  return rest.every((segment) => ARD_NAME_SEGMENT_PATTERN.test(segment));
}

/**
 * `metadata` values, which upstream constrains to scalars — not arbitrary
 * objects. A nested object here is a silent conformance failure, so the union
 * is spelled out rather than left as `unknown`.
 */
export const ArdMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * The trust manifest VAT emits.
 *
 * 🚨 **Casing.** Upstream's JSON Schema declares this member as
 * `TrustManifest` (PascalCase); the specification prose spells it
 * `trustManifest` in all 11 of its occurrences and `TrustManifest` in zero. VAT
 * follows the **prose**, because that is what the specification defines and
 * what a consumer implementing the spec will read.
 *
 * ⚠️ The consequence is that an emitted `trustManifest` reaches the vendored
 * schema only through `EntryFields.additionalProperties: true`. None of
 * `TrustManifest`'s own constraints — the required `identity`, the shapes of
 * `attestations` and `provenance` — are ever applied to it. **A passing
 * validation is therefore not evidence that VAT's trust manifest is
 * well-formed.** This Zod schema is the only thing checking it. See
 * `docs/external/ard/README.md`, which also records how to re-check on refresh.
 *
 * Only the two members VAT can actually derive are modelled. `attestations`,
 * `provenance`, `trustSchema` and `signature` are defined by whichever trust
 * framework a publisher adopts, and VAT does not have one.
 */
export const ArdTrustManifestSchema = z
  .object({
    identity: z
      .string()
      .min(1)
      .describe('Cryptographic workload identifier (SPIFFE ID, DID, or HTTPS FQDN URI)'),
    identityType: z
      .string()
      .min(1)
      .optional()
      .describe('Hint for the identity format (e.g. "spiffe", "did", "https")'),
  })
  .strict();

export type ArdTrustManifest = z.infer<typeof ArdTrustManifestSchema>;

const ArdEntryFieldsSchema = z
  .object({
    '@context': z
      .string()
      .url()
      .optional()
      .describe('Optional per-entry JSON-LD context. OPTIONAL per §4.1; VAT carries it on the manifest instead.'),
    identifier: z
      .string()
      .refine(isArdIdentifier, {
        message: `identifier must match ${ARD_IDENTIFIER_PATTERN_SOURCE}`,
      })
      .describe('Domain-anchored URN: urn:air:<publisher>:<namespace>:<name>'),
    displayName: z.string().min(1).describe('Human-readable name'),
    type: z.string().min(1).describe('Artifact type as an IANA media type'),
    url: z.string().url().optional().describe('Reference to the full artifact document. Mutually exclusive with `data`.'),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('The complete artifact document, inline. Mutually exclusive with `url`.'),
    description: z.string().optional().describe('Short natural-language description'),
    tags: z.array(z.string()).optional().describe('Keywords for filtering and faceting'),
    capabilities: z.array(z.string()).optional().describe('Short skill or tool tokens'),
    representativeQueries: z
      .array(z.string())
      .optional()
      .describe('AUTHORED sample queries. VAT never generates these — a wrong one is worse than a missing one.'),
    version: z.string().optional().describe('Version of the artifact'),
    updatedAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('ISO 8601 timestamp of the last modification'),
    metadata: z
      .record(z.string(), ArdMetadataValueSchema)
      .optional()
      .describe('Custom scalar key-value pairs, available as metadata.* filter keys'),
    trustManifest: ArdTrustManifestSchema.optional().describe(
      'Trust identity, emitted under the spec-prose spelling (see the schema docstring)'
    ),
  })
  .strict();

/**
 * A complete ARD entry as VAT emits it.
 *
 * The `url` XOR `data` rule is a refinement rather than a required field,
 * mirroring upstream, where it is expressed as a `oneOf` beside — not inside —
 * `required: ["identifier","displayName","type"]`.
 */
export const ArdEntrySchema = ArdEntryFieldsSchema.refine(
  (entry) => (entry.url === undefined) !== (entry.data === undefined),
  { message: 'An ARD entry carries exactly one of `url` or `data`' }
);

export type ArdEntry = z.infer<typeof ArdEntrySchema>;

/**
 * The document published at `/.well-known/ard.json`.
 *
 * Upstream requires only `entries` and leaves the top level open. VAT always
 * carries `@context`, because a manifest that declares its vocabulary once is
 * strictly more useful to a crawler than one that does not, and §4.1 makes the
 * per-entry copy optional precisely so it can live here.
 */
export const ArdManifestSchema = z
  .object({
    '@context': z.string().url().describe('The ARD JSON-LD context URI'),
    entries: z.array(ArdEntrySchema).describe('Every resource this publisher advertises'),
  })
  .strict();

export type ArdManifest = z.infer<typeof ArdManifestSchema>;
