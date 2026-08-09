/**
 * The QA snapshot instrument, wired end to end over the trap corpus.
 *
 * `packages/cli/test/integration/pipeline-oracles.integration.test.ts` pins what
 * each *oracle* sees. This file pins the layer above it: capture → store →
 * compare → render, which is where the instrument can go wrong in the one way
 * that makes it worse than not having it at all — **reporting drift on a tree
 * that did not move**. A comparison that is noisy by default is a comparison
 * nobody reads, so the determinism test below is the load-bearing one and every
 * other test here exists to say what a green determinism run is allowed to mean.
 *
 * Three deliberate non-goals, so nobody "fixes" them later:
 *
 * - **No golden.** Assertions here are on properties — statuses, counts, which
 *   lane moved. The committed goldens live in the oracle test and are not
 *   extended from here; a golden over a capture would have to be regenerated
 *   every time an unrelated lane changed, which is exactly the noise this
 *   instrument exists to remove.
 * - **No whole-command half.** See {@link captureCorpus} — spawning the built
 *   binary from a vitest run tests the build, not the instrument.
 * - **No cross-host claim.** The walk-route corpus is asserted for its *route
 *   bookkeeping*, never for its ordering; `readdirSync` order is a property of
 *   the filesystem and is not comparable across hosts.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- every path in this
   file is a mkdtemp root this file created, or a frozen basename joined under
   one. None comes from a caller, a config, or the corpus itself. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LANES } from '../../src/pipeline-oracles/lanes.js';
import { materializeTrapCorpus } from '../../src/pipeline-oracles/trap-corpus.js';
import { captureSnapshot, type CaptureResult } from '../../src/qa-snapshot/capture.js';
import { compareSnapshots } from '../../src/qa-snapshot/diff.js';
import { renderCompareSummary } from '../../src/qa-snapshot/render.js';
import { readSnapshot, writeSnapshot } from '../../src/qa-snapshot/store.js';
import type { CompareReport, LoadedSnapshot } from '../../src/qa-snapshot/types.js';

/** Corpus labels. They are printed into the oracle artifacts, so they must not drift. */
const GIT_CORPUS = 'qa/git';
const WALK_CORPUS = 'qa/walk';

/** Stand-in snapshot directories for in-memory comparisons — cosmetic; only the manifest is read. */
const BEFORE_LABEL = '<capture:before>';
const AFTER_LABEL = '<capture:after>';

/** The parse-fact artifact's fixed name inside a snapshot directory. */
const PARSE_FACT_ARTIFACT = 'oracle/parse-facts.txt';

/** Artifact name for the resources enumeration lane, used to drill into one row. */
const RESOURCES_SELECTOR = 'enumeration.resources';

/** Lanes that crawl HTML as well as markdown — the two a new `.html` file must move. */
const HTML_LANE_IDS = ['resources', 'audit'] as const;

/** Lanes that crawl markdown only — the three a new `.html` file must NOT move. */
const MARKDOWN_ONLY_LANE_IDS = ['skills-build', 'inventory', 'skills-validate'] as const;

/** The file the localization test adds. `.html`, so only two of the five lanes can see it. */
const LATE_ARRIVAL = 'late-arrival.html';

/** Fragment of the per-lane warning `captureLanes` emits on the walk route. */
const WALK_ROUTE_WARNING = 'filesystem walk route';

/** Every oracle artifact: one per lane, plus parse facts. */
const ORACLE_ARTIFACT_COUNT = LANES.length + 1;

/** Ceiling per spawned command. Never reached here — the command half is off. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Capture the oracle half of a snapshot over one corpus.
 *
 * @param corpusRoot - Absolute corpus root
 * @param corpusLabel - Short label printed into the artifacts
 * @returns The capture, ready to compare or to write
 */
function captureCorpus(corpusRoot: string, corpusLabel: string): Promise<CaptureResult> {
  return captureSnapshot({
    corpusRoot,
    corpusLabel,
    // ⛔ Do NOT flip this to true. The whole-command half spawns the built
    // binary, and under vitest `resolveBinPath()` resolves to
    // `packages/cli/src/bin.js` — a file that does not exist, because the build
    // emits `dist/bin.js`. All three commands would record `exitCode: null`
    // ("did not run") and this file would be asserting on the build's presence
    // rather than on the instrument. ⚠️ Nothing turns this half on any more:
    // `vat pipeline snapshot` was its only caller that ever passed `true`, and
    // that verb is deleted, so the whole-command half has no live caller at all.
    includeCommands: false,
    includeParseFacts: true,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });
}

/**
 * Present a capture as a loaded snapshot, so two captures can be compared
 * without a disk round-trip (the round-trip has its own test).
 *
 * @param dir - Stand-in directory label, echoed into the report header
 * @param capture - The capture to wrap
 * @returns A `LoadedSnapshot` view of it
 */
