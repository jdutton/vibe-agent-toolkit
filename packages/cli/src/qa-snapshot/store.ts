/**
 * The QA snapshot's on-disk layout — write one, read one back.
 *
 * ```
 * <dir>/manifest.json
 * <dir>/oracle/enumeration.<laneId>.txt
 * <dir>/oracle/parse-facts.txt
 * <dir>/command/<name>.stdout.txt
 * <dir>/command/<name>.stderr.txt
 * ```
 *
 * Two rules here are about the failure modes of a *comparison*, not about
 * tidiness, and both are load-bearing:
 *
 * - **A stale artifact must not survive a re-capture.** A snapshot directory is
 *   replaced wholesale rather than merged into, because an artifact left behind
 *   by a previous capture — a lane captured last time and not this one — reads
 *   to a later `compare` as *unchanged*, which is the one answer it must never
 *   invent.
 * - **A named-but-missing artifact is an error, never an empty string.** An
 *   empty artifact compares as a total deletion and presents as a catastrophic
 *   regression; refusing to load is the only reading that cannot mislead.
 *
 * Artifacts are UTF-8 with LF endings on disk and are LF-normalized on read, so
 * a capture taken on macOS is comparable against a Windows checkout.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import {
  COMMAND_DIR,
  MANIFEST_FILENAME,
  ORACLE_DIR,
  SNAPSHOT_FORMAT_VERSION,
  type LoadedSnapshot,
  type SnapshotManifest,
} from './types.js';

/** The three fixed locations inside a snapshot directory. */
export interface SnapshotPaths {
  /** Absolute path to `manifest.json`. */
  manifest: string;
  /** Absolute path to the oracle-artifact subdirectory. */
  oracleDir: string;
  /** Absolute path to the whole-command-artifact subdirectory. */
  commandDir: string;
}

/**
 * Resolve the fixed locations inside a snapshot directory.
 *
 * @param dir - Snapshot directory, absolute or relative to the cwd
 * @returns Absolute, forward-slashed paths for the manifest and both subdirectories
 */
export function snapshotPaths(dir: string): SnapshotPaths {
  const root = safePath.resolve(dir);
  return {
    manifest: safePath.join(root, MANIFEST_FILENAME),
    oracleDir: safePath.join(root, ORACLE_DIR),
    commandDir: safePath.join(root, COMMAND_DIR),
  };
}

/**
 * Write a snapshot directory: the manifest plus every artifact it carries.
 *
 * Creates the directory when it does not exist, and **replaces** it when it is
 * already a snapshot — see the module comment for why a merge is not an option.
 * Refuses to touch a non-empty directory that is not a snapshot, because
 * overwriting an arbitrary path a user typed is not recoverable.
 *
 * @param dir - Snapshot directory to write
 * @param manifest - Provenance and per-artifact bookkeeping for this capture
 * @param artifacts - Artifact relative path (forward-slashed) → text
 * @returns Nothing
 * @throws {Error} When `dir` is non-empty and holds no `manifest.json`
 */
