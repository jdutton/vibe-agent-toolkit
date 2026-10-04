import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { countBySeverity, resultStatus } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import { AUDIT_REPORT_SCHEMA } from '../../../src/commands/audit-schema.js';
import type * as Audit from '../../../src/commands/audit.js';
import {
  auditOnePlugin,
  buildAuditOutcome,
  buildReviewOutcome,
  type SkillReviewSection,
  unlistedDirectorySections,
} from '../../../src/commands/corpus/runner.js';
import type { PluginEntry } from '../../../src/commands/corpus/seed.js';
import { CommandRefusalError } from '../../../src/utils/command-refusal.js';
import type * as ProjectRootPolicy from '../../../src/utils/project-root-policy.js';

/** The in-process audit, replaced only where a test makes it throw; every other call runs the real one. */
const { getValidationResults } = vi.hoisted(() => ({ getValidationResults: vi.fn() }));
vi.mock('../../../src/commands/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Audit>();
  getValidationResults.mockImplementation(actual.getValidationResults);
  return { ...actual, getValidationResults };
});

/** The local-source probe, replaced only where a test makes it throw; every other call runs the real one. */
const { pathPresent } = vi.hoisted(() => ({ pathPresent: vi.fn() }));
vi.mock('../../../src/utils/project-root-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectRootPolicy>();
  pathPresent.mockImplementation(actual.pathPresent);
  return { ...actual, pathPresent };
});

const META = {
  bucket: 'official',
  confidence: 'first-party',
  maturity: 'production',
} as const;

const RUN_DIR_PREFIX = 'vat-corpus-rundir-';

/** The code the run-integrity refusal carries, shared with every other gate. */
const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

/** Where the builder cases say their document goes; the builder only carries it. */
const AUDIT_DOC = 'x-audit.yaml';

function makeRunDir(): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), RUN_DIR_PREFIX));
}

function makePluginDir(skillBody: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-runner-'));
  const skillDir = safePath.join(root, 'plugins', 'foo');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: foo\ndescription: ${skillBody}\n---\n\n# foo\n\nBody.\n`,
    'utf-8'
  );
  return root;
}

/**
 * Create a plugin directory with SKILL.md at the root — the shape `vat skill
 * review` expects (a single skill directory, not a multi-skill plugin tree).
 * Used by --with-review tests where the runner subprocesses `vat skill review`
 * against the plugin source directly.
 */
function makeReviewablePluginDir(name: string, skillBody: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-review-'));
  writeFileSync(
    safePath.join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${skillBody}\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8'
  );
  return root;
}

describe('auditOnePlugin — local source', () => {
  it('returns a PluginRow with status ok when the plugin audits cleanly', async () => {
    const pluginDir = makePluginDir(
      'A simple test skill that demonstrates a working SKILL.md frontmatter for the runner unit test.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'foo', ...META };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.source).toBe(pluginDir);
    expect(row.name).toBe('foo');
    expect(row.validation_applied).toBe(false);
    expect(row.audit.status).toBe('ok');
    expect(row.audit.output_path).toBe('foo-audit.yaml');
    expect(row.review.status).toBe('skipped');
    // The per-plugin document is the `vat audit` report, parsed by the verb's own schema.
    const document = AUDIT_REPORT_SCHEMA.parse(yaml.parse(readFileSync(safePath.join(runDir, 'foo-audit.yaml'), 'utf-8')));
    expect(document.status).toBe('ok');
    expect(document.examined).toBe(1);
  });

  it('records unloadable when the local source path does not exist', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = { source: '/absolutely/does/not/exist', name: 'ghost', ...META };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('unloadable');
    expect(row.audit.error).toMatch(/not found|does not exist/i);
    expect(row.audit.output_path).toBeUndefined();
  });
});

