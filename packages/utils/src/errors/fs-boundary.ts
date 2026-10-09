/**
 * `fsBoundary`: decide a fault's side from the path the OS named, against the
 * roots each side owns. Built on the classifier (`fs-fault.ts`) and on
 * `path-containment.ts`; it lives apart from the classifier so that the path
 * helpers `path-containment.ts` itself imports can classify without a cycle.
 */

import { canonicalPath, isUnderRoot } from '../path-containment.js';

import { fsFaultOf } from './errno-table.js';
import { classifyFsFault, FS_SIDES, type FsSide, type SourceOrigin } from './fs-fault.js';

/** The directories each side owns for one verb. */
export interface FsRoots {
  readonly source?: readonly string[];
  readonly destination?: readonly string[];
  readonly environment?: readonly string[];
}

/** Decides the side of a fault from the path the OS named. */
export interface FsBoundary {
  /** The side owning `path` (the most specific root wins), or `undefined` when it is under no root. */
  sideOf(path: string): FsSide | undefined;
  /** Classify an error already caught: by the path it names, else on `fallback`; a non-fs error comes back untouched. */
  classify(error: unknown, action: string, fallback: FsSide): unknown;
  run<T>(action: string, fallback: FsSide, work: () => Promise<T>): Promise<T>;
  runSync<T>(action: string, fallback: FsSide, work: () => T): T;
}

/**
 * Whether `candidate` is `root` itself or under it. `isUnderRoot` answers `outside`
 * for the root itself (it needs a strict `root/` prefix), but a fault ON the root
 * (`mkdir(outRoot)`, `stat(sourceRoot)`, creating the staging dir) is the commonest
 * kind there is. A root the OS refuses to examine owns nothing; any other failure
 * is a defect and propagates.
 */
function containedBy(root: string, candidate: string): boolean {
  try {
    return canonicalPath(root) === canonicalPath(candidate) || isUnderRoot(root, candidate) !== 'outside';
  } catch (error: unknown) {
    if (fsFaultOf(error) !== undefined) return false;
    throw error;
  }
}

/**
 * Role by PATH, not by wrapper. A wrapper names the side its author had in mind;
 * the path the OS named is what actually failed, and one call routinely touches
 * both an input and an output (a `copyFile` whose source is unreadable fails
 * under the SOURCE root even though the wrapper says "write"). Falls back to the
 * call's declared side only when the error names no path or the path is under no
 * root.
 */
export function fsBoundary(roots: FsRoots, options: { origin?: SourceOrigin; shapeFromSource?: boolean } = {}): FsBoundary {
  const declared = FS_SIDES.flatMap((side) => (roots[side] ?? []).map((root) => ({ side, root })));

  function sideOf(path: string): FsSide | undefined {
    let best: { side: FsSide; root: string } | undefined;
    for (const entry of declared) {
      const longer = best === undefined || entry.root.length > best.root.length;
      if (longer && containedBy(entry.root, path)) best = entry;
    }
    return best?.side;
  }

  function sideOfError(error: unknown): FsSide | undefined {
    const facts = fsFaultOf(error);
    if (facts === undefined) return undefined;
    const named = [facts.path, facts.dest].filter((p): p is string => p !== undefined);
    for (const path of named) {
      const side = sideOf(path);
      if (side !== undefined) return side;
    }
    return undefined;
  }

  /** The side the error's path names; a defect while examining a root is thrown with the fault it was classifying, so neither is lost. */
  function sideOfFault(error: unknown): FsSide | undefined {
    try {
      return sideOfError(error);
    } catch (defect: unknown) {
      throw new AggregateError([defect, error], 'Could not classify a filesystem fault: examining a root failed');
    }
  }

  function classify(error: unknown, action: string, fallback: FsSide): unknown {
    return classifyFsFault(error, {
      side: sideOfFault(error) ?? fallback,
      action,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.shapeFromSource === undefined ? {} : { shapeFromSource: options.shapeFromSource }),
    });
  }

  return {
    sideOf,
    classify,
    async run<T>(action: string, fallback: FsSide, work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } catch (error: unknown) {
        throw classify(error, action, fallback);
      }
    },
    runSync<T>(action: string, fallback: FsSide, work: () => T): T {
      try {
        return work();
      } catch (error: unknown) {
        throw classify(error, action, fallback);
      }
    },
  };
}