export function writeSnapshot(
  dir: string,
  manifest: SnapshotManifest,
  artifacts: Map<string, string>,
): void {
  const root = safePath.resolve(dir);
  const paths = snapshotPaths(root);

  assertWritableSnapshotDir(root, paths.manifest);

  // Wholesale replacement, not a merge: an artifact from a previous capture
  // that this one does not produce would otherwise read as "unchanged".
  for (const subdir of [paths.oracleDir, paths.commandDir]) {
    rmSync(subdir, { recursive: true, force: true });
  }
  mkdirSyncReal(paths.oracleDir, { recursive: true });
  mkdirSyncReal(paths.commandDir, { recursive: true });

  for (const [name, text] of artifacts) {
    // joinUnderRoot, not join: an artifact name is manifest data, and a `..`
    // inside one must not be able to write outside the snapshot directory.
    const file = safePath.joinUnderRoot(root, name);
    mkdirSyncReal(dirname(file), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is contained under root by joinUnderRoot
    writeFileSync(file, toLf(text), 'utf8');
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename under the snapshot root
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Load a snapshot directory: its manifest and every artifact the manifest names.
 *
 * @param dir - Snapshot directory to read
 * @returns The manifest plus artifact text, LF-normalized
 * @throws {Error} When the directory is not a snapshot, the manifest is
 *   unreadable or of an unsupported `formatVersion`, or a named artifact is
 *   missing from disk
 */
export function readSnapshot(dir: string): LoadedSnapshot {
  const root = safePath.resolve(dir);
  const manifest = readManifest(root, snapshotPaths(root).manifest);

  const artifacts = new Map<string, string>();
  for (const name of manifestArtifactNames(manifest)) {
    artifacts.set(name, readArtifact(root, name));
  }

  return { dir: root, manifest, artifacts };
}

/**
 * Refuse to write into a directory that exists, holds files, and is not a
 * snapshot.
 *
 * @param root - Absolute snapshot directory
 * @param manifestPath - Absolute path its manifest would occupy
 * @returns Nothing; returns normally when writing is safe
 * @throws {Error} When the directory is non-empty and holds no manifest
 */
function assertWritableSnapshotDir(root: string, manifestPath: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller-supplied snapshot directory; its existence is the question being asked
  if (!existsSync(root)) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename under the snapshot root
  if (existsSync(manifestPath)) return;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller-supplied snapshot directory, already known to exist
  const entries = readdirSync(root);
  if (entries.length === 0) return;

  throw new Error(
    `Refusing to write a snapshot into ${root}: it is not empty and contains no ${MANIFEST_FILENAME}, ` +
      `so it is not a snapshot directory and writing here would destroy whatever is in it.\n` +
      `  It holds ${String(entries.length)} entries, including: ${entries.slice(0, 3).join(', ')}\n` +
      `  Pass an empty directory, a previous snapshot directory, or a path that does not exist yet.`,
  );
}

/**
 * Read and version-check the manifest.
 *
 * @param root - Absolute snapshot directory, for error messages
 * @param manifestPath - Absolute path to `manifest.json`
 * @returns The manifest
 * @throws {Error} When it is absent, unparseable, or of another format version
 */
function readManifest(root: string, manifestPath: string): SnapshotManifest {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename under the caller-supplied snapshot root
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Not a snapshot directory: ${root}\n` +
        `  Expected ${MANIFEST_FILENAME} at its top level. Capture one with 'vat pipeline snapshot <corpus> --out ${root}'.`,
    );
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename under the caller-supplied snapshot root
  const raw = readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unreadable snapshot manifest at ${manifestPath}: ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Unreadable snapshot manifest at ${manifestPath}: expected a JSON object.`);
  }

  const found = (parsed as { formatVersion?: unknown }).formatVersion;
  if (found !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported snapshot formatVersion ${describeVersion(found)} at ${root}; ` +
        `this build reads formatVersion ${String(SNAPSHOT_FORMAT_VERSION)}.\n` +
        `  Comparing across format versions is refused rather than guessed — the failure mode of guessing is a confidently wrong "nothing changed".`,
    );
  }

  return parsed as SnapshotManifest;
}

/**
 * Render whatever a manifest carried in `formatVersion` for an error message.
 *
 * @param value - The parsed value, of any shape
 * @returns A short, printable description
 */
function describeVersion(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

/**
 * Every artifact path the manifest names, in a stable order.
 *
 * @param manifest - The loaded manifest
 * @returns Artifact relative paths: lanes, then parse facts, then commands
 */
function manifestArtifactNames(manifest: SnapshotManifest): string[] {
  const names: string[] = [];

  for (const lane of Array.isArray(manifest.lanes) ? manifest.lanes : []) {
    names.push(lane.artifact);
  }
  if (typeof manifest.parseFactArtifact === 'string') {
    names.push(manifest.parseFactArtifact);
  }
  for (const command of Array.isArray(manifest.commands) ? manifest.commands : []) {
    names.push(command.stdoutArtifact, command.stderrArtifact);
  }

  return names;
}

/**
 * Read one artifact, refusing to substitute an empty string for a missing file.
 *
 * @param root - Absolute snapshot directory
 * @param name - Artifact path relative to it, forward-slashed
 * @returns The artifact text, LF-normalized
 * @throws {Error} When the manifest names a file that is not on disk
 */
function readArtifact(root: string, name: string): string {
  const file = safePath.joinUnderRoot(root, name);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is contained under root by joinUnderRoot
  if (!existsSync(file)) {
    throw new Error(
      `Snapshot at ${root} names an artifact that is not on disk: ${name}\n` +
        `  Reading it as an empty string would compare as a wholesale deletion and present as a catastrophic regression, so the load is refused. Re-capture the snapshot.`,
    );
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is contained under root by joinUnderRoot and was just confirmed to exist
  return toLf(readFileSync(file, 'utf8'));
}

/**
 * Normalize CRLF to LF so a Windows checkout compares against a macOS capture.
 *
 * @param text - Artifact text as written or as read
 * @returns The same text with LF endings
 */
function toLf(text: string): string {
  return text.replaceAll('\r\n', '\n');
}
