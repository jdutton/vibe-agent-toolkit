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

import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { SymlinkCapability } from '@vibe-agent-toolkit/utils';
import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MarketplaceValidateReport } from '../../../../src/commands/claude/marketplace/validate-schema.js';
import { runMarketplaceValidatePhase } from '../../../../src/commands/claude/marketplace/validate.js';
import { publishedPhase } from '../../../helpers/published-phase.js';
import { errno, realBehind, refusingOnly } from '../../../helpers/refusal-doubles.js';

// `statSync` and `readdirSync` are named imports in the command, so the
// refused-source and refused-`skills/` cases inject at the module seam. Every
// other case stats and lists for real through them.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['statSync', 'readdirSync']));

const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';
/**
 * Proof this process may create symlinks at all, or `null`. On Windows that is
 * a privilege on the process token, so it is probed rather than branched on
 * `process.platform`, and the symlink cases SKIP visibly rather than no-op.
 */
const SYMLINK_CAP = symlinkCapability();
const MANIFEST_DIR = '.claude-plugin';
const PLUGIN_JSON = 'plugin.json';
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

/** A published finding, the fields these cases read. */
interface VerboseIssue { code: string; severity: string; message: string }

/** Write a JSON file, creating its directory chain. */
function writeJson(filePath: string, value: unknown): void {
  mkdirSyncReal(safePath.resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

/**
 * The three files `checkMarketplaceFiles` wants. They are distribution hygiene,
 * orthogonal to which plugins get validated, and a missing LICENSE is an error
 * that would drown the signal these cases read.
 */
function writeHygieneFiles(root: string): void {
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
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
  writeJson(safePath.join(dir, MANIFEST_DIR, PLUGIN_JSON), { name, version: '1.0.0' });
}

/** The refusal shape shared by every "nothing validated" case: exit 1, findings, no plugin rows. */
function expectRefusedRun(exitCode: number, doc: MarketplaceValidateReport): void {
  expect(exitCode).toBe(1);
  expect(doc.status).toBe('findings');
  expect(doc.data.plugins).toEqual([]);
}

/** Run the command the way the CLI does, minus the emission; the document parsed with its registry schema. */
async function validate(root: string, verbose = false): Promise<{ exitCode: number; doc: MarketplaceValidateReport }> {
  const { exitCode, document } = publishedPhase<MarketplaceValidateReport>('claude marketplace validate', await runMarketplaceValidatePhase(root, { verbose }));
  return { exitCode, doc: document };
}

/**
 * Run over `root` and assert it PASSED having validated exactly `rows` — each
 * `[name, path]` — so a pass is only ever claimed beside what it validated.
 */
async function expectPassedValidating(
  root: string,
  rows: Array<[name: string, path: string]>,
): Promise<{ doc: MarketplaceValidateReport; plugins: MarketplaceValidateReport['data']['plugins'] }> {
  const { exitCode, doc } = await validate(root);
  const plugins = doc.data.plugins;

  expect(exitCode).toBe(0);
  expect(doc.summary.errors).toBe(0);
  expect(doc.examined).toBe(rows.length);
  expect(plugins.map((p) => [p.name, p.path])).toEqual(rows);
  return { doc, plugins };
}

/**
 * Run over `root` and assert the run was refused for a path it could not read:
 * exit 1, ONE run-integrity finding at error naming `unreadPath` (root-relative).
 */
async function expectUnreadRefusal(root: string, unreadPath: string): Promise<MarketplaceValidateReport> {
  const { exitCode, doc } = await validate(root, true);
  const integrity = doc.findings.filter((i) => i.code === RUN_INTEGRITY_CODE);

  expect(exitCode).toBe(1);
  expect(doc.status).toBe('findings');
  expect(integrity).toHaveLength(1);
  expect(integrity[0]?.severity).toBe('error');
  expect(integrity[0]?.message).toContain(`\`${unreadPath}\``);
  return doc;
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

    expect(plugins.map((p) => [p.source, p.manifestRead, p.summary.errors])).toEqual([['./', true, 0]]);
    expect(doc.data.undeclared).toEqual([]);
  });

  it('(b) refuses when the declared source does not resolve, naming it — an undeclared sibling does not count', async () => {
    // 🔑 The false negative. `plugins/b` exists and `a` does not; by count
    // that was 1 ≥ 1 and a pass over a marketplace whose ONE shipped plugin
    // was never inspected.
    const root = safePath.join(tmp, 'mkt');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, 'plugins', 'b'), 'b');

    const { exitCode, doc } = await validate(root, true);
    const issues = doc.findings;
    const refusal = issues.find((i) => i.code === RUN_INTEGRITY_CODE);

    expectRefusedRun(exitCode, doc);
    // The undeclared directory is LISTED, not validated: nothing about `b`
    // appears in `issues`, and its presence is not what fails the run.
    expect(doc.data.undeclared).toEqual(['plugins/b']);
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

    expect(doc.data.undeclared).toEqual(['plugins/b']);
  });

  it('refuses a declared source that resolves to a FILE, not a directory', async () => {
    // "Resolves" means "is a directory": a source naming a file is the same
    // unvalidated plugin as one naming nothing.
    const root = safePath.join(tmp, 'file-source');
    writeMarketplace(root, [DECLARED_A]);
    mkdirSyncReal(safePath.join(root, 'plugins'), { recursive: true });
    writeFileSync(safePath.join(root, 'plugins', 'a'), 'not a directory\n');

    const { exitCode, doc } = await validate(root, true);
    const issues = doc.findings;

    expect(exitCode).toBe(1);
    expect(doc.data.plugins).toHaveLength(0);
    expect(issues.map((i) => i.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(doc.data.undeclared).toEqual([]);
  });

  it('refuses the RUN when the OS refuses a declared source, rather than reporting it as unresolved', async () => {
    // "Does not resolve" sends the reader to create a directory. This one is
    // there; the process cannot examine it. That is the run's problem and the
    // command says so by errno at exit 2, like every other verb.
    const root = safePath.join(tmp, 'refused-source');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, PLUGIN_A), 'a');
    vi.mocked(statSync).mockImplementation(
      refusingOnly(safePath.join(root, PLUGIN_A), errno('EACCES'), realBehind(statSync)),
    );

    try {
      const { exitCode, doc } = await validate(root, true);

      expect(exitCode).toBe(2);
      expect(doc.status).toBe('error');
      expect(doc.status === 'error' ? doc.error.message : '').toContain('EACCES');
    } finally {
      vi.mocked(statSync).mockRestore();
    }
  });

  it('reports a declared directory with no plugin manifest as a plugin finding, not a refusal', async () => {
    // Resolution is about the DIRECTORY. What is inside it is the plugin
    // validator's question, and it already has a code for an absent manifest.
    const root = safePath.join(tmp, 'empty-dir');
    writeMarketplace(root, [DECLARED_A]);
    mkdirSyncReal(safePath.join(root, 'plugins', 'a'), { recursive: true });

    const { exitCode, doc } = await validate(root, true);
    const issues = doc.findings;

    expect(exitCode).toBe(1);
    expect(doc.data.plugins).toHaveLength(1);
    expect(issues.map((i) => i.code)).not.toContain(RUN_INTEGRITY_CODE);
    expect(issues.map((i) => i.code)).toContain('PLUGIN_MISSING_MANIFEST');
  });

  it('refuses the RUN when the OS will not read a declared plugin\'s plugin.json — a gate never passes a manifest it did not read', async () => {
    // The validator degrades an unreadable manifest to a `SCAN_PATH_UNREADABLE`
    // WARNING (right for `vat audit`), which alone left this publish gate — and
    // `vat verify` through it — at exit 0 over a plugin nothing checked. A
    // DIRECTORY where the file belongs refuses the read (EISDIR) on every
    // platform, without a chmod the test's user might be exempt from.
    const root = safePath.join(tmp, 'manifest-unreadable');
    writeMarketplace(root, [DECLARED_A]);
    mkdirSyncReal(safePath.join(root, PLUGIN_A, MANIFEST_DIR, PLUGIN_JSON), { recursive: true });

    const doc = await expectUnreadRefusal(root, 'plugins/a/.claude-plugin/plugin.json');
    // The per-path finding still names the errno; the row says it was not read.
    expect(doc.findings.map((i) => i.code)).toContain('SCAN_PATH_UNREADABLE');
    expect(doc.data.plugins.map((p) => [p.path, p.manifestRead])).toEqual([['plugins/a', false]]);
    expect(doc.data.refused).toEqual([]);
  });

  it('refuses the RUN when the OS will not read a plugin skill\'s SKILL.md — never INTERNAL_ERROR, never a pass', async () => {
    // A DIRECTORY where SKILL.md belongs refuses the read (EISDIR) on every
    // platform. The skill validator's bare read used to throw it out of the
    // whole run: exit 2, INTERNAL_ERROR, with a stack.
    const root = safePath.join(tmp, 'skill-md-unreadable');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, PLUGIN_A), 'a');
    mkdirSyncReal(safePath.join(root, PLUGIN_A, 'skills', 's1', 'SKILL.md'), { recursive: true });

    const doc = await expectUnreadRefusal(root, 'plugins/a/skills/s1/SKILL.md');
    expect(doc.findings.filter((i) => i.code === 'SCAN_PATH_UNREADABLE').map((i) => i.location)).toEqual(['plugins/a/skills/s1/SKILL.md']);
    // The plugin's own manifest WAS read; only the skill was not.
    expect(doc.data.plugins.map((p) => [p.path, p.manifestRead])).toEqual([['plugins/a', true]]);
  });

  it('refuses the RUN when the OS will not list a plugin\'s skills/ directory — never INTERNAL_ERROR, never a pass', async () => {
    const root = safePath.join(tmp, 'skills-dir-unlistable');
    writeMarketplace(root, [DECLARED_A]);
    writePlugin(safePath.join(root, PLUGIN_A), 'a');
    mkdirSyncReal(safePath.join(root, PLUGIN_A, 'skills', 's1'), { recursive: true });
    vi.mocked(readdirSync).mockImplementation(
      refusingOnly(safePath.join(root, PLUGIN_A, 'skills'), errno('EACCES'), realBehind(readdirSync)),
    );

    try {
      const doc = await expectUnreadRefusal(root, 'plugins/a/skills');
      const unreadable = doc.findings.filter((i) => i.code === 'SCAN_PATH_UNREADABLE');
      expect(unreadable.map((i) => i.location)).toEqual(['plugins/a/skills']);
      expect(unreadable[0]?.message).toContain('EACCES');
    } finally {
      vi.mocked(readdirSync).mockRestore();
    }
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
    expect(doc.summary.errors).toBe(0);
    expect(doc.data.plugins).toHaveLength(0);
    expect(doc.data.undeclared).toEqual([]);
  });
});

