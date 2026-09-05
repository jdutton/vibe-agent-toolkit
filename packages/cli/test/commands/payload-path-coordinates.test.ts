/**
 * Every payload-emitting command states ONE root and publishes paths relative
 * to it.
 *
 * `vat audit` already answers "relative to what?" once, at the document
 * boundary, via `relativizePathEntries`. Four other commands answered it
 * differently — by not answering at all — and shipped `$HOME`-absolute paths in
 * machine-readable output. That is not cosmetic: an absolute path leaks the
 * operator's home directory into anything the payload is pasted into, makes two
 * runs of the same command on two machines diff against each other, and (for
 * `rag query`) put a RELATIVE `resourceId` directly above an ABSOLUTE
 * `filePath` in the same record — one document in two coordinate systems.
 *
 * These builders are pure: no CLI spawn, no `process.exit`. The commands keep
 * absolute paths internally (they are the identity every registry and cache
 * keys on) and re-base exactly once, here.
 *
 * Purity has a hard limit, and the last suite in this file is where it bites:
 * a `path` can be re-based at the document boundary, but an issue `location`
 * cannot, so it has to be anchored correctly by each producer at the moment it
 * emits. A pure test handed those locations only reads back what it wrote. That
 * suite therefore runs the real validators over a real marketplace on disk —
 * the only file-system tests here, and the reason is stated at their describe.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAgentListOutput } from '../../src/commands/agent/list.js';
import {
  buildMarketplaceValidateReport,
  collectMarketplaceFindings,
} from '../../src/commands/claude/marketplace/validate.js';
import { buildQueryOutputData } from '../../src/commands/rag/query-command.js';
import { buildScanOutputData } from '../../src/commands/resources/scan.js';
import { formatSkillsYaml } from '../../src/commands/skills/list.js';
import {
  anchorContractViolations,
  anchorsBelowRoot,
  pluginManifestLocations,
} from '../anchor-contract-helpers.js';
import { silentLogger } from '../test-doubles.js';

/**
 * Synthetic absolute paths, resolved rather than written as literals — on
 * Windows a driveless literal and a resolved path disagree, and
 * `safePath.relative` between them returns a drive-absolute string instead of
 * a subtree-relative one.
 */
const ROOT = safePath.resolve('/payload-root');
const README = safePath.resolve('/payload-root/docs/README.md');
const SKILL = safePath.resolve('/payload-root/skills/alpha/SKILL.md');
const AGENT_DIR = safePath.resolve('/payload-root/agents/alpha');

const README_REL = 'docs/README.md';
const SKILL_REL = 'skills/alpha/SKILL.md';
const AGENT_REL = 'agents/alpha';

/** Nothing in a payload may name the machine it ran on. */
function expectNoAbsolutePaths(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(ROOT);
}

const SCAN_RESOURCE = {
  filePath: README,
  links: [{}, {}],
  headings: [{ children: [{}] }, {}],
  checksum: 'a'.repeat(64),
};

/** The scan payload for one README, with and without `--verbose`. */
function scanPayload(verbose: boolean, lane: 'walk' | 'projection' = 'walk') {
  return buildScanOutputData({
    resources: [SCAN_RESOURCE],
    root: ROOT,
    lane,
    // The walk sources no extent; these cases are about path coordinates.
    extentSource: null,
    durationMs: 234,
    collections: undefined,
    verbose,
  });
}

