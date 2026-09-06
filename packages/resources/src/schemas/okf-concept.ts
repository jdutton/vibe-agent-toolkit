/**
 * OKF (Open Knowledge Format) v0.2 concept-document frontmatter.
 *
 * ## Why this one is `.passthrough()` and not `.strict()`
 *
 * `.claude/rules/schema-strictness.md` splits schemas by direction: strict for
 * what VAT emits, liberal for what VAT reads. An adopter's bundle is read, and
 * OKF is explicit about the consequence — §4.1 says producers MAY include any
 * additional keys and consumers "MUST NOT reject documents with unrecognized
 * fields", and §11 repeats it for unknown `type` values and unknown keys. A
 * strict reader here would refuse documents the specification calls conformant.
 *
 * The same reasoning keeps `status` a free string. §5.4 names draft / stable /
 * deprecated, but §11 makes every constraint beyond its three numbered items
 * soft guidance, so a fourth value is a bundle VAT reports on, not one it
 * refuses to read.
 *
 * ## What it does close, and why that is not a contradiction
 *
 * Three things, each one the specification's own word:
 *
 * - `type` — "the only always-required key" (§4.1), and non-empty per §11.2.
 * - `sources[].resource` — "REQUIRED within an entry" (§5.1).
 * - `generated.by` — "REQUIRED within `generated`" (§5.2).
 *
 * Closing these is not strictness about *unknown* keys; it is describing the
 * shape of the keys the spec does define. A bundle that violates one is
 * malformed by OKF's own text, not merely unfamiliar.
 *
 * ## §10 (Attested Computation) is deliberately not modelled
 *
 * `runtime`, `parameters`, `executor` and `attester` reach this schema through
 * passthrough. They apply to one `type` value out of an open set, their inner
 * shapes are the part of the spec most likely to move (§12's "considered and
 * deferred" list is almost entirely about them), and nothing in VAT reads them.
 * Modelling them would be describing a moving target for no reader.
 */

import { z } from 'zod';

/**
 * An ISO 8601 instant as it actually arrives from a YAML parse.
 *
 * 🪤 The YAML schema in force decides the JavaScript type: YAML 1.2 core (the
 * `yaml` package's default, and so VAT's) leaves `2026-09-23T00:00:00Z` a
 * string, while YAML 1.1 and an explicit `!!timestamp` tag produce a `Date`.
 * That is the producer's choice, and a reader that accepted only one of them
 * would refuse a bundle over its author's parser settings.
 */
const OkfDatetimeSchema = z.union([z.string(), z.date()])
  .describe('ISO 8601 datetime with an explicit UTC offset — a string, or a Date when the producer\'s YAML schema decoded one');

/**
 * An actor: `<producer>/<version>`, `human:<id>`, or `process:<id>` (§7).
 *
 * Modelled as a plain non-empty string rather than a discriminated pattern. The
 * three forms are a convention the spec states for consumers that classify
 * trust, and the only mechanical consequence it draws from them is the
 * `human:` prefix test (§5.3) — which is a read, not a validation.
 */
const OkfActorSchema = z.string().min(1)
  .describe('Actor (§7): `<producer>/<version>`, `human:<id>`, or `process:<id>`');

/** A `{ from, to }` window framing every `usage_count` beneath it (§5.1). */
const OkfUsageWindowSchema = z.object({
  from: OkfDatetimeSchema.optional().describe('Start of the usage window'),
  to: OkfDatetimeSchema.optional().describe('End of the usage window'),
}).passthrough().describe('Datetime range framing the usage_count values (§5.1)');

