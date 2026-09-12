/**
 * `vat claude marketplace validate` validates the plugins the manifest DECLARES
 * — each `source` resolved against the marketplace root — not whatever
 * directories happen to sit under `plugins/`.
 *
 * ## The defect
 *
 * The run-integrity denominator was a COUNT: the walk validated every
 * `plugins/*` directory, the manifest reported how many entries had a
 * relative-path `source`, and the refusal fired on `validated < declared` by
 * number. Wrong in both directions:
 *
 * - A co-located marketplace (`source: "./"`, the shape `detectResourceFormat`
 *   recognises on purpose and `vat audit` recurses into) declares 1 and walks
 *   0 — refused at error, exit 1, on a code no `severity` override can lower.
 * - A manifest declaring `./plugins/a` over a `plugins/` holding only an
 *   undeclared `b` validated 1 ≥ declared 1 — `status: success`, exit 0, and
 *   `a`, the one plugin the marketplace ships, was never looked at.
 *
 * ## Why these run the real command over real trees
 *
 * The builder is pure and its own suite drives it with lists; a list-only
 * test cannot tell "validated the declared plugin" from "validated a different
 * directory", because the caller decides what goes in the list. These cases
 * put the manifest and the directories on disk and ask the command, so the
 * resolution — the half that was wrong — is what is under test.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { SymlinkCapability } from '@vibe-agent-toolkit/utils';
import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMarketplaceValidatePhase } from '../../../../src/commands/claude/marketplace/validate.js';

const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';
/**
 * Proof this process may create symlinks at all, or `null`. On Windows that is
 * a privilege on the process token, so it is probed rather than branched on
 * `process.platform`, and the symlink cases SKIP visibly rather than no-op.
 */
const SYMLINK_CAP = symlinkCapability();
const MANIFEST_DIR = '.claude-plugin';
/** The root-relative path most cases put their declared plugin at. */
const PLUGIN_A = 'plugins/a';
/** The one declared entry most cases share: `a`, at the conventional location. */
const DECLARED_A = { name: 'a', source: `./${PLUGIN_A}` };
/** The root-relative path of the plugin the containment cases put at `plugins/x`. */
const PLUGIN_X = 'plugins/x';
/** The source spelling the symlink cases declare. */
const SYMLINK_SOURCE = './plugins/s';

/** The repo's own co-located fixture: one plugin, `source: "./"`, no `plugins/`. */
const COLOCATED_FIXTURE = safePath.resolve(
  __dirname,
  '../../../../../agent-skills/test/fixtures/packaging-shapes/colocated-plugin-marketplace',
);

/** A finding row as `--verbose` publishes it. */
interface VerboseIssue { code: string; severity: string; message: string }

/** A published plugin row, the fields these cases read. */
interface PluginRow { name: string; source: string; path: string; status: string }

