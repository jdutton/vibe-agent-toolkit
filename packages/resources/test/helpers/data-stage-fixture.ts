/**
 * The data stage over an in-memory fixture: one root (`/repo`, `root-1`; a second, `/repo2`,
 * `root-2`, when a realization names it), one extent per root, the given
 * realizations, an in-memory reader, the real extractor in-thread, store off unless a store is given.
 * What the stage's tests and the declared-reads handle's tests share.
 */

import { readWorkCounters, type FsFaultClass } from '@vibe-agent-toolkit/utils';

import { keyContent, type ContentKey, type KeyedContent, type ParserKind } from '../../src/content-key.js';
import { ParseLimitError, resolveDataOutputCaps } from '../../src/parse-limits.js';
import { extractDataRows } from '../../src/projection/data-extractor.js';
import {
  NO_DATA_STAGE_SEAMS,
  runDataStage,
  type DataDemand,
  type DataStageResult,
  type DataStageSeams,
} from '../../src/projection/data-stage.js';
import { dataRoutingFor } from '../../src/projection/router.js';
import type { FactStore } from '../../src/projection/store.js';
import { runStoredReads } from '../../src/projection/stored-reads.js';
import type { DataVariant } from '../../src/schemas/projection-data.js';
import type { ContentState } from '../../src/schemas/projection-resources.js';

/** The stage's inputs, as `runDataStage` takes them. */
type DataStageInput = Parameters<typeof runDataStage>[0];

/** The projection slice the stage routes from. */
type DataStageProjection = DataStageInput['projection'];

/** The stage's content reader. */
type DataStageContent = DataStageInput['content'];

export const ROOT = '/repo';
export const EVERYTHING: DataDemand = { tables: ['dataFiles', 'dataDocuments', 'dataNodes', 'dataConditions'], routes: true, values: true, workspace: false };

/** One realization the fixture projection holds. */
export interface Realized {
  /** The root it is under: `root-1` (`/repo`) unless it says `root-2` (`/repo2`). */
  readonly root?: 'root-2';
  readonly path: string;
  readonly state?: ContentState;
  /** The text on disk; absent for a file the reader finds gone. */
  readonly text?: string;
  /** The key the population recorded, when it differs from the text's own. */
  readonly recorded?: ContentKey;
  /** The errno every read of the path rejects with, as the OS would raise it. */
  readonly fault?: string;
  /** The fault class the population recorded for an `unreadable` state; `absent` when not given. */
  readonly faultClass?: FsFaultClass;
}

/** The fixture's root paths, by id. */
const ROOT_PATHS = { 'root-1': ROOT, 'root-2': `${ROOT}2` } as const;

/** @returns The absolute path of a realization */
function absoluteOf(file: Realized): string {
  return `${ROOT_PATHS[file.root ?? 'root-1']}/${file.path}`;
}

/** The fixture projection: `root-1` (and `root-2` when a realization names it), one extent each, the given realizations. */
export function projectionOf(files: readonly Realized[]): DataStageProjection {
  const ids = files.some((file) => file.root === 'root-2') ? (['root-1', 'root-2'] as const) : (['root-1'] as const);
  return {
    roots: ids.map((id) => ({ id, path: ROOT_PATHS[id] })),
    resolutionContexts: ids.map((id, index) => ({ contextId: `extent-${String(index + 1)}`, species: 'extent', kind: 'tree', rootId: id, extentContextId: null, role: 'primary' })),
    resourceRealizations: files.map((file) => {
      const state = file.state ?? 'keyed';
      const keyed = state === 'keyed' ? file.recorded ?? keyContent(file.text ?? '', 'none').key : null;
      const contentFaultClass = state === 'unreadable' ? file.faultClass ?? 'absent' : null;
      return { extentId: file.root === 'root-2' ? 'extent-2' : 'extent-1', path: file.path, contentState: state, contentKey: keyed, contentFaultClass, mime: 'application/json' };
    }),
  } as unknown as DataStageProjection;
}

