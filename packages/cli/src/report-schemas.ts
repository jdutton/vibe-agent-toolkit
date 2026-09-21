/**
 * Every structured document a `vat` command publishes, and what shape it has.
 *
 * 🔑 **Zero committed schemas described any CLI output document** — 31 schema
 * artifacts shipped and none was a report — so an adopter's `jq` recipe, CI
 * adapter or SARIF exporter was written against an example in a doc, or
 * against a run. This registry is the one list; `scripts/generate-json-schemas.ts`
 * writes `schemas/<name>.json` from it, `test/report-schemas.test.ts` pins the
 * emitted files against a fresh render and walks the Commander tree to prove
 * every command that offers `--format json` (or `--yaml`) is listed here.
 *
 * ## Three kinds of entry, and the ratchet between them
 *
 * - `report` — the document IS the shared envelope (`Report<T>` from
 *   `@vibe-agent-toolkit/schema`): `status`, a REQUIRED `examined`,
 *   `findings`, `summary`, `data`. The schema is emitted and pinned.
 * - `external` — the document's shape is owned by someone else (an Anthropic
 *   Admin API object passed through, a specification's own artifact). Never
 *   renamed to the envelope; listed so the walk knows it was considered.
 * - `legacy` — a VAT-owned shape not yet migrated to the envelope. Each carries
 *   the reason. ⛔ **This list may only SHRINK.** An entry leaves when its
 *   command publishes the envelope (and gains a `report` entry with a schema);
 *   a new command is never added here — it publishes the envelope from day one.
 */

import type { ZodTypeAny } from 'zod';

import { ARD_EMIT_REPORT_SCHEMA } from './commands/ard/emit.js';
import { OKF_VALIDATE_REPORT_SCHEMA } from './commands/okf/validate.js';
import { CHECK_REPORT_SCHEMA } from './commands/resources/check.js';
import { SKILL_REVIEW_REPORT_SCHEMA } from './commands/skill/review.js';

/** A command whose structured document is the shared envelope, with its emitted schema. */
export interface ReportEntry {
  readonly kind: 'report';
  /** The command as typed after `vat`, e.g. `okf validate`. */
  readonly command: string;
  /** Basename of `schemas/<name>.json`. */
  readonly name: string;
  readonly schema: ZodTypeAny;
}

/** A command whose document shape belongs to someone else, or has not been migrated yet. */
export interface UnmigratedEntry {
  readonly kind: 'external' | 'legacy';
  /** The command as typed after `vat`; a trailing ` *` covers a whole group. */
  readonly command: string;
  /** Who owns the shape, or what the migration is waiting on. */
  readonly reason: string;
}

export type ReportSchemaEntry = ReportEntry | UnmigratedEntry;

export const REPORT_SCHEMAS: readonly ReportSchemaEntry[] = [
  { kind: 'report', command: 'okf validate', name: 'okf-validate', schema: OKF_VALIDATE_REPORT_SCHEMA },
  { kind: 'report', command: 'skill review', name: 'skill-review', schema: SKILL_REVIEW_REPORT_SCHEMA },
  { kind: 'report', command: 'resources check', name: 'resources-check', schema: CHECK_REPORT_SCHEMA },
  { kind: 'report', command: 'ard emit', name: 'ard-emit', schema: ARD_EMIT_REPORT_SCHEMA },

  {
    kind: 'external',
    command: 'claude org *',
    reason: 'Anthropic Admin API objects passed through as the API returns them (`has_more`, `data[]`, snake_case). Renaming them would make VAT a second schema for a document Anthropic owns.',
  },
  {
    kind: 'external',
    command: 'inventory',
    reason: 'The structural inventory `@vibe-agent-toolkit/agent-skills` serializes (`serializeInventory`) — a description of a plugin, marketplace, skill or install root, not a run over one. It carries no findings and no denominator to publish.',
  },

  {
    kind: 'legacy',
    command: 'resources validate',
    reason: 'The lab measures this document (`filesScanned`, per-file rows) through `packages/lab` and the qa-snapshot harness; the instrument and the subject move together, and the lab is outside this migration.',
  },
  {
    kind: 'legacy',
    command: 'resources scan',
    reason: 'A population listing (which files, which collections), not findings; the envelope fits once `data` carries the listing and `examined` the file count — a small migration, not yet made.',
  },
  {
    kind: 'legacy',
    command: 'resources query',
    reason: 'SQL rows the operator selected — the shape is the query\'s, and a `findings` list over arbitrary rows would be a fiction.',
  },
  {
    kind: 'legacy',
    command: 'claude context',
    reason: 'Two document kinds (`answer` / `unknown`) plus the `--all` cost map, each a query answer with conditions per path; the severity vocabulary is now the shared one, the envelope migration is a design change for the query lane.',
  },
  {
    kind: 'legacy',
    command: 'audit',
    reason: 'The largest document in the CLI, consumed by the corpus runner, the lab and fifteen integration tests; its walker was under concurrent edit when the envelope landed.',
  },
  {
    kind: 'legacy',
    command: 'skills validate',
    reason: 'Publishes per-skill COUNT rows by design (a clean skill is omitted; `skillsValidated` is the denominator) — a flat `findings` list is a design change for the maintainer, not a rename.',
  },
  {
    kind: 'legacy',
    command: 'validate',
    reason: 'A phase orchestrator over `phase-utils`; its document nests each phase\'s own, so it migrates after every phase does.',
  },
  {
    kind: 'legacy',
    command: 'verify',
    reason: 'The second phase orchestrator over `phase-utils` (it publishes no `issueCounts` at all); migrates with `validate`.',
  },
  {
    kind: 'legacy',
    command: 'audit settings',
    reason: 'Publishes `SettingsFinding[]` under `findings` with `path`; the envelope fits once `path` becomes `location`.',
  },
  {
    kind: 'legacy',
    command: 'claude marketplace validate',
    reason: 'A `vat verify` phase and a standalone command sharing one document; migrates with the orchestrators.',
  },
  {
    kind: 'legacy',
    command: 'agent validate',
    reason: 'Publishes the agent-config validator\'s result verbatim; the envelope fits once `examined` is the manifest count.',
  },
];