/** Write a JSON file, creating its directory chain. */
function writeJson(filePath: string, value: unknown): void {
  mkdirSyncReal(safePath.resolve(filePath, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
  writeFileSync(filePath, JSON.stringify(value));
}

/**
 * The three files `checkMarketplaceFiles` wants. They are distribution hygiene,
 * orthogonal to which plugins get validated, and a missing LICENSE is an error
 * that would drown the signal these cases read.
 */
function writeHygieneFiles(root: string): void {
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
    writeFileSync(safePath.join(root, file), 'x\n');
  }
}

/** A marketplace at `root` whose manifest declares `plugins`, with hygiene files. */
function writeMarketplace(root: string, plugins: Array<{ name: string; source: string }>): void {
  writeJson(safePath.join(root, MANIFEST_DIR, 'marketplace.json'), {
    name: 'mp',
    owner: { name: 'owner' },
    plugins,
  });
  writeHygieneFiles(root);
}

/** A complete (info-only under strict) plugin manifest at `dir`. */
function writePlugin(dir: string, name: string): void {
  writeJson(safePath.join(dir, MANIFEST_DIR, 'plugin.json'), { name, version: '1.0.0' });
}

/** The refusal shape shared by every "nothing validated" case: exit 1, error, empty results. */
function expectRefusedRun(exitCode: number, doc: Record<string, unknown>): void {
  expect(exitCode).toBe(1);
  expect(doc['status']).toBe('error');
  expect(doc['pluginsValidated']).toBe(0);
  expect(doc['plugins']).toEqual([]);
}

/** Run the command the way the CLI does, minus the emission. */
async function validate(root: string, verbose = false) {
  const outcome = await runMarketplaceValidatePhase(root, { verbose });
  return { exitCode: outcome.exitCode, doc: outcome.document as Record<string, unknown> };
}

/**
 * Run over `root` and assert it PASSED having validated exactly `rows` — each
 * `[name, path]` — so a pass is only ever claimed beside what it validated.
 */
async function expectPassedValidating(
  root: string,
  rows: Array<[name: string, path: string]>,
): Promise<{ doc: Record<string, unknown>; plugins: PluginRow[] }> {
  const { exitCode, doc } = await validate(root);
  const plugins = doc['plugins'] as PluginRow[];

  expect(exitCode).toBe(0);
  expect(doc['status']).toBe('success');
  expect(doc['pluginsValidated']).toBe(rows.length);
  expect(plugins.map((p) => [p.name, p.path])).toEqual(rows);
  return { doc, plugins };
}

describe('marketplace validate — the denominator is the DECLARED local sources', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-declared-')));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('(a) passes the repo\'s co-located `source: "./"` fixture — no `plugins/` to walk', async () => {
    // 🔑 Shape the walk could never reach: the one declared plugin IS the
    // marketplace root. Under the count semantics this was `pluginsValidated:
    // 0` against `declared 1`, refused at exit 1.
    const root = safePath.join(tmp, 'colocated');
    cpSync(COLOCATED_FIXTURE, root, { recursive: true });
    writeHygieneFiles(root);

    const { doc, plugins } = await expectPassedValidating(root, [['colocated-plugin', '.']]);

    expect(plugins.map((p) => [p.source, p.status])).toEqual([['./', 'success']]);
    expect(doc['undeclared']).toEqual([]);
  });

  it('(b) refuses when the declared source does not resolve, naming it — an undeclared sibling does not count', async () => {
    // 🔑 The false negative. `plugins/b` exists and `a` does not; by count
    // that was 1 ≥ 1 and a pass over a marketplace whose ONE shipped plugin
    // was never inspected.
    const root = safePath.join(tmp, 'mkt');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, 'plugins', 'b'), 'b');

    const { exitCode, doc } = await validate(root, true);
    const issues = doc['issues'] as VerboseIssue[];
    const refusal = issues.find((i) => i.code === RUN_INTEGRITY_CODE);

    expectRefusedRun(exitCode, doc);
    // The undeclared directory is LISTED, not validated: nothing about `b`
    // appears in `issues`, and its presence is not what fails the run.
    expect(doc['undeclared']).toEqual(['plugins/b']);
    expect(issues.filter((i) => i.code !== RUN_INTEGRITY_CODE)).toEqual([]);
    // ONE refusal, at error, naming the source that did not resolve.
    expect(issues.filter((i) => i.code === RUN_INTEGRITY_CODE)).toHaveLength(1);
    expect(refusal?.severity).toBe('error');
    expect(refusal?.message).toContain('`a`');
    expect(refusal?.message).toContain('./plugins/a');
    expect(refusal?.message).not.toContain('`b`');
  });

  it('(c) validates the declared plugin and lists an undeclared sibling without failing on it', async () => {
    // Declared `a` resolves and is validated; `b` sits beside it undeclared.
    // The manifest is the marketplace's contract with its installer, so `b`
    // cannot ship and is not graded — but it is named, so a reader can tell
    // "under a different name" from "not there at all".
    const root = safePath.join(tmp, 'declared-plus-stray');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, 'plugins', 'a'), 'a');
    writePlugin(safePath.join(root, 'plugins', 'b'), 'b');

    const { doc } = await expectPassedValidating(root, [['a', PLUGIN_A]]);

    expect(doc['undeclared']).toEqual(['plugins/b']);
  });

  it('refuses a declared source that resolves to a FILE, not a directory', async () => {
    // "Resolves" means "is a directory": a source naming a file is the same
    // unvalidated plugin as one naming nothing.
    const root = safePath.join(tmp, 'file-source');
    writeMarketplace(root, [DECLARED_A]);
    mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only temp path
    writeFileSync(safePath.join(root, 'plugins', 'a'), 'not a directory\n');

    const { exitCode, doc } = await validate(root, true);
    const issues = doc['issues'] as VerboseIssue[];

    expect(exitCode).toBe(1);
    expect(doc['pluginsValidated']).toBe(0);
    expect(issues.map((i) => i.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(doc['undeclared']).toEqual([]);
  });

  it('reports a declared directory with no plugin manifest as a plugin finding, not a refusal', async () => {
    // Resolution is about the DIRECTORY. What is inside it is the plugin
    // validator's question, and it already has a code for an absent manifest.
    const root = safePath.join(tmp, 'empty-dir');
    writeMarketplace(root, [DECLARED_A]);
    mkdirSyncReal(safePath.join(root, 'plugins', 'a'), { recursive: true });

    const { exitCode, doc } = await validate(root, true);
    const issues = doc['issues'] as VerboseIssue[];

    expect(exitCode).toBe(1);
    expect(doc['pluginsValidated']).toBe(1);
    expect(issues.map((i) => i.code)).not.toContain(RUN_INTEGRITY_CODE);
    expect(issues.map((i) => i.code)).toContain('PLUGIN_MISSING_MANIFEST');
  });

  it('stays green for a manifest whose entries are all remote, with no `plugins/` at all', async () => {
    // The over-correction guard: nothing local is declared, so nothing local
    // is owed, and the manifest itself WAS validated.
    const root = safePath.join(tmp, 'all-remote');
    writeMarketplace(root, []);
    writeJson(safePath.join(root, MANIFEST_DIR, 'marketplace.json'), {
      name: 'mp',
      owner: { name: 'owner' },
      plugins: [{ name: 'r', source: { source: 'github', repo: 'org/r' } }],
    });

    const { exitCode, doc } = await validate(root);

    expect(exitCode).toBe(0);
    expect(doc['status']).toBe('success');
    expect(doc['pluginsValidated']).toBe(0);
    expect(doc['undeclared']).toEqual([]);
  });
});

