/**
 * Reading a directory of per-process JSON dumps, for any facet whose
 * measurement is written from *inside* the measured process.
 *
 * Two facets work this way and more will: `io` injects a counter through
 * `NODE_OPTIONS` and `parse` switches on a timing seam compiled into vat. What
 * they measure could not be more different, and yet every property that makes
 * the reading trustworthy is identical between them:
 *
 * 1. **Every dump in the directory is read, not the first one.** A single vat
 *    invocation spawns more than one process, so a reader that took one file
 *    would report a fraction of the run and look entirely healthy doing it —
 *    the most expensive shape of wrong answer either facet can give, because
 *    nothing in the output says it is partial.
 * 2. **An empty directory is a REFUSAL, never a zero.** No dump means nothing
 *    measured — the instrument was not injected, or this build of vat has no
 *    seam at all. "Zero calls" and "zero milliseconds" are both perfectly
 *    plausible-looking lies that a reader has no way to catch.
 * 3. **A dump this build does not model is refused, never coerced.** A producer
 *    that wrote a shape this build cannot read has measured something this build
 *    cannot state. The facet's strict schema is the whole of that judgement —
 *    see {@link DumpKind.schema} for why there is no version integer beside it.
 * 4. **A fresh directory per repeat, removed however the repeat ends.** Nothing
 *    downstream can tell a leftover dump from an earlier repeat apart from a
 *    descendant process of this one — both are files with distinct PIDs — so a
 *    reused directory silently inflates every number. {@link withDumpDirs}
 *    makes freshness a property of construction rather than of remembering to
 *    delete first.
 *
 * What stays in each facet: the dump's shape, what merging its rows means, and
 * how to phrase the consequence of an empty directory in its own terms.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import type { z } from 'zod';

/** Extension a dump is written with. Anything else in the directory is ignored. */
const DUMP_EXTENSION = '.json';

/** Why a directory of dumps could not be read. */
export interface DumpsRefusal {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/**
 * Build a refusal.
 *
 * @param message - What went wrong, without the prefix
 * @returns The refusal
 */
export function refuseDumps(message: string): DumpsRefusal {
  return { ok: false, refusal: `REFUSED: ${message}` };
}

/**
 * Render an unknown error as text.
 *
 * @param error - Whatever was thrown
 * @returns Its message
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render a schema failure as one line a reader can act on.
 *
 * Every issue, not the first: a strict schema rejecting three fields should
 * name three fields, or the reader fixes one and runs the whole capture again.
 *
 * @param error - The rejection
 * @returns `field: why; field: why`
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * The least a facet's schema has to expose to be read here.
 *
 * Structural rather than `z.ZodType<TDump>`: a schema carrying a `.refine()` is
 * a `ZodEffects`, its inferred output has mutable arrays where a facet's own
 * interface has readonly ones, and pinning the full Zod type would make every
 * such schema fail to fit for reasons that have nothing to do with reading a
 * dump.
 */
export interface DumpParser<TDump> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: TDump }
    | { readonly success: false; readonly error: z.ZodError };
}

/** Everything a facet has to say about its own dumps for them to be read. */
export interface DumpKind<TDump> {
  /**
   * Singular noun for one dump, as it appears in every refusal — `I/O dump`,
   * `parse-timing dump`. It is what tells a reader which instrument failed.
   */
  readonly noun: string;
  /** What wrote the dump, named in the version refusal so the remedy is concrete. */
  readonly producer: string;
  /**
   * The shape this build reads, and the ONLY thing that decides whether a dump
   * may be read.
   *
   * ⚠️ **It must be `.strict()`, and there must be no version field beside it.**
   * A hand-bumped `dumpVersion` used to sit here, and it could only ever refuse
   * what this schema refuses anyway — a layout the reader does not model — while
   * costing a human obligation nothing enforced. Worse, it silently *stopped*
   * refusing whenever someone forgot: the crawl seam shipped two meaning changes
   * before anyone bumped it. A strict schema moves the instant a field is added,
   * renamed or retyped, and it moves for whoever made the edit rather than for
   * whoever remembered.
   *
   * What a schema cannot see is a field whose MEANING moved while its name and
   * type stayed put. Nothing mechanical can, an integer least of all. The remedy
   * there is to invalidate explicitly — delete the stored dumps and reports —
   * or, better, to make the build DECLARE the thing that moved, as
   * `CrawlTimingDump.charges` does.
   */
  readonly schema: DumpParser<TDump>;
  /**
   * What an empty directory means, in this facet's own terms.
   *
   * Owned by the facet because the *consequence* differs: for `io` the lie
   * would be "vat touched nothing", for `parse` it would be "parsing was free".
   * A shared sentence would have to say neither.
   */
  readonly emptyDirectory: (directory: string) => string;
}

