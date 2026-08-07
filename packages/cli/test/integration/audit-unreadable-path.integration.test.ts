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

import {
  deriveScanRoot,
  getValidationResults,
  resetAuditCaches,
} from '../../src/commands/audit.js';

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
