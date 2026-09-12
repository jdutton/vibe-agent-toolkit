/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable sonarjs/file-permissions -- `chmod 000` on a throwaway temp directory IS the
   fixture: this suite exists to prove the audit degrades on an unreadable path, and there is no way
   to produce one without setting the mode. The directory is created by `mkdtemp` under the system
   temp dir, is restored to 0755 in `afterAll` (rm -rf cannot clear a 000 directory otherwise), and
   never holds anything but the three files written here. */

/**
 * Regression, issue #180: one unreadable subdirectory used to abort the WHOLE
 * `vat audit` run — `status: error`, exit 2, and zero findings, discarding every
 * finding already collected from readable siblings. A single root-owned or
 * quarantined directory under `~/.claude/plugins` killed the flagship
 * `vat audit --user` invocation outright.
 *
 * `chmod 000` is the whole fixture, so these cases are POSIX-only: on Windows the
 * mode bits do not deny directory enumeration to the owning process, and the
 * fixture would silently assert nothing. They are skipped rather than rewritten
 * because the failure is about `readdir` raising `EACCES`, which is exactly what
 * Windows would not do here.
 *
 * The suite also refuses to run as root, where `chmod 000` is not a barrier at
 * all — without that guard these would pass by scanning the directory normally
 * and finding nothing to report, which looks identical to a working fix.
 */

import fs from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  deriveScanRoot,
  getValidationResults,
  resetAuditCaches,
} from '../../src/commands/audit.js';
import { runAuditCli } from '../test-helpers.js';

const silentLogger = {
  info: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

const UNREADABLE = 0o000;
const READABLE = 0o755;
const SKILL_DIR = 'demo';
const UNREADABLE_SUBDIR = 'sub';
const AGENT_INSTRUCTION_FILE = 'CLAUDE.md';

/** `chmod 000` denies nothing to uid 0 — see the file header. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

let tempDir: string;
let skillDir: string;
let unreadableDir: string;

/**
 * A skill tree with an agent-instruction file at its ROOT and a second one inside
 * a subdirectory that the tests then make unreadable. The root-level file is the
 * load-bearing half: it is the finding that must survive, and without it these
 * cases could not tell "degraded correctly" from "reported nothing at all".
 */
beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-unreadable-'));
  skillDir = safePath.join(tempDir, SKILL_DIR);
  unreadableDir = safePath.join(skillDir, UNREADABLE_SUBDIR);
  fs.mkdirSync(unreadableDir, { recursive: true });
  fs.writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill used to exercise the unreadable-path guard.\n---\n\n# Demo\n',
  );
  fs.writeFileSync(safePath.join(skillDir, AGENT_INSTRUCTION_FILE), '# guidance\n');
  fs.writeFileSync(safePath.join(unreadableDir, AGENT_INSTRUCTION_FILE), '# nested guidance\n');
});

