/**
 * Unit tests for the QA snapshot's on-disk layout.
 *
 * Scope is `store.ts` only. `capture.ts` spawns processes and crawls a corpus,
 * which belongs in an integration test — a unit test that did it would be slow
 * and would fail for reasons that have nothing to do with the layout.
 *
 * The cases below are the ones where a *wrong* answer is worse than an error:
 * a stale artifact surviving a re-capture reads as "unchanged", a missing one
 * read as an empty string reads as a wholesale deletion, and a CRLF checkout
 * would diff against a macOS capture on every line.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readSnapshot, snapshotPaths, writeSnapshot } from '../../src/qa-snapshot/store.js';
import {
  MANIFEST_FILENAME,
  type CommandManifestEntry,
  type LaneManifestEntry,
  type SnapshotManifest,
} from '../../src/qa-snapshot/types.js';

const RESOURCES_ARTIFACT = 'oracle/enumeration.resources.txt';
const AUDIT_ARTIFACT = 'oracle/enumeration.audit.txt';
const PARSE_FACT_ARTIFACT = 'oracle/parse-facts.txt';
const STDOUT_ARTIFACT = 'command/audit.stdout.txt';
const STDERR_ARTIFACT = 'command/audit.stderr.txt';

const RESOURCES_TEXT = '# enumeration-snapshot\nlane: resources\n';
const AUDIT_TEXT = '# enumeration-snapshot\nlane: audit\n';
const PARSE_FACT_TEXT = '# parse-fact-snapshot\nblobCount: 3\n';
const STDOUT_TEXT = 'status: success\n';
const STRAY_TEXT = 'a file the user cares about\n';

const suite = setupSyncTempDirSuite('vat-qa-snapshot-store');

/**
 * A fresh, not-yet-created snapshot directory inside this test's temp dir.
 *
 * @returns An absolute path that does not exist yet
 */
function snapshotDir(): string {
  return safePath.join(suite.getTempDir(), 'snap');
}

/**
 * Absolute path of one artifact inside a snapshot directory.
 *
 * @param dir - The snapshot directory
 * @param name - Artifact path relative to it
 * @returns The absolute path
 */
function artifactPath(dir: string, name: string): string {
  return safePath.join(safePath.resolve(dir), name);
}

/**
 * A minimal lane manifest entry.
 *
 * @param laneId - Lane the entry describes
 * @param artifact - Artifact path it names
 * @returns The entry
 */
function laneEntry(laneId: LaneManifestEntry['laneId'], artifact: string): LaneManifestEntry {
  return {
    laneId,
    artifact,
    route: 'git-ls-files',
    orderPortable: true,
    enumeratedCount: 2,
    admittedCount: 2,
    collisionCount: 0,
    restatementDriftCount: 0,
    buildError: null,
  };
}

/**
 * A minimal command manifest entry naming both stream artifacts.
 *
 * @returns The entry
 */
function commandEntry(): CommandManifestEntry {
  return {
    name: 'audit',
    args: ['audit', '/corpus'],
    exitCode: 0,
    signal: null,
    wallMs: 0,
    stdoutArtifact: STDOUT_ARTIFACT,
    stderrArtifact: STDERR_ARTIFACT,
    stdoutBytes: STDOUT_TEXT.length,
    stderrBytes: 0,
  };
}

/**
 * A manifest with every required field filled in.
 *
 * @param overrides - Fields this test cares about
 * @returns The manifest
 */
function makeManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    vatVersion: '0.0.0-test',
    cacheNamespace: '0.1.42',
    capturedAtIso: '2026-01-01T00:00:00.000Z',
    corpusRoot: '/corpus',
    corpusLabel: 'fixture',
    platform: 'linux',
    nodeVersion: 'v22.0.0',
    corpusGitHead: null,
    corpusGitDirty: null,
    lanes: [],
    commands: [],
    parseFactArtifact: null,
    parseFactBlobCount: null,
    parseFactKeyDisagreementCount: null,
    warnings: [],
    ...overrides,
  };
}

/**
 * Write a one-lane snapshot, the shape most cases start from.
 *
 * @param dir - Snapshot directory to write
 * @returns Nothing
 */
function writeOneLaneSnapshot(dir: string): void {
  writeSnapshot(
    dir,
    makeManifest({ lanes: [laneEntry('resources', RESOURCES_ARTIFACT)] }),
    new Map([[RESOURCES_ARTIFACT, RESOURCES_TEXT]]),
  );
}