describe('resources scan payload', () => {
  it('publishes each --verbose file path relative to the stated root', () => {
    const data = scanPayload(true);

    expect(data.root).toBe(ROOT);
    expect(data.files).toEqual([
      { path: README_REL, links: 2, anchors: 3, checksum: 'a'.repeat(64) },
    ]);
    expectNoAbsolutePaths(data.files);
  });

  it('states which enumerator produced the population, in every verbosity', () => {
    // Provenance, and it belongs beside `root` because it qualifies the file
    // list the same way: two scans of one tree that report different
    // populations are only interpretable if each names its own lane.
    expect(scanPayload(true).lane).toBe('walk');
    expect(scanPayload(false).lane).toBe('walk');
    expect(scanPayload(true, 'projection').lane).toBe('projection');
  });

  it('names the duration field `durationSecs`, in seconds', () => {
    // The shipped help doc and the emitted payload have to agree on the field
    // name; a doc that says `duration: 234ms` describes a field that does not
    // exist.
    const data = scanPayload(false);

    // A 5e-11 window: an EXACTNESS check, not a tolerance. The failure it guards
    // is `234` (milliseconds) leaking into a field named `...Secs`.
    expect(data.durationSecs).toBeCloseTo(0.234, 10);
    expect(data).not.toHaveProperty('duration');
  });

  it('omits the file list entirely without --verbose', () => {
    expect(scanPayload(false)).not.toHaveProperty('files');
  });
});

describe('skills list payload', () => {
  const skills = [{ name: 'alpha', path: SKILL, valid: true }];

  it('publishes each skill path relative to the stated root', () => {
    const yamlText = formatSkillsYaml(skills, 'project', ROOT);

    expect(yamlText).toContain(`root: ${ROOT}\n`);
    expect(yamlText).toContain(`    path: ${SKILL_REL}\n`);
    expect(yamlText).not.toContain(`path: ${SKILL}`);
  });

  it('leaves the entries it was handed unmutated', () => {
    formatSkillsYaml(skills, 'project', ROOT);

    expect(skills[0]?.path).toBe(SKILL);
  });
});

describe('agent list payload', () => {
  const agents = [
    { name: 'alpha', version: '0.1.0', path: AGENT_DIR, manifestPath: `${AGENT_DIR}/agent.yaml` },
  ];

  it('publishes each agent path relative to the stated root', () => {
    const data = buildAgentListOutput(agents, ROOT, 19);

    expect(data.root).toBe(ROOT);
    expect(data.agents).toEqual([{ name: 'alpha', version: '0.1.0', path: AGENT_REL }]);
    expect(data.count).toBe(1);
    expect(data.duration).toBe('19ms');
    expectNoAbsolutePaths(data.agents);
  });
});

describe('rag query payload', () => {
  const chunk = {
    chunkId: 'c1',
    resourceId: README_REL,
    filePath: README,
    content: 'body',
    contentHash: 'h',
    tokenCount: 4,
    embeddingModel: 'm',
    embeddedAt: new Date(0),
  };

  it('puts filePath in the same coordinate system as resourceId', () => {
    // The discriminating case for this command: `resourceId` was ALREADY
    // relative and sat one line above an absolute `filePath` in the same
    // record. A test that only checked "no absolute path anywhere" would pass
    // on a payload that dropped filePath altogether.
    const data = buildQueryOutputData({
      queryText: 'hello',
      chunks: [chunk],
      stats: { totalMatches: 1, searchDurationMs: 3 },
      durationMs: 12,
      root: ROOT,
    });

    expect(data.root).toBe(ROOT);
    const chunks = data.chunks as Array<{ filePath: string; resourceId: string }>;
    expect(chunks[0]?.filePath).toBe(README_REL);
    expect(chunks[0]?.resourceId).toBe(README_REL);
    expect(data.duration).toBe('12ms');
    expectNoAbsolutePaths(data.chunks);
  });
});