afterAll(() => {
  // Restore the mode FIRST: `rm -rf` cannot remove a 000 directory's contents.
  if (fs.existsSync(unreadableDir)) fs.chmodSync(unreadableDir, READABLE);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function auditSkillDir() {
  resetAuditCaches();
  return getValidationResults(skillDir, true, {}, silentLogger, deriveScanRoot(skillDir));
}

describe.skipIf(CANNOT_DENY_READS)('vat audit with an unreadable subdirectory', () => {
  it('baseline: reports the agent-instruction file at both depths while readable', async () => {
    fs.chmodSync(unreadableDir, READABLE);
    const results = await auditSkillDir();

    const codes = results.flatMap(r => r.issues.map(i => i.code));
    expect(codes.filter(c => c === 'PACKAGED_AGENT_INSTRUCTION_FILE')).toHaveLength(2);
    expect(codes).not.toContain('SCAN_PATH_UNREADABLE');
  });

  it('keeps the readable siblings findings and names the directory it could not enter', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    const results = await auditSkillDir();

    const codes = results.flatMap(r => r.issues.map(i => i.code));
    // THE regression: this finding came from the readable root and used to be
    // destroyed along with everything else the run had collected.
    expect(codes).toContain('PACKAGED_AGENT_INSTRUCTION_FILE');
    // And the gap is stated rather than silently swallowed — a scan that reports
    // success while having skipped a subtree is the same failure shape as a
    // detector that quietly disables itself.
    expect(codes).toContain('SCAN_PATH_UNREADABLE');
  });

  it('degrades to warning rather than erroring the whole run', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    const results = await auditSkillDir();

    expect(results.some(r => r.status === 'error')).toBe(false);
    const unreadable = results.find(r => r.issues.some(i => i.code === 'SCAN_PATH_UNREADABLE'));
    expect(unreadable?.status).toBe('warning');
  });

  it('anchors the finding at the unreadable directory, relative to the scan root', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    const results = await auditSkillDir();

    const issue = results
      .flatMap(r => r.issues)
      .find(i => i.code === 'SCAN_PATH_UNREADABLE');
    expect(issue?.location).toBe(UNREADABLE_SUBDIR);
    // The OS text still reaches the operator — it distinguishes a permissions
    // problem from a vanished mount — but it is no longer the run's only output.
    expect(issue?.message).toMatch(/EACCES|permission denied/i);
  });

  // Two lanes meet this directory: the audit's own walk (`scanDirectory` reads it
  // and files the synthetic result) and the distributed-tree detector, which crawls
  // the skill's own directory at any depth and now reports what it could not list
  // rather than throwing or shortening. One fact, one finding.
  it('reports the unreadable directory exactly once, though two lanes reach it', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    const results = await auditSkillDir();

    const unreadable = results.flatMap(r => r.issues).filter(i => i.code === 'SCAN_PATH_UNREADABLE');
    expect(unreadable.map(i => i.location)).toEqual([UNREADABLE_SUBDIR]);
  });

  // The lane the walk never covers: naming the SKILL.md directly. There is no
  // directory scan at all, so the ONLY pass that meets `sub` is the detector's
  // crawl of the skill's own directory. Dropping its refusal because "the walk
  // already reports directories under the scan root" would be exactly wrong here —
  // nothing else reports it — and the same is true whenever the walk skips a
  // subtree the detector enters (`--no-recursive`, an ignored or excluded dir).
  it('reports the unreadable sibling exactly once when the SKILL.md is named directly', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    resetAuditCaches();
    const skillMd = safePath.join(skillDir, 'SKILL.md');

    const results = await getValidationResults(skillMd, true, {}, silentLogger, deriveScanRoot(skillMd));

    const codes = results.flatMap(r => r.issues.map(i => i.code));
    expect(codes).toContain('PACKAGED_AGENT_INSTRUCTION_FILE');
    expect(results.some(r => r.status === 'error')).toBe(false);
    const unreadable = results.flatMap(r => r.issues).filter(i => i.code === 'SCAN_PATH_UNREADABLE');
    expect(unreadable.map(i => i.location)).toEqual([UNREADABLE_SUBDIR]);
    expect(unreadable[0]?.message).toMatch(/EACCES/);
  });

  it('loses only the findings that were under the unreadable directory', async () => {
    fs.chmodSync(unreadableDir, UNREADABLE);
    const results = await auditSkillDir();

    const instructionFindings = results
      .flatMap(r => r.issues)
      .filter(i => i.code === 'PACKAGED_AGENT_INSTRUCTION_FILE');
    // One, not two: the nested copy genuinely could not be seen. Asserting the
    // exact count is what stops a future "fix" from papering over the gap by
    // reporting a file it never read.
    expect(instructionFindings).toHaveLength(1);
    expect(instructionFindings[0]?.location).toBe(AGENT_INSTRUCTION_FILE);
  });
});