function asLoaded(dir: string, capture: CaptureResult): LoadedSnapshot {
  return { dir, manifest: capture.manifest, artifacts: capture.artifacts };
}

/**
 * Every artifact path the manifest names, in the order `readSnapshot` reads them.
 *
 * @param capture - The capture whose manifest to read
 * @returns Artifact relative paths: lanes, then parse facts, then commands
 */
function namedArtifacts(capture: CaptureResult): string[] {
  const { manifest } = capture;
  const names = manifest.lanes.map((lane) => lane.artifact);
  if (manifest.parseFactArtifact !== null) {
    names.push(manifest.parseFactArtifact);
  }
  for (const command of manifest.commands) {
    names.push(command.stdoutArtifact, command.stderrArtifact);
  }
  return names;
}

/** A disposable directory under the OS temp root. */
function makeTempDir(label: string): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), `vat-qa-${label}-`));
}

/**
 * One artifact's status, or a message naming what the report actually carried.
 *
 * Returning the available artifact names rather than `undefined` matters: a missing
 * row and an unchanged row are opposite findings, and `expect(undefined)` cannot
 * tell them apart in the failure output.
 *
 * @param report - The comparison to read
 * @param name - The artifact name to look up
 * @returns The row's status, or a description of the miss
 */
function statusOf(report: CompareReport, name: string): string {
  const found = report.deltas.find((delta) => delta.name === name);
  if (found === undefined) {
    return `NO SUCH ARTIFACT (report carried: ${report.deltas.map((delta) => delta.name).join(', ')})`;
  }
  return found.status;
}

/** Sorted copy, so two artifact-name lists compare as sets. */
function sortedNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