describe('marketplace validate payload', () => {
  const PLUGIN_DIR = safePath.resolve('/payload-root/plugins/alpha');
  const PLUGIN_REL = 'plugins/alpha';
  const PLUGIN_MANIFEST_REL = 'plugins/alpha/.claude-plugin/plugin.json';

  /**
   * A plugin result as the validators actually hand it over: an absolute `path`
   * (the identity the run keys on) carrying findings whose `location` is
   * ALREADY relative to the marketplace root.
   */
  const pluginResult = {
    path: PLUGIN_DIR,
    type: 'claude-plugin',
    status: 'error',
    summary: 'Found 1 issue(s)',
    issues: [
      {
        severity: 'error',
        code: 'PLUGIN_MISSING_VERSION',
        message: 'plugin.json missing version field',
        location: PLUGIN_MANIFEST_REL,
        fix: 'Add a "version" field to plugin.json',
      },
    ],
    issueCounts: { errors: 1, warnings: 0, info: 0 },
    metadata: { name: 'alpha' },
  } as const;

  it('states the marketplace root once and publishes each plugin path relative to it', () => {
    const data = buildMarketplaceValidateReport({
      status: 'error',
      root: ROOT,
      marketplace: { name: 'mp', version: '1.0.0' },
      pluginResults: [pluginResult],
      issues: pluginResult.issues,
      issueCounts: { errors: 1, warnings: 0, info: 0 },
      summary: '1 error(s), 0 warning(s), 0 info',
      duration: '7ms',
    });

    expect(data['root']).toBe(ROOT);
    // The root is stated under its own name; a second absolute `path` beside it
    // is how a document ends up naming the machine it ran on twice.
    expect(data).not.toHaveProperty('path');
    expect(data['plugins']).toEqual([
      {
        path: PLUGIN_REL,
        status: 'error',
        metadata: { name: 'alpha' },
        // Re-basing is not idempotent: a `location` that arrives root-relative
        // must be published byte-for-byte, not run through `relative()` again.
        issues: pluginResult.issues,
      },
    ]);
    expectNoAbsolutePaths(data['plugins']);
    expectNoAbsolutePaths(data['issues']);
  });

  it('states the root on the manifest-missing bail payload too', () => {
    // The early exit is a second emission site, and it leaked the same absolute
    // path — a document shape that only the happy path was ever checked for.
    const data = buildMarketplaceValidateReport({
      status: 'error',
      root: ROOT,
      marketplace: undefined,
      pluginResults: [],
      issues: [],
      issueCounts: { errors: 1, warnings: 0, info: 0 },
      summary: 'Marketplace manifest missing',
      duration: '2ms',
    });

    expect(data['root']).toBe(ROOT);
    expect(data).not.toHaveProperty('path');
    expect(data).not.toHaveProperty('marketplace');
    expect(data['summary']).toBe('Marketplace manifest missing');
  });
});

/**
 * The assertion the builder tests above structurally CANNOT make.
 *
 * `buildMarketplaceValidateReport` is pure, so a test that hands it locations
 * only ever confirms the locations it wrote itself. Which root each producer
 * anchors its findings at is decided upstream, in `collectMarketplaceFindings`
 * — so that is what runs here, against a real marketplace on disk. These are
 * the only file-system tests in this file and they earn it: the contract is
 * "does `join(root, location)` name a real file?", and nothing but a real file
 * answers that.
 *
 * The fixture is a marketplace NESTED INSIDE a project, which is the shape that
 * distinguishes the two answers. A bare temp directory does not: with no
 * enclosing project the fallback anchor collapses onto the marketplace itself,
 * so a broken producer and a correct one emit the same string and the test
 * cannot fail.
 */
/** The manifest directory name, in both marketplace and plugin fixtures. */
const MANIFEST_DIR = '.claude-plugin';

/** Emit the document the command would, for a marketplace on disk. */
async function marketplaceReportFor(root: string): Promise<Record<string, unknown>> {
  const { marketplaceResult, pluginResults, issues } = await collectMarketplaceFindings(
    root,
    silentLogger,
  );
  return buildMarketplaceValidateReport({
    status: 'error',
    root,
    marketplace: marketplaceResult.metadata,
    pluginResults,
    issues,
    issueCounts: { errors: issues.length, warnings: 0, info: 0 },
    summary: `${issues.length} error(s), 0 warning(s), 0 info`,
    duration: '9ms',
  });
}

