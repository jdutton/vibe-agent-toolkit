/**
 * One writer and one drift check for every committed JSON Schema artifact.
 *
 * 🔑 **A generated artifact is a second consumer of every schema edit, and it
 * fails SILENTLY.** Three packages commit `schemas/*.json` rendered from Zod
 * by `generate:schemas`; `build` regenerates them, so a Zod edit that forgets
 * `git add` ships a stale artifact past every gate. `packages/schema` grew a
 * test that reads the committed file back and compares it to a fresh render;
 * this module is that test's mechanism made shared, so `agent-skills` and
 * `resources` — sixteen and four artifacts with no such test — get the same
 * one, and a package that adds a target cannot forget the check: the generator
 * and the drift test read the SAME target list.
 *
 * The comparison is on the rendered TEXT, not the parsed object: a hand edit
 * that reorders keys or reindents is drift too, because the next generator run
 * would rewrite it.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { isPathAbsentError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** One Zod schema and the `<name>.json` artifact rendered from it. */
export interface EmittedSchemaTarget {
  /** Basename of the emitted file, and the `definitions` key inside it. */
  readonly name: string;
  /** The Zod schema the artifact is generated from. */
  readonly schema: ZodTypeAny;
  /**
   * Applied to the rendered document before it is written. For constraints
   * Zod expresses that `zod-to-json-schema` cannot (a `.refine()`), so the
   * artifact carries them anyway.
   */
  readonly postProcess?: (document: Record<string, unknown>) => void;
}

/** Render one target exactly as the generator writes it. */
export function renderEmittedSchema(target: EmittedSchemaTarget): string {
  const document = zodToJsonSchema(target.schema, target.name) as Record<string, unknown>;
  target.postProcess?.(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Write every target into `outputDir`, creating it. */
export function writeEmittedSchemas(outputDir: string, targets: readonly EmittedSchemaTarget[]): string[] {
  mkdirSyncReal(outputDir, { recursive: true });
  const written: string[] = [];
  for (const target of targets) {
    const path = safePath.join(outputDir, `${target.name}.json`);
    writeFileSync(path, renderEmittedSchema(target));
    written.push(path);
  }
  return written;
}

/** One way a committed schema directory disagrees with its generator. */
export interface EmittedSchemaDrift {
  /** The artifact's basename. */
  readonly name: string;
  readonly kind: 'missing' | 'stale' | 'unlisted';
}

/**
 * Every disagreement between `outputDir` and `targets`.
 *
 * - `missing`: a target with no committed file (generated, never added).
 * - `stale`: a committed file whose text is not what the generator renders.
 * - `unlisted`: a committed `.json` no target produces (a target that was
 *   removed, whose artifact the build can no longer refresh).
 *
 * @param outputDir - The committed `schemas/` directory
 * @param targets - What the generator would write there
 * @returns Empty when the directory is exactly what the generator produces
 */
export function findEmittedSchemaDrift(outputDir: string, targets: readonly EmittedSchemaTarget[]): EmittedSchemaDrift[] {
  const drift: EmittedSchemaDrift[] = [];
  const expected = new Set(targets.map((target) => target.name));

  for (const target of targets) {
    const committed = readCommitted(safePath.join(outputDir, `${target.name}.json`));
    if (committed === undefined) drift.push({ name: target.name, kind: 'missing' });
    else if (committed !== renderEmittedSchema(target)) drift.push({ name: target.name, kind: 'stale' });
  }

  for (const file of listOrEmptyIfAbsent(outputDir)) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (!expected.has(name)) drift.push({ name, kind: 'unlisted' });
  }
  return drift;
}

/** The committed text, or `undefined` when there is no such file. A refusal throws. */
function readCommitted(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
}

/** The directory's entries, or none when it does not exist. A refusal throws. */
function listOrEmptyIfAbsent(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
}