function git(args: string[], cwd: string): void {
  const r = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function makeBareRepoWithSkill(): string {
  const bare = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-bare-'));
  const work = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-work-'));

  git(['init', '--bare', '--initial-branch=main'], bare);
  git(['init', '--initial-branch=main'], work);
  git(['config', 'user.email', 't@t'], work);
  git(['config', 'user.name', 't'], work);
  git(['remote', 'add', 'origin', bare], work);

  const skillDir = safePath.join(work, 'plugins', 'foo');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: foo\ndescription: A test skill for the URL-source runner unit test that exercises shallow clone end to end.\n---\n\n# foo\n\nBody.\n`,
    'utf-8'
  );

  git(['add', '.'], work);
  git(['commit', '-m', 'initial'], work);
  git(['push', 'origin', 'main'], work);
  return bare;
}

describe('auditOnePlugin — a local source the probe cannot answer for', () => {
  const entry = (): PluginEntry => ({ source: '/probe/target', name: 'probed', ...META });
  const runDir = (): string => mkdtempSync(safePath.join(normalizedTmpdir(), RUN_DIR_PREFIX));

  it('records the probe\'s coded refusal as the entry\'s unloadable row', async () => {
    pathPresent.mockImplementationOnce(() => {
      throw new CommandRefusalError('INPUT_UNREADABLE', 'Path cannot be read (EACCES): /probe/target');
    });

    const row = await auditOnePlugin(entry(), { runDir: runDir(), withReview: false, debug: false });

    expect(row.audit).toMatchObject({ status: 'unloadable', error: 'Path cannot be read (EACCES): /probe/target' });
  });

  it('lets an uncoded throw through — a defect in the probe is not a row message', async () => {
    const defect = new TypeError('probe defect');
    pathPresent.mockImplementationOnce(() => {
      throw defect;
    });

    await expect(auditOnePlugin(entry(), { runDir: runDir(), withReview: false, debug: false })).rejects.toBe(defect);
  });
});

describe('auditOnePlugin — URL source', () => {
  it('clones a file:// URL, audits, and cleans up', async () => {
    const bare = makeBareRepoWithSkill();
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pathToFileURL(bare).href, name: 'foo', ...META };
    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('ok');
    expect(row.audit.output_path).toBe('foo-audit.yaml');
    // A cloned source's root is a random tempdir: the document names the URL instead.
    const document = AUDIT_REPORT_SCHEMA.parse(yaml.parse(readFileSync(safePath.join(runDir, 'foo-audit.yaml'), 'utf-8')));
    expect(document.data.root).toBeNull();
    expect(document.data.provenance?.url).toBe(entry.source);
    expect(document.data.files.map((file) => file.path)).toStrictEqual(['plugins/foo/SKILL.md']);
  });

  it('records unloadable when the clone fails (bad URL)', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = {
      source: 'file:///absolutely/does/not/exist/repo.git',
      name: 'ghost',
      ...META,
    };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('unloadable');
    expect(row.audit.error).toMatch(/clone failed|fatal|repository|not appear/i);
  });
});

describe('auditOnePlugin — a defect inside the audit', () => {
  // An uncoded throw from a validator is a VAT defect, not a property of the plugin:
  // it must end the scan loudly, never become an unloadable row at exit 0.
  const defect = (): TypeError => new TypeError('validator defect');

  it('lets it through for a local source', async () => {
    const thrown = defect();
    getValidationResults.mockRejectedValueOnce(thrown);
    const entry: PluginEntry = { source: makePluginDir('A test skill whose audit is made to throw a defect in the runner unit test.'), name: 'local-defect', ...META };

    await expect(auditOnePlugin(entry, { runDir: makeRunDir(), withReview: false, debug: false })).rejects.toBe(thrown);
  });

  it('lets it through for a URL source, past the clone lane\'s own catch', async () => {
    const thrown = defect();
    getValidationResults.mockRejectedValueOnce(thrown);
    const entry: PluginEntry = { source: pathToFileURL(makeBareRepoWithSkill()).href, name: 'url-defect', ...META };

    await expect(auditOnePlugin(entry, { runDir: makeRunDir(), withReview: false, debug: false })).rejects.toBe(thrown);
  });

  it('still records a coded audit refusal as the entry\'s unloadable row', async () => {
    getValidationResults.mockRejectedValueOnce(new CommandRefusalError('INPUT_UNREADABLE', 'Path cannot be read (EACCES): x'));
    const entry: PluginEntry = { source: makePluginDir('A test skill whose audit is made to refuse in the runner unit test.'), name: 'local-refused', ...META };

    const row = await auditOnePlugin(entry, { runDir: makeRunDir(), withReview: false, debug: false });

    expect(row.audit).toMatchObject({ status: 'unloadable', error: 'Path cannot be read (EACCES): x' });
  });
});