/**
 * Every `location` the document publishes, from both views: the flat list and
 * the per-plugin rows. The anchor contract says each is relative to `root`
 * and names something INSIDE it, so none may begin with `../`.
 */
function everyLocationIn(doc: Record<string, unknown>): string[] {
  const flat = (doc['issues'] as Array<{ location?: string }>).map((i) => i.location);
  const nested = (doc['plugins'] as Array<{ issues: Array<{ location?: string }> }>)
    .flatMap((p) => p.issues.map((i) => i.location));
  return [...flat, ...nested].filter((l): l is string => typeof l === 'string');
}

/**
 * The marketplace root is the boundary of what this command may read.
 *
 * 🚨 `marketplace.json` is attacker-reachable content — it is the thing being
 * audited — and every string `source` used to be resolved against the root and
 * WALKED. `source: "/etc"` made the run enter `/etc/cups/certs` and publish
 * locations like `../../../../etc/.claude-plugin/plugin.json`, breaking the
 * document's "every location is relative to root" contract that the help text
 * and the refusal message already claimed. The only guard was a schema refine
 * that split on `/` alone, so an absolute path passed it, and so did
 * `plugins\..\..\x`, which `path.resolve` walks out of the root everywhere.
 *
 * Two lanes close it, and both are pinned here against real trees: the schema
 * refuses what it can SEE (absolute, `..` behind either separator) and the run
 * bails on the manifest; the consumer refuses what only the filesystem knows
 * (a symlink inside the root pointing out) through the same run-integrity
 * finding an unresolved source gets. In neither lane is the directory entered.
 */
/**
 * Run over `root`, whose only declared source escapes it, and assert the
 * refusal: exit 1, ONE error finding naming `source`, nothing validated, and
 * not one published location outside the root.
 */
async function expectRefusedWithoutLeaving(root: string, source: string): Promise<void> {
  const { exitCode, doc } = await validate(root, true);
  const issues = doc['issues'] as VerboseIssue[];

  expectRefusedRun(exitCode, doc);
  // Refused BY NAME: the reader sees which entry, and its spelling.
  const naming = issues.filter((i) => i.severity === 'error' && i.message.includes(source));
  expect(naming).toHaveLength(1);
  // Never entered: no plugin finding from the outside tree, and no location
  // that climbs out of the root.
  expect(issues.map((i) => i.code)).not.toContain('PLUGIN_MISSING_AUTHOR');
  for (const location of everyLocationIn(doc)) {
    expect(location).not.toMatch(/^\.\.(\/|$)/);
  }
}