/** Write a fixture JSON file, creating its directory chain. */
function writeJsonFixture(filePath: string, value: unknown): void {
  mkdirSyncReal(safePath.resolve(filePath, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
  writeFileSync(filePath, JSON.stringify(value));
}

describe('marketplace validate — every producer anchored at the stated root', () => {
  let projectRoot: string;
  /** The marketplace under test: a SUBDIRECTORY of the project root. */
  let marketplaceRoot: string;
  let report: Record<string, unknown>;

  beforeAll(async () => {
    projectRoot = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-anchor-')));
    // What makes the project root discoverable — and therefore what makes the
    // wrong anchor a DIFFERENT string from the right one.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
    writeFileSync(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');

    marketplaceRoot = safePath.join(projectRoot, 'mp');
    writeJsonFixture(safePath.join(marketplaceRoot, MANIFEST_DIR, 'marketplace.json'), {
      name: 'mp',
      owner: { name: 'owner' },
      plugins: [],
    });
    // Present so `checkMarketplaceFiles` stays quiet: a missing-file finding
    // necessarily names a path that does not resolve, which would drown the
    // signal this suite is reading.
    for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
      writeFileSync(safePath.join(marketplaceRoot, file), 'x\n');
    }

    // TWO plugins, because one cannot show a collision. Each manifest omits
    // `version` — an error under strict, reported AT a plugin.json that EXISTS,
    // so the anchor is checkable by resolution rather than by string shape.
    for (const name of ['alpha', 'beta']) {
      writeJsonFixture(
        safePath.join(marketplaceRoot, 'plugins', name, MANIFEST_DIR, 'plugin.json'),
        { name },
      );
    }

    report = await marketplaceReportFor(marketplaceRoot);
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('resolves every path and location in the document against the stated root', () => {
    const anchors = anchorsBelowRoot(report);

    // Guard the gate's own population: an empty anchor set makes
    // `anchorContractViolations` vacuously green, which is exactly how the
    // previous version of this suite passed while the defect shipped.
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.some((a) => a.key === 'location')).toBe(true);

    expect(anchorContractViolations(anchors, marketplaceRoot)).toEqual([]);
  });

  it('gives the two plugin manifests distinct locations', () => {
    // Anchoring each plugin's findings at its OWN directory would make both
    // manifests report the byte-identical `.claude-plugin/plugin.json`, and
    // anything grouping or de-duplicating by `location` would merge them.
    expect(pluginManifestLocations(anchorsBelowRoot(report))).toEqual([
      'plugins/alpha/.claude-plugin/plugin.json',
      'plugins/beta/.claude-plugin/plugin.json',
    ]);
  });

  it('anchors the manifest finding on the bail path at the same root', async () => {
    // The early exit reports through a producer the happy path never reaches,
    // so it needs its own marketplace — one whose manifest EXISTS (the location
    // must resolve) but fails the schema.
    const badRoot = safePath.join(projectRoot, 'mp-bad');
    writeJsonFixture(safePath.join(badRoot, MANIFEST_DIR, 'marketplace.json'), { name: 'mp-bad' });

    const bailReport = await marketplaceReportFor(badRoot);
    const anchors = anchorsBelowRoot(bailReport);

    expect(anchors.map((a) => a.value)).toContain('.claude-plugin/marketplace.json');
    expect(anchorContractViolations(anchors, badRoot)).toEqual([]);
  });
});

describe('packages/cli/docs/resources.md — the shipped scan reference', () => {
  // Runtime-loaded help text is the single source of truth for `vat resources
  // --help --verbose`, so a drifted example is a shipped lie, not a typo.
  const docPath = safePath.resolve(
    safePath.join(fileURLToPath(new URL('.', import.meta.url)), '../../docs/resources.md'),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from this test file's own location
  const doc = readFileSync(docPath, 'utf8');
  const scanSection = doc.slice(
    doc.indexOf('### vat resources scan'),
    doc.indexOf('### vat resources validate'),
  );

  it('documents the scan options the command actually accepts', () => {
    expect(scanSection).toContain('`--verbose`');
    expect(scanSection).toContain('`--collection <id>`');
  });

  it('shows the duration field the command actually emits', () => {
    expect(scanSection).toContain('durationSecs:');
    expect(scanSection).not.toContain('duration: 234ms');
  });

  it('shows relative file paths under a stated root', () => {
    expect(scanSection).toContain('path: docs/README.md');
    expect(scanSection).toContain('root:');
  });
});