describe('qa-snapshot store', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('names the manifest and both artifact subdirectories', () => {
    const dir = snapshotDir();
    const root = safePath.resolve(dir);

    expect(snapshotPaths(dir)).toEqual({
      manifest: `${root}/${MANIFEST_FILENAME}`,
      oracleDir: `${root}/oracle`,
      commandDir: `${root}/command`,
    });
  });

  it('round-trips a manifest and every artifact it names', () => {
    const dir = snapshotDir();
    const manifest = makeManifest({
      lanes: [laneEntry('resources', RESOURCES_ARTIFACT)],
      commands: [commandEntry()],
      parseFactArtifact: PARSE_FACT_ARTIFACT,
      parseFactBlobCount: 3,
      parseFactKeyDisagreementCount: 0,
    });
    const artifacts = new Map([
      [RESOURCES_ARTIFACT, RESOURCES_TEXT],
      [PARSE_FACT_ARTIFACT, PARSE_FACT_TEXT],
      [STDOUT_ARTIFACT, STDOUT_TEXT],
      [STDERR_ARTIFACT, ''],
    ]);

    writeSnapshot(dir, manifest, artifacts);
    const loaded = readSnapshot(dir);

    expect(loaded.dir).toBe(safePath.resolve(dir));
    expect(loaded.manifest).toEqual(manifest);
    expect(Object.fromEntries(loaded.artifacts)).toEqual(Object.fromEntries(artifacts));
  });

  it('normalizes CRLF artifacts to LF on read', () => {
    const dir = snapshotDir();
    writeOneLaneSnapshot(dir);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- artifact inside a mkdtemp-backed snapshot directory created by this test
    writeFileSync(artifactPath(dir, RESOURCES_ARTIFACT), 'a\r\nb\r\n', 'utf8');

    expect(readSnapshot(dir).artifacts.get(RESOURCES_ARTIFACT)).toBe('a\nb\n');
  });

  it('refuses to write into a non-empty directory that is not a snapshot, and leaves it untouched', () => {
    const dir = snapshotDir();
    mkdirSyncReal(dir, { recursive: true });
    const stray = safePath.join(safePath.resolve(dir), 'notes.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename inside a mkdtemp-backed directory created by this test
    writeFileSync(stray, STRAY_TEXT, 'utf8');

    expect(() => {
      writeSnapshot(dir, makeManifest(), new Map());
    }).toThrow(/not a snapshot directory/i);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp-backed directory created by this test
    expect(readdirSync(safePath.resolve(dir))).toEqual(['notes.txt']);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed basename inside a mkdtemp-backed directory created by this test
    expect(readFileSync(stray, 'utf8')).toBe(STRAY_TEXT);
  });

  it('drops an artifact the new manifest does not name when re-writing a snapshot', () => {
    const dir = snapshotDir();
    writeSnapshot(
      dir,
      makeManifest({
        lanes: [laneEntry('resources', RESOURCES_ARTIFACT), laneEntry('audit', AUDIT_ARTIFACT)],
      }),
      new Map([
        [RESOURCES_ARTIFACT, RESOURCES_TEXT],
        [AUDIT_ARTIFACT, AUDIT_TEXT],
      ]),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- artifact inside a mkdtemp-backed snapshot directory created by this test
    expect(existsSync(artifactPath(dir, AUDIT_ARTIFACT))).toBe(true);

    writeOneLaneSnapshot(dir);

    // A survivor would read to a later comparison as "unchanged".
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- artifact inside a mkdtemp-backed snapshot directory created by this test
    expect(existsSync(artifactPath(dir, AUDIT_ARTIFACT))).toBe(false);
    expect([...readSnapshot(dir).artifacts.keys()]).toEqual([RESOURCES_ARTIFACT]);
  });

  it('refuses to load a snapshot whose manifest names a missing artifact, naming the file', () => {
    const dir = snapshotDir();
    writeSnapshot(
      dir,
      makeManifest({ lanes: [laneEntry('resources', RESOURCES_ARTIFACT)] }),
      new Map(),
    );

    expect(() => readSnapshot(dir)).toThrow(RESOURCES_ARTIFACT);
  });

  it('refuses a manifest from the build that still stamped a formatVersion', () => {
    // The strict schema does this now, and does it without an integer anybody
    // had to move. Before, `formatVersion` sat in front of a blind
    // `parsed as SnapshotManifest` cast — so a manifest whose SHAPE was wrong
    // sailed through as long as the number matched.
    const dir = snapshotDir();
    writeOneLaneSnapshot(dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifest inside a mkdtemp-backed snapshot directory created by this test
    writeFileSync(
      snapshotPaths(dir).manifest,
      JSON.stringify({ ...makeManifest(), formatVersion: 2 }),
      'utf8',
    );

    expect(() => readSnapshot(dir)).toThrow(/formatVersion/);
    expect(() => readSnapshot(dir)).toThrow(/Not a manifest this build can read/);
  });

  it('refuses a manifest missing a field this build requires — the case the integer never caught', () => {
    const dir = snapshotDir();
    writeOneLaneSnapshot(dir);
    const withoutPlatform = Object.fromEntries(
      Object.entries(makeManifest()).filter(([key]) => key !== 'platform'),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifest inside a mkdtemp-backed snapshot directory created by this test
    writeFileSync(snapshotPaths(dir).manifest, JSON.stringify(withoutPlatform), 'utf8');

    expect(() => readSnapshot(dir)).toThrow(/platform/);
  });

  it('refuses a lane naming an enumeration route this build does not model', () => {
    const dir = snapshotDir();
    writeOneLaneSnapshot(dir);
    const manifest = makeManifest({ lanes: [laneEntry('resources', RESOURCES_ARTIFACT)] });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifest inside a mkdtemp-backed snapshot directory created by this test
    writeFileSync(
      snapshotPaths(dir).manifest,
      JSON.stringify({
        ...manifest,
        lanes: manifest.lanes.map((lane) => ({ ...lane, route: 'telepathy' })),
      }),
      'utf8',
    );

    expect(() => readSnapshot(dir)).toThrow(/route/);
  });
});
