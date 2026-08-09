/**
 * The run harness's contracts — how a vat is named, how a project is named, and
 * what one invocation produced.
 *
 * Kept separate from the implementations so every facet depends on the shape
 * rather than on how an instrument happens to be resolved today.
 */

import type { InstrumentVersion, SubjectRef, SubjectVersion } from '../envelope/coordinate.js';

/**
 * How the caller named a vat to measure.
 *
 * Three sources, one resolved result. `tree` is the dev-build case and the
 * reason {@link InstrumentVersion} carries a commit at all; `npx` is the
 * released case, where there is no commit to record and the coordinate says
 * `null` rather than guessing.
 */
export type InstrumentSource =
  | {
      /** A checkout: use its built `dist/bin/vat.js`, read version and commit from it. */
      readonly kind: 'tree';
      readonly path: string;
    }
  | {
      /** A built artifact directly, for comparing builds without two checkouts. */
      readonly kind: 'dist';
      readonly path: string;
    }
  | {
      /** A published version, run via `npx <spec>`. */
      readonly kind: 'npx';
      readonly spec: string;
    };

/** A vat that can be run, and the coordinate axis it stamps. */
export interface ResolvedInstrument {
  /** Executable to spawn. */
  readonly command: string;
  /** Arguments that precede the vat subcommand (a script path, or npx's spec). */
  readonly leadingArgs: readonly string[];
  /** Axis C, as it will appear in every report this instrument produces. */
  readonly version: InstrumentVersion;
}

/** How the caller named a project to measure. */
export interface SubjectSource {
  /** Stable id for this subject within a run or registry. */
  readonly id: string;
  /** A local filesystem path. Git URLs resolve to one of these before this point. */
  readonly path: string;
}

/** A project that can be measured, and the two coordinate axes it stamps. */
export interface ResolvedSubject {
  /** Absolute path to measure. */
  readonly path: string;
  /** Axis A. */
  readonly ref: SubjectRef;
  /** Axis B — a resolved commit, or a content fingerprint when there is no git. */
  readonly version: SubjectVersion;
}

/** One invocation of a vat command. */
export interface RunResult {
  /** Wall-clock duration in milliseconds. */
  readonly wallMs: number;
  /**
   * Process exit code, or `null` when the process never ran or was killed.
   *
   * A run that did not exit cleanly has **no meaningful duration** — timing a
   * crash measures how fast vat fails, not how fast it works. Callers must
   * check this before letting a sample into a statistic.
   */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the spawn itself failed (ENOENT, timeout kill, E2BIG). */
  readonly spawnError: string | null;
}

/** Options for one invocation. */
export interface RunOptions {
  /** Working directory for the child. */
  readonly cwd: string;
  /**
   * Extra environment for the child, merged over `process.env`.
   *
   * **Merged, never replaced.** The I/O facet works by `NODE_OPTIONS=--require`
   * and vat's own launcher spawns a second node process for the real binary; a
   * harness that replaced `env` wholesale would strip the preload and silently
   * measure the launcher alone.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the child is killed. */
  readonly timeoutMs?: number;
}