/**
 * Every `location` the document publishes, from both views: the flat list and
 * the per-plugin rows. The anchor contract says each is relative to `root`
 * and names something INSIDE it, so none may begin with `../`.
 */
function everyLocationIn(doc: MarketplaceValidateReport): string[] {
  return [...doc.findings.map((i) => i.location), ...doc.data.plugins.map((p) => p.path)]
    .filter((l): l is string => typeof l === 'string');
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
  const issues = doc.findings;

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

/** Marketplace under `tmp/name` whose plugin `a` has `skills/s/SKILL.md` linking `../shared.md`, with a config at its root. */
async function boundaryFindings(tmp: string, name: string, severityYaml: string): Promise<{ exitCode: number; found: VerboseIssue[] }> {
  const root = safePath.join(tmp, name);
  writeMarketplace(root, [DECLARED_A]);
  writePlugin(safePath.join(root, PLUGIN_A), 'a');
  const skillsDir = safePath.join(root, PLUGIN_A, 'skills');
  mkdirSyncReal(safePath.join(skillsDir, 's'), { recursive: true });
  writeFileSync(safePath.join(skillsDir, 'shared.md'), '# Shared\n');
  writeFileSync(
    safePath.join(skillsDir, 's', 'SKILL.md'),
    '---\nname: s\ndescription: A skill whose one link leaves its own directory for a shared doc.\n---\n\n# S\n\nSee [shared](../shared.md).\n',
  );
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), `skills:\n  include: ['none/SKILL.md']\n  defaults:\n    validation:\n${severityYaml}`);

  const { exitCode, doc } = await validate(root, true);
  return { exitCode, found: doc.findings.filter((i) => i.code === 'LINK_OUTSIDE_SKILL_DIR') };
}