/**
 * The other half of the same defect, and the one the first fix missed: guarding
 * only `readdir` left an unreadable FILE aborting the whole run exactly as
 * before. Under `~/.claude/plugins` — the flagship `vat audit --user` target,
 * populated by sudo installs and macOS quarantine — a root-owned FILE is at
 * least as likely as a root-owned directory.
 *
 * A separate tree from the suite above so the two failures cannot mask each
 * other: here every directory is readable and only a SKILL.md is not.
 */
describe.skipIf(CANNOT_DENY_READS)('vat audit with an unreadable file', () => {
  let fileTempDir: string;
  let scanRoot: string;
  let lockedSkillMd: string;

  beforeAll(() => {
    fileTempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-unreadable-file-'));
    scanRoot = safePath.join(fileTempDir, 'skills');
    const goodDir = safePath.join(scanRoot, 'good');
    const badDir = safePath.join(scanRoot, 'bad');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      safePath.join(goodDir, 'SKILL.md'),
      '---\nname: good\ndescription: A readable skill that must survive an unreadable sibling.\n---\n\n# Good\n',
    );
    // The finding that must survive — the load-bearing half, exactly as above.
    fs.writeFileSync(safePath.join(goodDir, AGENT_INSTRUCTION_FILE), '# guidance\n');
    lockedSkillMd = safePath.join(badDir, 'SKILL.md');
    fs.writeFileSync(
      lockedSkillMd,
      '---\nname: bad\ndescription: A skill whose SKILL.md cannot be opened by the scan.\n---\n\n# Bad\n',
    );
  });

  afterAll(() => {
    if (fs.existsSync(lockedSkillMd)) fs.chmodSync(lockedSkillMd, 0o644);
    fs.rmSync(fileTempDir, { recursive: true, force: true });
  });

  async function auditScanRoot() {
    resetAuditCaches();
    return getValidationResults(scanRoot, true, {}, silentLogger, deriveScanRoot(scanRoot));
  }

  it('baseline: both skills scan while the file is readable', async () => {
    fs.chmodSync(lockedSkillMd, 0o644);
    const results = await auditScanRoot();

    expect(results.flatMap(r => r.issues.map(i => i.code))).not.toContain('SCAN_PATH_UNREADABLE');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the readable siblings findings instead of aborting the run', async () => {
    fs.chmodSync(lockedSkillMd, UNREADABLE);
    const results = await auditScanRoot();

    const codes = results.flatMap(r => r.issues.map(i => i.code));
    // THE regression: this came from the readable sibling and used to be
    // destroyed along with every other finding the run had collected.
    expect(codes).toContain('PACKAGED_AGENT_INSTRUCTION_FILE');
    expect(codes).toContain('SCAN_PATH_UNREADABLE');
    expect(results.some(r => r.status === 'error')).toBe(false);
  });

  it('anchors the finding at the unreadable file itself', async () => {
    fs.chmodSync(lockedSkillMd, UNREADABLE);
    const results = await auditScanRoot();

    const issue = results.flatMap(r => r.issues).find(i => i.code === 'SCAN_PATH_UNREADABLE');
    expect(issue?.location).toBe('bad/SKILL.md');
    expect(issue?.message).toMatch(/EACCES|permission denied/i);
  });

  // The lane the first fix missed entirely. Guarding the directory walk left every
  // OTHER way into a validator unprotected — naming a `SKILL.md` directly is the
  // simplest of them, and it still ended the run with `status: error`, exit 2 and
  // zero findings. The suite could not have caught it: every case above scans a
  // DIRECTORY, so none of them reaches the dispatch path at all.
  it('degrades when the unreadable path is named directly, not reached by the walk', async () => {
    fs.chmodSync(lockedSkillMd, UNREADABLE);
    resetAuditCaches();

    const results = await getValidationResults(
      lockedSkillMd, true, {}, silentLogger, deriveScanRoot(lockedSkillMd),
    );

    expect(results.flatMap(r => r.issues).map(i => i.code)).toContain('SCAN_PATH_UNREADABLE');
    expect(results.some(r => r.status === 'error')).toBe(false);
  });

  // `issueLocation` is `path.relative`, so it answers '' when the subject IS the
  // anchor — which is the ordinary shape of `vat audit <that-path>`. It reached the
  // report as `location: ""` and rendered the detail as a bare ": EACCES …".
  it('never publishes an empty location, even when the scan target is the unreadable path', async () => {
    fs.chmodSync(lockedSkillMd, UNREADABLE);
    resetAuditCaches();

    const results = await getValidationResults(
      lockedSkillMd, true, {}, silentLogger, deriveScanRoot(lockedSkillMd),
    );

    const issue = results.flatMap(r => r.issues).find(i => i.code === 'SCAN_PATH_UNREADABLE');
    expect(issue?.location).toBeTruthy();
    expect(issue?.message).not.toMatch(/\(: /);
  });
});