/** A reader over the fixture's files, counting reads per path. */
export function contentOf(files: readonly Realized[], reads: Map<string, number> = new Map()): DataStageContent {
  const byPath = new Map(files.map((file) => [absoluteOf(file), file]));
  const read = (absolutePath: string, parserKind: ParserKind): KeyedContent | null => {
    reads.set(absolutePath, (reads.get(absolutePath) ?? 0) + 1);
    const file = byPath.get(absolutePath);
    if (file?.fault !== undefined) throw Object.assign(new Error(`${file.fault}: open '${absolutePath}'`), { code: file.fault, syscall: 'open', path: absolutePath });
    return file?.text === undefined ? null : keyContent(file.text, parserKind);
  };
  return {
    read: ({ absolutePath }) => settled(() => read(absolutePath, 'none')),
    readUnkeyed: (absolutePath, parserKind) => settled(() => {
      const keyed = read(absolutePath, parserKind);
      if (keyed === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return keyed;
    }),
  };
}

/** `work`'s value as a promise, its throw as the rejection: how an async read fails. */
function settled<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The real extractor in-thread, throwing a limit as the pool does; `fail` replaces it for one variant's paths. */
export function extractorOf(fail?: (variant: DataVariant, input: KeyedContent) => Error | undefined): DataStageInput['extractor'] {
  return {
    dataRows: (variant, input) => {
      const failure = fail?.(variant, input as KeyedContent);
      if (failure !== undefined) return Promise.reject(failure);
      const caps = resolveDataOutputCaps(undefined);
      const extraction = extractDataRows({ text: input.content, variant, bom: input.decoding.encodingSource === 'bom' }, caps);
      if (extraction.outcome === 'breach') return Promise.reject(new ParseLimitError(extraction.limit, caps[extraction.limit], extraction.found));
      return Promise.resolve(extraction);
    },
  };
}

/** What {@link stage} takes beside the files. */
export interface StageOptions {
  readonly demand?: DataDemand;
  readonly store?: FactStore;
  readonly reads?: ReturnType<typeof runStoredReads>;
  readonly extractor?: DataStageInput['extractor'];
  readonly seams?: DataStageSeams;
  readonly routing?: DataStageInput['routing'];
  /** Counts the stage's own reads, per absolute path. */
  readonly contentReads?: Map<string, number>;
  /** A root's repository top level; none (null) unless given. */
  readonly repositoryTop?: (rootPath: string) => string | null;
  /** The most bytes of extracted rows the stage holds at once; its default unless given. */
  readonly rowBytesHeld?: number;
}

/** The stage's inputs over `files`. */
export function stageInput(files: readonly Realized[], options: StageOptions): DataStageInput {
  const { store } = options;
  return {
    demand: options.demand ?? EVERYTHING,
    projection: projectionOf(files),
    routing: options.routing ?? dataRoutingFor(undefined),
    content: contentOf(files, options.contentReads),
    extractor: options.extractor ?? extractorOf(),
    store: store === undefined ? undefined : { store, reads: (options.reads ?? runStoredReads()).of(store) },
    seams: options.seams ?? NO_DATA_STAGE_SEAMS,
    repositoryTop: options.repositoryTop ?? (() => null),
    ...(options.rowBytesHeld === undefined ? {} : { rowBytesHeld: options.rowBytesHeld }),
  };
}

/** Run the stage over `files`, store off unless a store is given. */
export function stage(files: readonly Realized[], options: StageOptions = {}): Promise<DataStageResult> {
  return runDataStage(stageInput(files, options));
}

/** The staged answer, failing on examined-nothing. */
export function staged(result: DataStageResult): Extract<DataStageResult, { outcome: 'staged' }> {
  if (result.outcome !== 'staged') throw new Error(`expected a staged answer, got ${JSON.stringify(result)}`);
  return result;
}

/** The counters a call moved. */
export async function countersMovedBy(work: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = readWorkCounters();
  await work();
  const after = readWorkCounters();
  return Object.fromEntries(Object.entries(after).filter(([name]) => name.startsWith('rowSet.')).map(([name, value]) => [name, value - (before[name as keyof typeof before] ?? 0)]));
}