describe('marketplace validate — a plugin skill\'s severity is resolved where the skill is validated', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-skill-severity-')));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is silent on a link out of the skill directory by default', async () => {
    const { found } = await boundaryFindings(tmp, 'default', '      severity:\n        LINK_OUTSIDE_PROJECT: error\n');
    expect(found).toEqual([]);
  });

  it('raises a default-ignore code to error from skills.defaults.validation.severity', async () => {
    const { exitCode, found } = await boundaryFindings(tmp, 'strict', '      severity:\n        LINK_OUTSIDE_SKILL_DIR: error\n');
    expect(found.map((i) => i.severity)).toEqual(['error']);
    expect(exitCode).toBe(1);
  });
});

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
      const issues = doc.findings;
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
    const validatedPaths = doc.data.plugins.map((p) => p.path);
    const undeclared = doc.data.undeclared;

    // XOR: the directory appears on exactly one side of the ledger.
    expect(validatedPaths.includes(PLUGIN_X)).not.toBe(undeclared.includes(PLUGIN_X));
    expect(doc.data.plugins).toHaveLength(1);
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
    const codes = doc.findings.map((finding) => finding.code);

    // Every finding sits on the one shared manifest.
    expect(new Set(doc.findings.map((finding) => finding.location))).toEqual(new Set(['plugins/a/.claude-plugin/plugin.json']));
    // Every code on the shared file is published ONCE — the doubled run showed
    // each at 2 — and the run's total is exactly that set, nothing doubled.
    expect(codes).toContain('PLUGIN_MISSING_AUTHOR');
    expect(new Set(codes).size).toBe(codes.length);
    expect(doc.summary.info).toBe(codes.length);
  });
});