describe('qa snapshot — git-route corpus', () => {
  let corpusRoot: string;
  let snapshotDir: string;
  let first: CaptureResult;
  let second: CaptureResult;

  beforeAll(async () => {
    corpusRoot = makeTempDir('git');
    snapshotDir = makeTempDir('store');
    // Symlinks are skipped for the same reason the oracle goldens skip them:
    // creating one needs a privilege Windows CI agents usually lack, so a
    // corpus containing them has two legitimate shapes on two hosts.
    const built = materializeTrapCorpus(corpusRoot, { initGit: true, skipSymlinks: true });
    expect(built.gitInitialized, 'git init failed — is git on PATH?').toBe(true);

    first = await captureCorpus(corpusRoot, GIT_CORPUS);
    second = await captureCorpus(corpusRoot, GIT_CORPUS);
  });

  afterAll(() => {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  it('produces one artifact per lane plus parse facts, and every artifact the manifest names', () => {
    // The failure mode this guards is not "an artifact is missing" but what a
    // missing artifact LOOKS like later: `readSnapshot` refuses to substitute an
    // empty string, and a comparison that got one would read it as a wholesale
    // deletion — a catastrophic-looking regression manufactured by bookkeeping.
    expect(first.manifest.lanes.map((lane) => lane.laneId)).toEqual(LANES.map((lane) => lane.id));
    expect(first.manifest.parseFactArtifact).toBe(PARSE_FACT_ARTIFACT);
    expect(first.manifest.commands).toEqual([]);

    const named = namedArtifacts(first);
    expect(named).toHaveLength(ORACLE_ARTIFACT_COUNT);
    for (const name of named) {
      expect(first.artifacts.has(name), `manifest names '${name}', the capture did not produce it`).toBe(
        true,
      );
    }

    // And nothing extra: an artifact the manifest does not name is never read
    // back, so it would be silently dropped by the first write/read cycle.
    expect(sortedNames([...first.artifacts.keys()])).toEqual(sortedNames(named));
  });

  it('⭐ re-capturing an unchanged corpus reports every artifact same and zero changes', () => {
    // The instrument's whole foundation. If a re-capture of a tree nobody
    // touched reports drift, every later comparison is noise and the tool is
    // worse than useless — a reader who learns to ignore it will ignore the one
    // run that mattered. `capturedAtIso` differs between these two captures by
    // construction; it is provenance, never content, and must not show up here.
    const report = compareSnapshots(asLoaded(BEFORE_LABEL, first), asLoaded(AFTER_LABEL, second));

    expect(report.deltas).toHaveLength(ORACLE_ARTIFACT_COUNT);
    expect(report.deltas.filter((delta) => delta.status !== 'same')).toEqual([]);
    expect(report.changedCount).toBe(0);
    // No constraint either: same corpus, same HEAD, same platform, same format
    // and key-schema versions. A constraint here would mean the comparison
    // quietly did less than it looked like it did.
    expect(report.constraints).toEqual([]);
  });

  it('records the git route and claims portable ordering, with no walk-route warning', () => {
    for (const lane of first.manifest.lanes) {
      expect(lane.route, lane.laneId).toBe('git-ls-files');
      expect(lane.orderPortable, lane.laneId).toBe(true);
      expect(lane.buildError, lane.laneId).toBeNull();
    }
    expect(first.manifest.warnings.filter((line) => line.includes(WALK_ROUTE_WARNING))).toEqual([]);
  });

  it('round-trips through a real directory without introducing drift', () => {
    // The on-disk layout must be transparent. If writing and reading changed so
    // much as a line ending, every comparison across two stored snapshots would
    // carry a difference that no pipeline change produced.
    writeSnapshot(snapshotDir, first.manifest, first.artifacts);
    const loaded = readSnapshot(snapshotDir);

    expect(toForwardSlash(loaded.dir)).toBe(toForwardSlash(snapshotDir));
    expect(loaded.manifest).toEqual(first.manifest);
    expect(loaded.artifacts).toEqual(first.artifacts);

    const report = compareSnapshots(loaded, loaded);
    expect(report.deltas).toHaveLength(ORACLE_ARTIFACT_COUNT);
    expect(report.changedCount).toBe(0);
    expect(report.constraints).toEqual([]);
  });
});

describe('qa snapshot — walk-route corpus (no repository above it)', () => {
  let corpusRoot: string;
  let before: CaptureResult;

  beforeAll(async () => {
    corpusRoot = makeTempDir('walk');
    materializeTrapCorpus(corpusRoot, { skipSymlinks: true });
    before = await captureCorpus(corpusRoot, WALK_CORPUS);
  });

  afterAll(() => {
    rmSync(corpusRoot, { recursive: true, force: true });
  });

  it('records the walk route, refuses to claim portable ordering, and warns per lane', () => {
    // Route branching is not cosmetic bookkeeping: `orderPortable` decides
    // whether the artifact was rendered ordered or sorted, and the warning is
    // the only place a reader is told the ordering they are looking at is a
    // property of this filesystem. Both halves are asserted, because a manifest
    // that recorded the route and stayed silent would still mislead.
    for (const lane of before.manifest.lanes) {
      expect(lane.route, lane.laneId).toBe('walk');
      expect(lane.orderPortable, lane.laneId).toBe(false);
      expect(
        before.manifest.warnings.some(
          (line) => line.includes(`lane '${lane.laneId}'`) && line.includes(WALK_ROUTE_WARNING),
        ),
        `no walk-route warning names lane '${lane.laneId}'`,
      ).toBe(true);
    }
  });

  it('localizes a new .html file to the two lanes that crawl HTML, and names one in the summary', async () => {
    // A `.html` file rather than a `.md` one on purpose. A markdown file moves
    // all five lanes, which would prove only that the instrument goes red; an
    // HTML file moves exactly the two lanes that crawl HTML, so the same run
    // proves the other three stayed still. "Something changed" without "where"
    // is barely better than green.
    writeFileSync(
      safePath.join(corpusRoot, LATE_ARRIVAL),
      '<html><body><p>Arrived after the baseline capture.</p></body></html>\n',
      'utf8',
    );
    const after = await captureCorpus(corpusRoot, WALK_CORPUS);
    const report = compareSnapshots(asLoaded(BEFORE_LABEL, before), asLoaded(AFTER_LABEL, after));

    for (const laneId of HTML_LANE_IDS) {
      expect(statusOf(report, `enumeration.${laneId}`), laneId).toBe('changed');
    }
    for (const laneId of MARKDOWN_ONLY_LANE_IDS) {
      expect(statusOf(report, `enumeration.${laneId}`), laneId).toBe('same');
    }
    // The parse half sees it too — the parse-fact oracle runs over the union of
    // what the lanes enumerated, so a file no lane admitted would be invisible.
    expect(statusOf(report, 'parse-facts')).toBe('changed');
    expect(report.changedCount).toBe(HTML_LANE_IDS.length + 1);

    // Advisory, per `ArtifactDelta.headlines` — asserted anyway because a
    // headline that stopped naming the count would remove the one line that
    // saves a reader a drill-down.
    expect(report.deltas.find((delta) => delta.name === RESOURCES_SELECTOR)?.headlines.join(' ')).toContain(
      'enumeratedCount',
    );

    // Finally, what a human actually reads. Asserting `changedCount > 0` would
    // pass on an instrument that went red without saying where, so pin the row:
    // the changed lane is NAMED and marked changed, an unchanged one is NAMED
    // and marked same, and the drill-down hint points at a lane that moved.
    const summary = renderCompareSummary(report);
    expect(summary).toMatch(/enumeration\.resources +changed/u);
    expect(summary).toMatch(/enumeration\.inventory +same/u);
    expect(summary).toContain(`'${RESOURCES_SELECTOR}'`);
  });
});
