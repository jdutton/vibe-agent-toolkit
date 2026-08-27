/**
 * Unit tests for doctor command
 */

import { existsSync, readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkCliBuildSync,
  checkConfigFile,
  checkConfigValid,
  checkGitInstalled,
  checkGitRepository,
  checkNodeVersion,
  checkVatVersion,
  countByOutcome,
  formatDoctorSummary,
  selectDisplayChecks,
  type DoctorCheckResult,
} from '../../src/commands/doctor.js';
import {
  assertCheck,
  assertCheckFailed,
  assertCheckPassed,
  assertCheckSkipped,
  assertCheckUndetermined,
  mockDoctorConfig,
  mockDoctorEnvironment,
  mockDoctorFileSystem,
} from '../helpers/vat-doctor-test-helpers.js';

// Mock modules before importing
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('@vibe-agent-toolkit/utils/process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getToolVersion: vi.fn(),
  };
});
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('../../src/utils/config-loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Constants
const CHECK_NODE_VERSION = 'Node.js version';
const CHECK_CONFIG_VALID = 'Configuration valid';
const CHECK_VAT_VERSION = 'vat version';
const CHECK_CLI_BUILD = 'CLI build status';
const CLI_PACKAGE_NAME = '@vibe-agent-toolkit/cli';
const UNREADABLE = 'EACCES: permission denied';
const ADVISORY_CHECK = 'p3-advisory';

describe('doctor command - unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkNodeVersion', () => {
    it('passes when Node.js >= 20', async () => {
      await mockDoctorEnvironment({ nodeVersion: 'v22.0.0' });

      const result = checkNodeVersion();

      assertCheckPassed(result, CHECK_NODE_VERSION, 'v22.0.0');
      assertCheckPassed(result, CHECK_NODE_VERSION, 'meets requirement');
    });

    it('passes when Node.js = 20', async () => {
      await mockDoctorEnvironment({ nodeVersion: 'v20.0.0' });

      const result = checkNodeVersion();

      assertCheckPassed(result, CHECK_NODE_VERSION, 'v20.0.0');
    });

    it('fails when Node.js < 20', async () => {
      await mockDoctorEnvironment({ nodeVersion: 'v18.0.0' });

      const result = checkNodeVersion();

      assertCheckFailed(
        result,
        CHECK_NODE_VERSION,
        'too old',
        'https://nodejs.org',
      );
    });

    it('fails when Node.js not detected', async () => {
      await mockDoctorEnvironment({ nodeVersion: null });

      const result = checkNodeVersion();

      assertCheckFailed(result, CHECK_NODE_VERSION, 'Not detected', 'Install');
    });
  });

  describe('checkGitInstalled', () => {
    it('passes when git is installed', async () => {
      await mockDoctorEnvironment({ gitVersion: 'git version 2.43.0' });

      const result = checkGitInstalled();

      assertCheckPassed(result, 'Git installed', '2.43.0');
    });

    it('fails when git not installed', async () => {
      await mockDoctorEnvironment({ gitVersion: null });

      const result = checkGitInstalled();

      assertCheckFailed(
        result,
        'Git installed',
        'not installed',
        'https://git-scm.com',
      );
    });
  });

  describe('checkGitRepository', () => {
    it('passes when in git repository', async () => {
      await mockDoctorEnvironment();
      vi.mocked(existsSync).mockReturnValue(true); // .git exists

      const result = checkGitRepository();

      assertCheckPassed(result, 'Git repository', 'git repository');
    });

    it('fails when not in git repository', async () => {
      await mockDoctorEnvironment();
      vi.mocked(existsSync).mockReturnValue(false); // No .git

      const result = checkGitRepository();

      assertCheckFailed(
        result,
        'Git repository',
        'not a git repository',
        'git init',
      );
    });
  });

  describe('checkConfigFile', () => {
    it('passes when config exists', async () => {
      await mockDoctorFileSystem({ configExists: true });

      const result = checkConfigFile();

      assertCheckPassed(result, 'Configuration file', 'Found');
    });

    it('fails when config not found', async () => {
      await mockDoctorFileSystem({ configExists: false });

      const result = checkConfigFile();

      assertCheckFailed(
        result,
        'Configuration file',
        'not found',
        'vibe-agent-toolkit.config.yaml',
      );
    });
  });

  describe('checkConfigValid', () => {
    it('passes when config is valid', async () => {
      await mockDoctorFileSystem({ configExists: true });
      const cleanup = await mockDoctorConfig({ valid: true });

      const result = checkConfigValid();

      assertCheckPassed(result, CHECK_CONFIG_VALID, 'valid');
      cleanup();
    });

    it('fails when config has errors', async () => {
      await mockDoctorFileSystem({ configExists: true });
      const cleanup = await mockDoctorConfig({
        valid: false,
        errors: ['YAML syntax error'],
      });

      const result = checkConfigValid();

      assertCheckFailed(
        result,
        CHECK_CONFIG_VALID,
        'errors',
        'Fix YAML syntax',
      );
      cleanup();
    });

    it('fails when config not found', async () => {
      await mockDoctorFileSystem({ configExists: false });

      const result = checkConfigValid();

      assertCheckFailed(
        result,
        CHECK_CONFIG_VALID,
        'not found',
        'Create vibe-agent-toolkit.config.yaml',
      );
    });
  });

  describe('checkVatVersion', () => {
    it('shows up to date when current equals latest', async () => {
      await mockDoctorFileSystem({ packageVersion: '0.1.0' });
      const versionChecker = {
        fetchLatestVersion: vi.fn().mockResolvedValue('0.1.0'),
      };

      const result = await checkVatVersion(versionChecker);

      assertCheckPassed(result, CHECK_VAT_VERSION, 'up to date');
      expect(versionChecker.fetchLatestVersion).toHaveBeenCalled();
    });

    it('shows advisory when update available', async () => {
      await mockDoctorFileSystem({ packageVersion: '0.1.0' });
      const versionChecker = {
        fetchLatestVersion: vi.fn().mockResolvedValue('0.2.0'),
      };

      const result = await checkVatVersion(versionChecker);

      assertCheck(result, CHECK_VAT_VERSION, {
        outcome: 'pass', // Advisory only
        messageContains: ['0.1.0', '0.2.0', 'available'],
        suggestionContains: 'npm install -g',
      });
    });

    it('shows ahead when current is newer', async () => {
      await mockDoctorFileSystem({ packageVersion: '0.3.0' });
      const versionChecker = {
        fetchLatestVersion: vi.fn().mockResolvedValue('0.2.0'),
      };

      const result = await checkVatVersion(versionChecker);

      assertCheck(result, CHECK_VAT_VERSION, {
        outcome: 'pass',
        messageContains: ['0.3.0', 'ahead'],
      });
    });

    it('reports UNDETERMINED (not pass) when npm is unreachable', async () => {
      await mockDoctorFileSystem({ packageVersion: '0.1.0' });
      const versionChecker = {
        fetchLatestVersion: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      const result = await checkVatVersion(versionChecker);

      assertCheckUndetermined(result, CHECK_VAT_VERSION, 'Unable to check');
    });

    it('reports UNDETERMINED when the local version cannot be read', async () => {
      vi.mocked(readFileSync).mockImplementation((): string => {
        throw new Error(UNREADABLE);
      });
      const versionChecker = {
        fetchLatestVersion: vi.fn().mockResolvedValue('0.2.0'),
      };

      const result = await checkVatVersion(versionChecker);

      assertCheckUndetermined(result, CHECK_VAT_VERSION, 'Unable to determine version');
    });
  });

  describe('checkCliBuildSync', () => {
    const FAKE_PROJECT_ROOT = '/fake/project/root';

    it('passes when CLI version matches source', async () => {
      await mockDoctorFileSystem({
        isVatSourceTree: true,
        packageVersion: '0.1.0',
      });

      const result = checkCliBuildSync(FAKE_PROJECT_ROOT);

      assertCheckPassed(result, CHECK_CLI_BUILD, 'up to date');
    });

    it('fails when CLI is stale', async () => {
      // Mock: source has v0.2.0, running CLI has v0.1.0
      // The challenge is that both paths read the same file in reality,
      // but we need to differentiate them for testing.
      // Running version is read via file:// URL, source is read via safePath.join()
      let readCallCount = 0;
      vi.mocked(readFileSync).mockImplementation((path): string => {
        const locationStr = path.toString();
        readCallCount++;

        // First call: running CLI version (via URL - contains file://)
        // Second call: source version (via join - no file://)
        if (readCallCount === 1 || locationStr.startsWith('file://')) {
          // Running CLI has old version
          return JSON.stringify({
            name: CLI_PACKAGE_NAME,
            version: '0.1.0'
          });
        }
        // Source has newer version
        return JSON.stringify({
          name: CLI_PACKAGE_NAME,
          version: '0.2.0'
        });
      });
      vi.mocked(existsSync).mockReturnValue(true);

      const result = checkCliBuildSync(FAKE_PROJECT_ROOT);

      assertCheckFailed(
        result,
        CHECK_CLI_BUILD,
        'stale',
        'bun run build'
      );
    });

    it('skips when not in VAT source tree', async () => {
      await mockDoctorFileSystem({ isVatSourceTree: false });

      const result = checkCliBuildSync(FAKE_PROJECT_ROOT);

      assertCheckSkipped(result, CHECK_CLI_BUILD, 'not in VAT source tree');
    });

    it('skips when projectRoot is null', () => {
      const result = checkCliBuildSync(null);

      assertCheckSkipped(result, CHECK_CLI_BUILD, 'no project root');
    });

    it('reports UNDETERMINED (not pass) when the version files cannot be read', async () => {
      // In the VAT source tree, but reading package.json blows up: the build
      // may or may not be stale and we cannot tell. "Could not tell" must not
      // render as a passing check.
      vi.mocked(existsSync).mockReturnValue(true);
      let call = 0;
      vi.mocked(readFileSync).mockImplementation((): string => {
        call++;
        // First read is isVatSourceTree's probe — let it confirm the source tree.
        if (call === 1) {
          return JSON.stringify({ name: CLI_PACKAGE_NAME, version: '0.1.0' });
        }
        throw new Error(UNREADABLE);
      });

      const result = checkCliBuildSync(FAKE_PROJECT_ROOT);

      assertCheckUndetermined(result, CHECK_CLI_BUILD, 'Could not determine build status');
    });

    it('reports UNDETERMINED when source-tree membership itself cannot be determined', async () => {
      // The `.../packages/cli/package.json` probe exists but is unreadable:
      // we cannot tell whether this is the VAT source tree, which is NOT the
      // same answer as "it is not the VAT source tree".
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((): string => {
        throw new Error(UNREADABLE);
      });

      const result = checkCliBuildSync(FAKE_PROJECT_ROOT);

      assertCheckUndetermined(result, CHECK_CLI_BUILD, 'Could not determine');
    });
  });

  describe('outcome accounting (the rendered list must match the count)', () => {
    const check = (
      name: string,
      outcome: DoctorCheckResult['outcome'],
      suggestion?: string,
    ): DoctorCheckResult => ({
      name,
      outcome,
      message: `${name} message`,
      ...(suggestion === undefined ? {} : { suggestion }),
    });

    const MIXED: DoctorCheckResult[] = [
      check('p1', 'pass'),
      check('p2', 'pass'),
      check(ADVISORY_CHECK, 'pass', 'upgrade something'),
      check('f1', 'fail', 'fix it'),
      check('u1', 'undetermined'),
      check('s1', 'skipped'),
    ];

    it('counts every outcome bucket', () => {
      expect(countByOutcome(MIXED)).toEqual({
        pass: 3,
        fail: 1,
        undetermined: 1,
        skipped: 1,
      });
    });

    it('counts sum to the number of checks', () => {
      const counts = countByOutcome(MIXED);
      const sum = counts.pass + counts.fail + counts.undetermined + counts.skipped;
      expect(sum).toBe(MIXED.length);
    });

    it('verbose display shows every check', () => {
      expect(selectDisplayChecks(MIXED, true).map(c => c.name)).toEqual([
        'p1',
        'p2',
        ADVISORY_CHECK,
        'f1',
        'u1',
        's1',
      ]);
    });

    it('concise display keeps failures, undetermined, and advisories', () => {
      expect(selectDisplayChecks(MIXED, false).map(c => c.name)).toEqual([
        ADVISORY_CHECK,
        'f1',
        'u1',
      ]);
    });

    it('summary states how many checks it hid, so the count cannot contradict the list', () => {
      const displayed = selectDisplayChecks(MIXED, false);
      const summary = formatDoctorSummary(countByOutcome(MIXED), displayed.length).join('\n');

      expect(summary).toContain('6 checks');
      expect(summary).toContain('3 passed');
      expect(summary).toContain('1 failed');
      expect(summary).toContain('1 undetermined');
      expect(summary).toContain('1 skipped');
      // 6 checks, 3 rendered → the reader is told about the other 3.
      expect(summary).toContain('3 not shown');
    });

    it('does not claim hidden checks when every check is rendered', () => {
      const displayed = selectDisplayChecks(MIXED, true);
      const summary = formatDoctorSummary(countByOutcome(MIXED), displayed.length).join('\n');

      expect(summary).not.toContain('not shown');
    });

    it('an all-passing concise run says every check is hidden rather than showing none silently', () => {
      const allPass = [check('a', 'pass'), check('b', 'pass')];
      const displayed = selectDisplayChecks(allPass, false);
      const summary = formatDoctorSummary(countByOutcome(allPass), displayed.length).join('\n');

      expect(displayed).toEqual([]);
      expect(summary).toContain('2 checks');
      expect(summary).toContain('2 not shown');
    });

    it('never reports an undetermined check as healthy', () => {
      const counts = countByOutcome([check('u', 'undetermined'), check('p', 'pass')]);
      const summary = formatDoctorSummary(counts, 2).join('\n');

      expect(summary).not.toContain('All checks passed');
      expect(summary).toContain('could not be determined');
    });

    it('says all checks passed only when they all actually passed', () => {
      const counts = countByOutcome([check('a', 'pass'), check('b', 'pass')]);
      const summary = formatDoctorSummary(counts, 2).join('\n');

      expect(summary).toContain('All checks passed');
    });
  });
});