/**
 * Containment holds for every path the walk READS, not only for the declared
 * `source`. The delta above closed the source lane and left the next depth
 * open: inside a contained plugin, `skills/` was `readdir`ed through a
 * directory link, a `SKILL.md` was parsed through a file link, and
 * `.claude-plugin/plugin.json` was read through one — each pointing OUT of the
 * root — and the outside file's findings were published at a root-relative
 * location whose real file is not under the root. The help text and the
 * refusal message both promise "this command never leaves the directory it was
 * pointed at"; these pin that the code honours it one level down, through the
 * same run-integrity refusal an escaping source gets, with the refused path
 * named on the document.
 */
describe.skipIf(SYMLINK_CAP === null)('marketplace validate — containment holds below the plugin source', () => {
  const cap = SYMLINK_CAP as SymlinkCapability;
  const SKILL_LEAK = 'plugins/a/skills/leak/SKILL.md';
  /** A skill whose ONE finding (a broken link) is the tell that it was read. */
  const LEAKY_SKILL_MD = '---\nname: leak\ndescription: outside skill reached through a link\n---\n# leak\nSee [x](../../nowhere.md)\n';
  let tmp: string;
  let outsideSkills: string;
  let outsidePluginJson: string;

  beforeAll(() => {
    tmp = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-deep-contained-')));
    outsideSkills = safePath.join(tmp, 'outside', 'skills');
    mkdirSyncReal(safePath.join(outsideSkills, 'leak'), { recursive: true });
    writeFileSync(safePath.join(outsideSkills, 'leak', 'SKILL.md'), LEAKY_SKILL_MD);
    outsidePluginJson = safePath.join(tmp, 'outside', PLUGIN_JSON);
    writeJson(outsidePluginJson, { name: 'a', version: '1.0.0' });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A contained plugin `a`, declared and with a real manifest, at `<tmp>/<name>`. */
  function containedPluginRoot(name: string): { root: string; plugin: string } {
    const root = safePath.join(tmp, name);
    writeMarketplace(root, [DECLARED_A]);
    const plugin = safePath.join(root, 'plugins', 'a');
    writePlugin(plugin, 'a');
    return { root, plugin };
  }

  /**
   * The refusal shape for a path the walk would not follow: the plugin itself
   * WAS validated (exit 1 comes from the refusal, not from an absent plugin),
   * ONE run-integrity finding names `refusedPath`, the document lists it under
   * `refused`, and nothing read through the link reached the document.
   */
  async function expectRefusedBelowSource(root: string, refusedPath: string): Promise<void> {
    const { exitCode, doc } = await validate(root, true);
    const issues = doc.findings;
    const integrity = issues.filter((i) => i.code === RUN_INTEGRITY_CODE);

    expect(exitCode).toBe(1);
    expect(doc.status).toBe('findings');
    expect(doc.data.plugins).toHaveLength(1);
    expect(doc.data.refused).toEqual([refusedPath]);
    expect(integrity).toHaveLength(1);
    expect(integrity[0]?.message).toContain(`\`${refusedPath}\``);
    // Never read: the outside skill's broken link is not a finding here, and
    // no location sits at or beneath the refused path.
    expect(issues.map((i) => i.code)).not.toContain('LINK_INTEGRITY_BROKEN');
    for (const location of everyLocationIn(doc)) {
      expect(toForwardSlash(location).startsWith(refusedPath)).toBe(false);
      expect(location).not.toMatch(/^\.\.(\/|$)/);
    }
  }

  it('refuses a `skills/` directory link that points out, by name, and reads nothing through it', async () => {
    const { root, plugin } = containedPluginRoot('skills-dir-out');
    createSymlink(cap, outsideSkills, safePath.join(plugin, 'skills'), 'dir');

    await expectRefusedBelowSource(root, 'plugins/a/skills');
  });

  it('refuses a skill directory link that points out, by name', async () => {
    const { root, plugin } = containedPluginRoot('skill-dir-out');
    mkdirSyncReal(safePath.join(plugin, 'skills'), { recursive: true });
    createSymlink(cap, safePath.join(outsideSkills, 'leak'), safePath.join(plugin, 'skills', 'leak'), 'dir');

    await expectRefusedBelowSource(root, 'plugins/a/skills/leak');
  });

  it('refuses a SKILL.md file link that points out, by name', async () => {
    const { root, plugin } = containedPluginRoot('skill-md-out');
    mkdirSyncReal(safePath.join(plugin, 'skills', 'leak'), { recursive: true });
    createSymlink(cap, safePath.join(outsideSkills, 'leak', 'SKILL.md'), safePath.join(root, SKILL_LEAK), 'file');

    await expectRefusedBelowSource(root, SKILL_LEAK);
  });

  it('refuses a plugin.json file link that points out, by name, and does not parse it', async () => {
    const root = safePath.join(tmp, 'manifest-out');
    writeMarketplace(root, [DECLARED_A]);
    const manifestDir = safePath.join(root, 'plugins', 'a', MANIFEST_DIR);
    mkdirSyncReal(manifestDir, { recursive: true });
    createSymlink(cap, outsidePluginJson, safePath.join(manifestDir, PLUGIN_JSON), 'file');

    const { exitCode, doc } = await validate(root, true);
    const issues = doc.findings;

    expect(exitCode).toBe(1);
    expect(doc.data.refused).toEqual(['plugins/a/.claude-plugin/plugin.json']);
    expect(issues.filter((i) => i.code === RUN_INTEGRITY_CODE)).toHaveLength(1);
    // Not parsed: none of the manifest-content findings a read would produce.
    expect(issues.map((i) => i.code)).not.toContain('PLUGIN_MISSING_AUTHOR');
    expect(issues.map((i) => i.code)).not.toContain('PLUGIN_MISSING_MANIFEST');
    // The unread plugin's own row is `error`, not a clean row over an empty
    // issue list — the library `status` of an unread result is `ok`, so only
    // `manifestRead: false` can say it.
    expect(doc.data.plugins.map((p) => [p.path, p.manifestRead, p.summary])).toEqual([
      ['plugins/a', false, { errors: 0, warnings: 0, info: 0 }],
    ]);
  });

  it('follows a `skills/` link that points INSIDE the root — containment is by real path, not by spelling', async () => {
    // Positive control: the link is not the offence, leaving the root is. The
    // skill behind the in-root link is validated and its finding published at
    // the link's spelling.
    const { root, plugin } = containedPluginRoot('skills-dir-in');
    const realSkills = safePath.join(root, 'real-skills');
    mkdirSyncReal(safePath.join(realSkills, 'leak'), { recursive: true });
    writeFileSync(safePath.join(realSkills, 'leak', 'SKILL.md'), LEAKY_SKILL_MD);
    createSymlink(cap, realSkills, safePath.join(plugin, 'skills'), 'dir');

    const { doc } = await validate(root, true);
    const issues = doc.findings;

    expect(doc.data.refused).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain(RUN_INTEGRITY_CODE);
    expect(issues.some((i) => i.code === 'LINK_INTEGRITY_BROKEN' && i.location === SKILL_LEAK)).toBe(true);
  });
});
