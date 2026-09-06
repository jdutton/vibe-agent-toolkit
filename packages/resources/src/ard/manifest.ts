/**
 * The ARD manifest document — `{"@context": ..., "entries": [...]}` — and
 * writing it to disk.
 *
 * There is no registry and no upload: a publisher hosts the document itself,
 * conventionally at `/.well-known/ard.json`, and registries crawl it. That is
 * structurally the same shape as `vat claude marketplace publish` — emit an
 * artifact, host it yourself.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ArdManifestSchema, type ArdEntry, type ArdManifest } from './entry-schema.js';

/**
 * The ARD JSON-LD context URI.
 *
 * An external identifier published by the specification — the same category as
 * an API version header, and **not** a version constant VAT maintains. Nothing
 * in VAT compares it to anything or decides validity from it; it is copied into
 * the emitted document verbatim so a crawler can resolve the vocabulary.
 */
export const ARD_CONTEXT_URI = 'https://agenticresourcediscovery.org/context/v1';

/** The path a publisher conventionally serves the manifest from. */
export const ARD_WELL_KNOWN_PATH = '/.well-known/ard.json';

/**
 * Assemble the manifest.
 *
 * Validated on the way out for the same reason each entry is: this is VAT's own
 * output, so a shape it cannot parse is a bug to surface here rather than a
 * malformed document to discover from a crawler's silence.
 */
export function buildArdManifest(entries: readonly ArdEntry[]): ArdManifest {
  return ArdManifestSchema.parse({
    '@context': ARD_CONTEXT_URI,
    entries: [...entries],
  });
}

/**
 * Write the manifest as pretty-printed JSON, creating parent directories.
 *
 * Pretty-printed on purpose: the document is a published artifact an adopter
 * commits and reviews in a diff, and a single-line JSON blob makes every change
 * to it a whole-file change.
 */
export async function writeArdManifest(
  manifest: ArdManifest,
  outputPath: string
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is the caller's declared destination; this function's whole purpose is to write there
  await mkdir(dirname(outputPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is the caller's declared destination; this function's whole purpose is to write there
  await writeFile(outputPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf-8');
}