describe('auditOnePlugin — validation overlay', () => {
  it('writes skills.defaults.validation into the audit target before audit runs', async () => {
    // Use a local plugin so we can inspect the overlay file post-audit.
    // Audit runs in-process so the file remains after auditOnePlugin returns
    // (cleanup is only for cloned tempdirs).
    const pluginDir = makePluginDir(
      'Skill that triggers a known warning we will silence via the validation overlay block.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = {
      source: pluginDir,
      name: 'overlay',
      ...META,
      validation: {
        severity: { LINK_TO_NAVIGATION_FILE: 'ignore' },
      },
    };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.validation_applied).toBe(true);

    const overlayPath = safePath.join(pluginDir, 'vibe-agent-toolkit.config.yaml');
    const written = yaml.parse(readFileSync(overlayPath, 'utf-8')) as Record<string, unknown>;
    expect((written.skills as Record<string, unknown>).defaults).toEqual({
      validation: { severity: { LINK_TO_NAVIGATION_FILE: 'ignore' } },
    });
  });

  it('does not write an overlay when validation is omitted', async () => {
    const pluginDir = makePluginDir(
      'Skill that triggers no warnings; no validation overlay should be written by the runner.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'no-overlay', ...META };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.validation_applied).toBe(false);
    const overlayPath = safePath.join(pluginDir, 'vibe-agent-toolkit.config.yaml');
    expect(existsSync(overlayPath)).toBe(false);
  });
});

function makeMultiSkillPluginDir(skillNames: string[]): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-multiskill-'));
  for (const name of skillNames) {
    const skillDir = safePath.join(root, 'plugins', name);
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Multi-skill plugin tree fixture skill ${name} that exercises the per-skill review enumeration code path.\n---\n\n# ${name}\n\nBody.\n`,
      'utf-8'
    );
  }
  return root;
}

async function runReviewedAudit(pluginDir: string, name: string): Promise<string> {
  const runDir = makeRunDir();
  const entry: PluginEntry = { source: pluginDir, name, ...META };
  const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });
  expect(row.review.status).toBe('ok');
  expect(row.review.output_path).toBe(`${name}-review.md`);
  // A real (subprocess-backed) clean run carries the distribution too.
  expect(row.review.summary?.failed).toBe(0);
  expect(row.review.summary?.reviewed).toBe(row.review.summary?.skills_scanned);
  return safePath.join(runDir, `${name}-review.md`);
}

