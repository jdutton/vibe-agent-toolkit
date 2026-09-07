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

/**
 * The two segments a URL resolver reads as an INSTRUCTION rather than a name.
 *
 * Kept beside the charset they are carved out of, because the charset is where
 * a reader looks to learn what a segment may be.
 */
const URL_DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * Whether a string may be a `<namespace>` or `<name>` segment VAT emits.
 *
 * 🚨 {@link ARD_NAME_SEGMENT_PATTERN} is a *charset*, and a charset admits `.`
 * and `..`. Those are not names — collapsing them is a URL resolver's DEFINING
 * behaviour — so `ard.namespace: ".."` under `baseUrl:
 * https://example.com/tenants/acme/catalog` emitted
 * `https://example.com/tenants/acme/<name>`: one level above where the
 * identifier says the resource lives, and plausible enough that nothing
 * downstream reports it. A skill NAMED `.` addressed the namespace directory
 * rather than the skill.
 *
 * Only the two dot segments are refused. A segment that merely CONTAINS dots
 * (`v1.2`, `.hidden`) is the ordinary shape of a versioned or dotted name and
 * survives resolution untouched, so banning the character would be a fix wider
 * than the fault.
 */
export function isArdNameSegment(value: string): boolean {
  return ARD_NAME_SEGMENT_PATTERN.test(value) && !URL_DOT_SEGMENTS.has(value);
}

/**
 * Whether a relative path may be appended to `ard.baseUrl`.
 *
 * 🚨 `ArdSurface.urlPath` is documented as "path appended to `ard.baseUrl`", and
 * `buildArdEntry` is exported from this package. An absolute URL handed to it
 * resolved to ITSELF, producing an entry whose `identifier` is anchored at the
 * publisher while its `url` points at another origin — which defeats the
 * publisher-authority binding the trust manifest exists to carry. Dot segments
 * walk out of the base's path, and `%2e%2e` decodes during resolution, so the
 * encoded form has to be judged on its decoded value.
 *
 * Not reachable from `vat ard emit` today — `urlPathFor` composes segments this
 * module has already constrained — so this is the API contract, checked where
 * the path is actually consumed rather than trusted from a comment.
 */
export function isArdUrlPath(value: string): boolean {
  // A scheme, or a protocol-relative prefix, both relocate the entry: `//host/x`
  // keeps only the base's protocol, and a scheme keeps nothing at all.
  if (SCHEME_PREFIX_PATTERN.test(value)) return false;
  if (value.startsWith('//')) return false;
  return !hasDotSegment(value);
}

/**
 * Whether any `/`-delimited segment of a URL path is `.` or `..`.
 *
 * Walked by index rather than `split('/')`: this is a URL path, not a file path,
 * and the repo's `local/no-hardcoded-path-split` rule refuses the split outright
 * — correctly, since the two are separated only by convention at a call site.
 * The walk is linear and reads the same.
 */
function hasDotSegment(path: string): boolean {
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index < path.length && path[index] !== '/') continue;
    if (URL_DOT_SEGMENTS.has(decodePathSegment(path.slice(start, index)))) return true;
    start = index + 1;
  }
  return false;
}

/**
 * A single path segment's decoded value, or the segment itself when the escape
 * is malformed.
 *
 * A malformed escape is not a dot segment, and it is not this predicate's job to
 * refuse it — `new URL` preserves it verbatim.
 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A URI scheme at the start of a string, per RFC 3986 §3.1.
 *
 * One quantifier over one character class: linear, and no star height for a
 * linter to score (the trap {@link ARD_IDENTIFIER_PATTERN_SOURCE} documents).
 */
const SCHEME_PREFIX_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

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
 * Whether a `<publisher>` segment is the DOMAIN the config's own error message
 * insists on.
 *
 * 🚨 {@link ARD_PUBLISHER_SEGMENT_PATTERN} is a *charset*, and a charset admits
 * a single label. `publisher: com` therefore passed, and it is not a harmless
 * oddity: publisher-authority binding is the one security-relevant check in
 * this lane, and it is satisfied by "the identity's host equals the publisher
 * or is a subdomain of it". With `com` as the publisher, `https://
 * totally-unrelated.com/w` binds — every `.com` on the internet is a subdomain
 * of `com`. Requiring a dot with non-empty labels on both sides is what makes
 * the binding mean anything.
 *
 * Written as a split rather than a regex on purpose: the natural form,
 * `[a-z0-9-]+(\.[a-z0-9-]+)+`, is star-height 2 and scores as super-linear
 * even though the inner class excludes `.` and it is linear in fact. This
 * module already refuses to argue with that scoring once (see
 * {@link ARD_IDENTIFIER_PATTERN_SOURCE}); index arithmetic settles it again.
 */
export function isArdPublisherDomain(value: string): boolean {
  if (!ARD_PUBLISHER_SEGMENT_PATTERN.test(value)) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

/** The one identity form whose authority VAT deliberately does not parse. */
const ARD_DID_IDENTITY_PREFIX = 'did:';

/**
 * Whether `trustManifest.identity` carries an authority VAT can bind to the
 * publisher — the check ARD mandates and the only security-relevant one in this
 * lane.
 *
 * 🚨 This exists so the CONFIG and the EMITTER cannot disagree. The emitter
 * refused a scheme-less identity while `ArdTrustManifestConfigSchema` accepted
 * any `z.string().min(1)`, so the refusal landed at emission for the one field
 * where landing late matters most, while `publisher`, `baseUrl` and `namespace`
 * are all refused at load. `isArdPublisherDomain` is shared by both gates for
 * exactly this reason; so is this.
 *
 * The rule is stated POSITIVELY, because its negative form is what failed: the
 * DID exemption read as "no `://`, no authority to parse", and a bare
 * `attacker.com` has no `://` either — so it slipped past the binding entirely.
 * Two ways past: the authority is IN the URI, or the identity is a DID and the
 * deferral is deliberate. A scheme-less string is neither, and guessing which
 * URI the author meant is the guess this lane refuses.
 */
export function isArdBindableIdentity(value: string): boolean {
  if (value.toLowerCase().startsWith(ARD_DID_IDENTITY_PREFIX)) return true;
  // Same `://` split the emitter's authority parse uses: a scheme, then a
  // non-empty authority before any `/`, `?` or `#`.
  const marker = value.indexOf('://');
  if (marker <= 0) return false;
  const rest = value.slice(marker + '://'.length);
  const end = rest.search(/[/?#]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return authority.slice(authority.lastIndexOf('@') + 1) !== '';
}

/**
 * Whether a value can serve as the BASE that entry `url`s resolve against.
 *
 * 🚨 `z.string().url()` answers "is this a URL", which is a different question.
 * It admits `mailto:ops@example.com`, and it admits a base carrying a query or
 * a fragment — and a base's query and fragment do not survive relative
 * resolution, so every entry in a manifest built on one would resolve to the
 * same address. Those are not wrong-but-well-formed paths (the ruled-out
 * baseUrl-doubling case is that); they address nothing and are mutually
 * indistinguishable, which is the failure mode a discovery document must not
 * have.
 *
 * Checked with the URL parser rather than a pattern: the parser is the thing
 * that will do the resolving, so asking it is the only check that cannot
 * disagree with the outcome.
 */
export function isArdBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return parsed.search === '' && parsed.hash === '';
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
    // `.min(1)` for the same reason `displayName` and `type` carry it: an empty
    // string is not a shorter version, it is a field asserting a version that
    // does not exist. A `package.json` carrying `"version": ""` reached this
    // schema and emitted `"version": ""` at exit 0.
    version: z.string().min(1).optional().describe('Version of the artifact'),
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