/** One entry in `sources`: a material the concept derives from (§5.1). */
export const OkfSourceSchema = z.object({
  resource: z.string().min(1)
    .describe('REQUIRED (§5.1). A followable artifact — URL, bundle-relative path, references/ path — or a scope descriptor such as "all queries in BigQuery project X"'),
  id: z.string().optional()
    .describe('Stable key used as a markdown footnote label to attribute individual claims'),
  title: z.string().optional().describe('Human-readable label for the source'),
  author: OkfActorSchema.optional().describe('Credibility signal: who or what produced the source'),
  usage_count: z.number().optional()
    .describe('Credibility signal: how often the resource was exercised over usage_window. Liveness and trend, never a score'),
  last_modified: OkfDatetimeSchema.optional()
    .describe('Credibility signal: when the source itself last changed (distinct from generated.at)'),
  usage_window: OkfUsageWindowSchema.optional()
    .describe('Per-entry override of the sibling-level usage_window'),
}).passthrough().describe('One provenance source (§5.1)');

export type OkfSource = z.infer<typeof OkfSourceSchema>;

/** How the current content was produced (§5.2). */
const OkfGeneratedSchema = z.object({
  by: OkfActorSchema.describe('REQUIRED within generated (§5.2)'),
  at: OkfDatetimeSchema.optional().describe('When the content last meaningfully changed'),
}).passthrough().describe('Production record (§5.2)');

/** One verification event (§5.2). */
const OkfVerificationSchema = z.object({
  by: OkfActorSchema.describe('Who or what confirmed the content'),
  at: OkfDatetimeSchema.optional().describe('When the verification happened'),
}).passthrough().describe('One verification event (§5.2)');

/**
 * OKF v0.2 concept-document frontmatter.
 *
 * Every non-reserved `.md` file beneath a bundle root carries one of these
 * (§3.1, §11.1). See the module docstring for why it is permissive.
 */
export const OkfConceptFrontmatterSchema = z.object({
  // 🪤 `.regex(/\S/)` rather than `.trim().min(1)`. Both refuse a whitespace-only
  // value in Zod, but `.trim()` is a TRANSFORM: it vanishes from the generated
  // JSON Schema, leaving the committed `.json` sibling — the artifact an adopter
  // actually points a `frontmatterSchema` at — accepting `type: "   "` while the
  // TypeScript reader refuses it. A pattern survives the conversion, so both
  // faces of this schema answer §11.2 the same way.
  type: z.string().min(1).regex(/\S/, 'type must contain a non-whitespace character')
    .describe('REQUIRED (§4.1). A short, self-explanatory kind — "BigQuery Table", "Playbook", "Metric". NOT centrally registered: an unknown value is legal and consumers must tolerate it'),

  title: z.string().optional().describe('Recommended. Human-readable display name'),
  description: z.string().optional().describe('Recommended. One sentence summarizing the concept'),
  resource: z.string().optional()
    .describe('Recommended. URI uniquely identifying the underlying asset; absent for abstract concepts'),
  tags: z.array(z.string()).optional().describe('Recommended. Short strings for cross-cutting categorization'),

  sources: z.array(OkfSourceSchema).optional().describe('Provenance: the materials this concept derives from (§5.1)'),
  usage_window: OkfUsageWindowSchema.optional()
    .describe('Datetime range framing every usage_count in sources (§5.1)'),

  generated: OkfGeneratedSchema.optional().describe('Trust: how the current content was produced (§5.2)'),
  verified: z.union([OkfVerificationSchema, z.array(OkfVerificationSchema)]).optional()
    .describe('Trust: verification events. A bare mapping MUST be read as a one-element list (§5.2)'),

  status: z.string().optional()
    .describe('Lifecycle (§5.4). Conventionally draft | stable | deprecated; absent means stable. Left open because §11 makes values beyond those three soft guidance'),
  stale_after: OkfDatetimeSchema.optional()
    .describe('Lifecycle (§5.5). An absolute instant: the concept is stale when now >= stale_after'),
}).passthrough().describe('OKF v0.2 concept-document frontmatter — permissive by specification (§4.1, §11)');

export type OkfConceptFrontmatter = z.infer<typeof OkfConceptFrontmatterSchema>;