describe('auditOnePlugin — --with-review', () => {
  it('writes an aggregated review.md and records review.status=ok when withReview is true', async () => {
    // Single-skill plugin tree: SKILL.md at the root. The runner now discovers
    // SKILL.md via discovery.scan() and reviews each skill directory, then
    // wraps results in an aggregated markdown file.
    const pluginDir = makeReviewablePluginDir(
      'reviewed',
      'Skill that runs the review pipeline end-to-end so the runner test exercises the with-review path.'
    );
    const reviewPath = await runReviewedAudit(pluginDir, 'reviewed');

    expect(existsSync(reviewPath)).toBe(true);
    const contents = readFileSync(reviewPath, 'utf-8');
    expect(contents).toContain('# Skill review: reviewed');
    expect(contents).toContain('Reviewed 1 of 1 skills');
    expect(contents).toContain('## SKILL.md');
  });

  it('reviews every SKILL.md in a multi-skill plugin tree', async () => {
    const pluginDir = makeMultiSkillPluginDir(['alpha', 'beta']);
    const reviewPath = await runReviewedAudit(pluginDir, 'multi');

    const contents = toForwardSlash(readFileSync(reviewPath, 'utf-8'));
    expect(contents).toContain('Reviewed 2 of 2 skills');
    expect(contents).toContain('## plugins/alpha/SKILL.md');
    expect(contents).toContain('## plugins/beta/SKILL.md');
  });

  it('records review.status=error when no SKILL.md is found under the source', async () => {
    // Both lanes see the same empty tree, and both must say so. The review lane
    // always did; the audit lane used to record `status: success` over
    // `files_scanned: 0` — "an empty tree audits cleanly" — which is the same
    // row a clean plugin produces. It is loadable (not `unloadable`: the path
    // exists and the audit ran), and it carries the non-overridable run-integrity
    // finding at error, because a row that audited nothing is not a verdict.
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-empty-'));
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: root, name: 'empty', ...META };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    expect(row.audit.status).toBe('findings');
    expect(row.audit.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(row.audit.files_scanned).toBe(0);
    expect(row.audit.findings_emitted).toBe(1);
    // The finding itself lives in the per-plugin audit report, beside the
    // (empty) file rows, so the row's counts are backed by a message.
    const auditDoc = AUDIT_REPORT_SCHEMA.parse(yaml.parse(readFileSync(safePath.join(runDir, 'empty-audit.yaml'), 'utf-8')));
    expect(auditDoc.data.files).toEqual([]);
    expect(auditDoc.findings.map((i) => [i.code, i.severity])).toEqual([[RUN_INTEGRITY_CODE, 'error']]);
    expect(auditDoc.findings[0]?.message).toContain('0 files');
    expect(row.review.status).toBe('error');
    expect(row.review.error).toMatch(/No SKILL\.md/i);
    expect(row.review.summary).toEqual({ skills_scanned: 0, reviewed: 0, failed: 0 });
  });

  it('records review.status=skipped when audit was unloadable', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = { source: '/does/not/exist', name: 'ghost', ...META };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    // Audit is unloadable so review is skipped (don't review what didn't audit)
    expect(row.audit.status).toBe('unloadable');
    expect(row.review.status).toBe('skipped');
    // Nothing ran, so there is no distribution to report.
    expect(row.review.summary).toBeUndefined();
  });
});

/**
 * One fixture builder, driven by a per-skill ok/fail pattern, so the
 * partially-failed and fully-successful runs differ ONLY in that pattern.
 */
function makeSections(oks: readonly boolean[]): SkillReviewSection[] {
  return oks.map((ok, index) => ({
    relativePath: `plugins/skill-${index}/SKILL.md`,
    ok,
    body: ok ? 'Review output.' : '**[review failed]**\n\nvat skill review exited with code 2',
  }));
}

const TEN_SKILLS = 10;

describe('unlistedDirectorySections', () => {
  // A directory the review scan could not list holds skills that were never
  // reviewed. It enters the aggregate on the existing per-skill channel — a
  // failed section, keyed by the directory — so `buildReviewOutcome` reports
  // the run as error and the review.md says which subtree is missing, while
  // every skill that WAS reviewed keeps its section. Never a shorter review.
  it('turns each refused directory into a failed section anchored at the directory', () => {
    const scanPath = safePath.resolve('/corpus/plugin');
    const sections = unlistedDirectorySections(
      [
        { kind: 'directory_unreadable', code: 'EACCES', directory: `${scanPath}/skills/locked`, transient: false },
        { kind: 'directory_unreadable', code: 'EMFILE', directory: scanPath, transient: true },
      ],
      scanPath,
    );

    expect(sections.map((s) => [s.relativePath, s.ok])).toEqual([
      ['skills/locked', false],
      ['.', false],
    ]);
    expect(sections[0]?.body).toContain('EACCES');
    expect(sections[0]?.body).toContain('not reviewed');
    expect(sections[1]?.body).toContain('transient');
    expect(buildReviewOutcome(sections, 'r.md', 1).status).toBe('error');
  });

  it('adds nothing when every directory was listed', () => {
    expect(unlistedDirectorySections([], '/corpus/plugin')).toEqual([]);
  });
});