describe('marketplace validate — a declared source never leaves the marketplace root', () => {
  let tmp: string;
  /** A real plugin OUTSIDE every marketplace root below — the thing a leak reaches. */
  let outsideTarget: string;

  beforeAll(() => {
    tmp = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-contained-')));
    outsideTarget = safePath.join(tmp, 'outside-target');
    writePlugin(outsideTarget, 'out');
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses an ABSOLUTE source at the manifest and never enters it', async () => {
    // The HIGH finding's shape: an absolute path passed the `/`-split refine.
    const root = safePath.join(tmp, 'abs');
    writeMarketplace(root, [{ name: 'out', source: outsideTarget }]);

    await expectRefusedWithoutLeaving(root, outsideTarget);
  });

  it('refuses a BACKSLASH traversal at the manifest — `path.resolve` walks it out on every platform', async () => {
    const source = String.raw`plugins\..\..\outside-target`;
    const root = safePath.join(tmp, 'bsl');
    writeMarketplace(root, [{ name: 'x', source }]);
    mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });

    await expectRefusedWithoutLeaving(root, source);
  });

  describe.skipIf(SYMLINK_CAP === null)('a symlink inside the root that points out', () => {
    // Non-null inside this block: the suite does not run when the probe said no.
    const cap = SYMLINK_CAP as SymlinkCapability;

    it('is refused by the CONSUMER through the run-integrity finding, and never entered', async () => {
      // 🔑 The lane the schema cannot see: `./plugins/s` is a clean relative
      // path, and only `realpath` knows it resolves to a directory the root
      // does not contain.
      const root = safePath.join(tmp, 'sym');
      writeMarketplace(root, [{ name: 's', source: SYMLINK_SOURCE }]);
      mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
      createSymlink(cap, outsideTarget, safePath.join(root, 'plugins', 's'), 'dir');

      await expectRefusedWithoutLeaving(root, SYMLINK_SOURCE);
      const { doc } = await validate(root, true);
      const issues = doc['issues'] as VerboseIssue[];
      expect(issues.map((i) => i.code)).toEqual([RUN_INTEGRITY_CODE]);
      expect(issues[0]?.message).toContain('`s` (./plugins/s)');
    });

    it('is validated when it points INSIDE the root — containment is by real path, not by spelling', async () => {
      // The positive control for the realpath lane: a link is not the offence,
      // leaving the root is.
      const root = safePath.join(tmp, 'sym-in');
      writeMarketplace(root, [{ name: 's', source: SYMLINK_SOURCE }]);
      writePlugin(safePath.join(root, 'real'), 's');
      mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
      createSymlink(cap, safePath.join(root, 'real'), safePath.join(root, 'plugins', 's'), 'dir');

      await expectPassedValidating(root, [['s', 'plugins/s']]);
    });
  });

  it('validates a backslash-spelled source ONCE — as validated, never also as undeclared', async () => {
    // 🪤 `.\plugins\x` on POSIX resolved to `<root>/./plugins/x`: `statSync`
    // accepted it, so it was VALIDATED, while `undeclared` was built from
    // `<root>/plugins/x` — a different string for the same directory — so the
    // one plugin was published as both.
    const root = safePath.join(tmp, 'win');
    writeMarketplace(root, [{ name: 'x', source: String.raw`.\plugins\x` }]);
    writePlugin(safePath.join(root, 'plugins', 'x'), 'x');

    const { doc } = await validate(root);
    const validatedPaths = (doc['plugins'] as PluginRow[]).map((p) => p.path);
    const undeclared = doc['undeclared'] as string[];

    // XOR: the directory appears on exactly one side of the ledger.
    expect(validatedPaths.includes(PLUGIN_X)).not.toBe(undeclared.includes(PLUGIN_X));
    expect(doc['pluginsValidated']).toBe(1);
    expect(undeclared).toEqual([]);
  });

  it('validates a directory two entries share ONCE, and both entries still name it', async () => {
    // Two manifest entries, one directory: the directory's findings were
    // collected twice and COUNTED twice (`PLUGIN_MISSING_AUTHOR: 2` for one
    // file). Each entry still gets its row — the manifest declared two — but
    // the file is inspected once and its findings appear once.
    const root = safePath.join(tmp, 'dup');
    writeMarketplace(root, [DECLARED_A, { name: 'a-again', source: DECLARED_A.source }]);
    writePlugin(safePath.join(root, 'plugins', 'a'), 'a');

    const { doc } = await expectPassedValidating(root, [['a', PLUGIN_A], ['a-again', PLUGIN_A]]);
    const rows = doc['issues'] as Array<{ location?: string; codes: Record<string, number> }>;
    const manifestRow = rows.find((r) => r.location === 'plugins/a/.claude-plugin/plugin.json');

    expect(rows).toHaveLength(1);
    expect(manifestRow?.codes['PLUGIN_MISSING_AUTHOR']).toBe(1);
    // Every code on the shared file is counted ONCE — the doubled run showed
    // each at 2 — and the run's total is exactly that set, nothing doubled.
    const codeCounts = Object.values(manifestRow?.codes ?? {});
    expect(codeCounts.length).toBeGreaterThan(0);
    expect(codeCounts.every((n) => n === 1)).toBe(true);
    expect((doc['issueCounts'] as { info: number }).info).toBe(codeCounts.length);
  });
});