/** Every dump in one directory, read and validated. */
export interface DumpFilesAccepted<TDump> {
  readonly ok: true;
  readonly dumps: readonly TDump[];
}

/** The outcome of reading a directory of dumps. */
export type DumpFilesResult<TDump> = DumpFilesAccepted<TDump> | DumpsRefusal;

/**
 * Read and validate one dump file.
 *
 * @param filePath - Path to a dump
 * @param kind - See {@link DumpKind}
 * @returns The dump, or a refusal naming the file and what was wrong with it
 */
async function readOneDump<TDump>(
  filePath: string,
  kind: DumpKind<TDump>,
): Promise<{ readonly ok: true; readonly dump: TDump } | DumpsRefusal> {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dump directory chosen by the capture that wrote it
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    return refuseDumps(`could not read ${kind.noun} '${filePath}': ${messageOf(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return refuseDumps(`${kind.noun} '${filePath}' is not valid JSON: ${messageOf(error)}`);
  }

  const parsed = kind.schema.safeParse(value);
  if (!parsed.success) {
    // The producer is named because the commonest cause is not a corrupt file:
    // it is a dump written by a DIFFERENT build of the seam, which is exactly
    // what an A/B against an older baseline hands you. "Re-capture with a
    // matching <producer>" is the remedy; the issue list says what moved.
    return refuseDumps(
      `${kind.noun} '${filePath}' is not the shape this build reads — ` +
        `${describeIssues(parsed.error)}. Re-capture with a matching ${kind.producer}; ` +
        'reading rows whose layout has moved would produce numbers nobody can state.',
    );
  }
  return { ok: true, dump: parsed.data };
}

/**
 * Read every dump in a directory.
 *
 * **The directory must hold exactly one command run's dumps** — see rule 4 in
 * this module's header, and {@link withDumpDirs}, which is how a capture keeps
 * that true.
 *
 * @param directory - Where the instrument wrote its dumps
 * @param kind - See {@link DumpKind}
 * @returns Every dump, in a deterministic order, or the first refusal
 */
export async function readDumpFiles<TDump>(
  directory: string,
  kind: DumpKind<TDump>,
): Promise<DumpFilesResult<TDump>> {
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dump directory chosen by the capture that wrote it
    entries = await readdir(directory);
  } catch (error) {
    return refuseDumps(
      `could not read the ${kind.noun} directory '${directory}': ${messageOf(error)}`,
    );
  }

  // Sorted so a directory with two broken dumps refuses the same way twice.
  const files = entries
    .filter((name) => name.endsWith(DUMP_EXTENSION))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return refuseDumps(kind.emptyDirectory(directory));

  const results = await Promise.all(
    files.map((name) => readOneDump(safePath.join(directory, name), kind)),
  );
  const dumps: TDump[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    dumps.push(result.dump);
  }
  return { ok: true, dumps };
}

/**
 * Run one command's repeats against one fresh dump directory each, and clean
 * them up however the run ends.
 *
 * `mkdtemp` per repeat rather than one directory emptied between them: emptying
 * is a step that can fail, be skipped, or race a descendant process that has not
 * exited yet, and every one of those failures adds a previous repeat's numbers
 * to the next one's without adding anything that says so.
 *
 * @param runs - How many repeats will run; one directory each
 * @param prefix - Temp-directory prefix, so a stray directory names its facet
 * @param body - What to do with the directories, given in repeat order
 * @returns Whatever `body` returned
 */
export async function withDumpDirs<T>(
  runs: number,
  prefix: string,
  body: (directories: readonly string[]) => Promise<T>,
): Promise<T> {
  const template = safePath.join(normalizedTmpdir(), prefix);
  const directories = await Promise.all(
    Array.from({ length: Math.max(0, runs) }, () => mkdtemp(template)),
  );
  try {
    return await body(directories);
  } finally {
    // Every path here was created by `mkdtemp` above, so none of it is caller-supplied.
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}