describe('buildReviewOutcome', () => {
  it('reports the failure count and a non-success status when 9 of 10 reviews failed', () => {
    const sections = makeSections([true, ...Array.from<boolean>({ length: 9 }).fill(false)]);

    const outcome = buildReviewOutcome(sections, 'partial-review.md', 42);

    expect(outcome.summary).toEqual({ skills_scanned: TEN_SKILLS, reviewed: 1, failed: 9 });
    expect(outcome.status).not.toBe('ok');
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('9 of 10');
    expect(outcome.output_path).toBe('partial-review.md');
  });

  it('reports success with zero failures when every review ran to completion', () => {
    const sections = makeSections(Array.from<boolean>({ length: TEN_SKILLS }).fill(true));

    const outcome = buildReviewOutcome(sections, 'clean-review.md', 42);

    expect(outcome.summary).toEqual({ skills_scanned: TEN_SKILLS, reviewed: TEN_SKILLS, failed: 0 });
    expect(outcome.status).toBe('ok');
    expect(outcome.error).toBeUndefined();
    expect(outcome.output_path).toBe('clean-review.md');
  });

  it('still reports error when every review failed', () => {
    const sections = makeSections(Array.from<boolean>({ length: 3 }).fill(false));

    const outcome = buildReviewOutcome(sections, 'dead-review.md', 7);

    expect(outcome.summary).toEqual({ skills_scanned: 3, reviewed: 0, failed: 3 });
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('3 of 3');
  });
});

/** One per-file audit result carrying the given issues — the unit `files_scanned` counts. */
function auditResult(issues: Array<{ code: string; severity: 'error' | 'warning' | 'info' }>) {
  const published = issues.map((i) => ({ ...i, message: `${i.code} fired` }));
  return {
    path: safePath.resolve('/corpus-b/SKILL.md'),
    type: 'agent-skill',
    status: resultStatus(published),
    description: 'fixture',
    issues: published,
    summary: countBySeverity(published),
  };
}

/**
 * The pure half of the audit lane, so the zero-file refusal is pinned without
 * an audit on disk. The review lane already refused an empty tree; this is
 * the same function, on the same fixture, answering the same way.
 */
describe('buildAuditOutcome', () => {
  const ROOT = safePath.resolve('/corpus-b');

  it('refuses an audit over zero files as findings with ONE run-integrity finding', () => {
    // 🔑 The reproduced case. Delete the run-integrity pass and this reds: zero
    // results summarize to zero findings, and zero findings is `ok`.
    const { audit, document } = buildAuditOutcome([], 12, AUDIT_DOC, ROOT);

    expect(audit.status).toBe('findings');
    expect(audit.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(audit.files_scanned).toBe(0);
    expect(audit.findings_emitted).toBe(1);
    expect(audit.output_path).toBe(AUDIT_DOC);
    expect(AUDIT_REPORT_SCHEMA.parse(document).data.files).toEqual([]);
    expect(document.examined).toBe(0);
    expect(document.findings.map((f) => f.code)).toEqual([RUN_INTEGRITY_CODE]);
    expect(document.findings[0]?.severity).toBe('error');
  });

  it('says what did not run and what to do, without calling the plugin broken', () => {
    const { document } = buildAuditOutcome([], 12, AUDIT_DOC, ROOT);
    const message = document.findings[0]?.message ?? '';

    expect(message).toContain('0 files');
    expect(message).toContain('skills.include');
    expect(message).not.toMatch(/invalid plugin|broken skill/i);
  });

  it('stays silent over a populated audit, however clean', () => {
    // 🔑 The over-correction guard: a clean plugin must not start reporting
    // an error, and its document must carry no finding.
    const { audit, document } = buildAuditOutcome([auditResult([])], 12, AUDIT_DOC, ROOT);

    expect(audit.status).toBe('ok');
    expect(audit.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(audit.files_scanned).toBe(1);
    expect(audit.findings_emitted).toBe(0);
    expect(document.findings).toEqual([]);
  });

  it('rolls real findings up unchanged', () => {
    const { audit, document } = buildAuditOutcome(
      [auditResult([{ code: 'SKILL_DESCRIPTION_SHORT', severity: 'warning' }])],
      12,
      AUDIT_DOC,
      ROOT,
    );

    expect(audit.status).toBe('findings');
    expect(audit.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(audit.files_scanned).toBe(1);
    expect(audit.findings_emitted).toBe(1);
    // A finding with no `location` inherits its file's row path.
    expect(document.findings.map((f) => f.location)).toEqual(['SKILL.md']);
  });
});