/**
 * The CONFIG-AWARE half, which neither suite above can reach: both fixtures are
 * bare directories with no `vibe-agent-toolkit.config.yaml`, so skill discovery
 * never runs and the refusal it throws is never exercised.
 *
 * Under a config, `skills.include` is expanded by the crawler, and the crawler
 * REFUSES a directory it cannot list (`DirectoryListingRefusedError`) rather
 * than handing back a shorter list. That refusal used to be swallowed twice on
 * its way up — a bare `catch { return null; }` in `resolveSkillPackagingConfig`
 * and a `logger.debug` in `buildVATProjectContext` — so ONE `chmod 000` sibling
 * downgraded EVERY skill under the config to the weaker config-free validator:
 * `DESCRIPTION_TOO_VAGUE` vanished from a perfectly readable skill, the report
 * went `warning` → `success`, exit 0, and the directory was named only under
 * `--debug`. The contract `resolveGoverningConfig` documents for an unloadable
 * config — warn once on stderr AND file a finding — applies to a refused
 * discovery for the same reason, and this suite pins it on both lanes.
 *
 * Driven through the built CLI, not the in-process pipeline: stderr and the
 * top-level `status` are two of the assertions, and only the CLI publishes both.
 */
describe.skipIf(CANNOT_DENY_READS)('vat audit under a config whose skills.include reaches an unreadable directory', () => {
  const CONFIG_AWARE_CODE = 'DESCRIPTION_TOO_VAGUE';
  const LOCKED_DIR = 'locked';
  /** The stderr sentence `recordRefusedDiscovery` prints — matched by phrase, not by path, because
   *  the human findings summary on stderr also names `skills/locked/SKILL.md` while it is readable. */
  const DISCOVERY_WARNING = 'skipped an unreadable directory';
  let projectDir: string;
  let lockedDir: string;
  let alphaSkillMd: string;

  interface ReportIssue { code: string; location?: string }
  interface ReportFile { path: string; type: string; issues: ReportIssue[] }
  interface Report { status: string; files: ReportFile[] }

  /** Each lane's target and where it anchors the refused directory. */
  const lanes: Array<{ lane: string; target: () => string; expectedLocation: string; alphaPath: string }> = [
    { lane: 'directory', target: () => projectDir, expectedLocation: `skills/${LOCKED_DIR}`, alphaPath: 'skills/alpha/SKILL.md' },
    { lane: 'single-file', target: () => alphaSkillMd, expectedLocation: `../${LOCKED_DIR}`, alphaPath: 'SKILL.md' },
  ];

  function audit(target: string): { exit: number | null; stderr: string; report: Report } {
    const result = runAuditCli(target, ['--verbose']);
    return { exit: result.status, stderr: result.stderr, report: parseYaml(result.stdout) as Report };
  }

  function issuesWithCode(report: Report, code: string): ReportIssue[] {
    return report.files.flatMap((f) => f.issues).filter((i) => i.code === code);
  }

  function discoveryWarnings(stderr: string): string[] {
    return stderr.split('\n').filter((l) => l.includes(DISCOVERY_WARNING));
  }

  beforeAll(() => {
    projectDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-locked-include-'));
    fs.writeFileSync(
      safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\nskills:\n  include:\n    - "skills/*/SKILL.md"\n',
    );
    // `description: Short.` is the control: config-aware validation flags it as
    // DESCRIPTION_TOO_VAGUE and the config-free validator does not, so its
    // presence is what tells "validated under the config" from "downgraded".
    const write = (name: string): string => {
      const dir = safePath.join(projectDir, 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      const target = safePath.join(dir, 'SKILL.md');
      fs.writeFileSync(target, `---\nname: ${name}\ndescription: Short.\n---\n\n# ${name}\n\nBody.\n`);
      return target;
    };
    alphaSkillMd = write('alpha');
    write(LOCKED_DIR);
    lockedDir = safePath.join(projectDir, 'skills', LOCKED_DIR);
  });

  afterAll(() => {
    // Restore the mode FIRST: `rm -rf` cannot clear a 000 directory.
    if (fs.existsSync(lockedDir)) fs.chmodSync(lockedDir, READABLE);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it.each(lanes)('control ($lane lane): while every directory is readable, validation is config-aware and nothing is refused', ({ target }) => {
    fs.chmodSync(lockedDir, READABLE);
    const { exit, stderr, report } = audit(target());

    expect(exit).toBe(0);
    expect(issuesWithCode(report, CONFIG_AWARE_CODE).length).toBeGreaterThan(0);
    expect(issuesWithCode(report, 'SCAN_PATH_UNREADABLE')).toEqual([]);
    expect(discoveryWarnings(stderr)).toEqual([]);
  });

  it.each(lanes)('$lane lane: files the refusal once, on the directory, and the status says so', ({ target, expectedLocation }) => {
    fs.chmodSync(lockedDir, UNREADABLE);
    const { exit, report } = audit(target());

    // The audit contract: status carries the findings, the exit code says the run completed.
    expect(exit).toBe(0);
    expect(report.status).not.toBe('success');
    // In the directory lane TWO lanes meet `skills/locked` — the walk's per-entry
    // guard and the refused discovery — and the report must carry the fact once.
    // In the single-file lane there is no walk, so the refused discovery is the
    // ONLY report, anchored against the skill's own root.
    expect(issuesWithCode(report, 'SCAN_PATH_UNREADABLE').map((i) => i.location)).toEqual([expectedLocation]);
  });

  it.each(lanes)('$lane lane: warns once on stderr, naming the directory, WITHOUT --debug', ({ target }) => {
    fs.chmodSync(lockedDir, UNREADABLE);
    const { stderr } = audit(target());

    const warnings = discoveryWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`skills/${LOCKED_DIR}`);
    // ...and the remedy the crawler attaches, so the operator knows which knob is theirs.
    expect(warnings[0]).toContain('skills.include');
  });

  /** Audit `target` with the sibling locked and return alpha's row. */
  const alphaUnderLockedSibling = (target: () => string, alphaPath: string) => {
    fs.chmodSync(lockedDir, UNREADABLE);
    const { report } = audit(target());
    return report.files.find((f) => f.path === alphaPath);
  };

  it.each(lanes)('$lane lane: the readable skill is still validated, not dropped with the directory', ({ target, alphaPath }) => {
    expect(alphaUnderLockedSibling(target, alphaPath)?.type).toBe('agent-skill');
  });

  // THE regression as the operator sees it: the config loaded, alpha is readable
  // and declared, and yet one unreadable SIBLING cost it every config-aware check.
  // Making that loud (above) is necessary; keeping alpha under its config is the
  // rest of the fix — audit's config-aware lane hands `discoverSkillsFromConfig`
  // a degrade handler so discovery enumerates AROUND the refused directory
  // instead of refusing, and every other caller keeps the refuse-by-name default.
  it.each(lanes)('$lane lane: the readable skill keeps its config-aware finding despite the unreadable sibling', ({ target, alphaPath }) => {
    expect(alphaUnderLockedSibling(target, alphaPath)?.issues.map((i) => i.code)).toContain(CONFIG_AWARE_CODE);
  });
});
