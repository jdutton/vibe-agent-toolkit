/**
 * Unit tests for doctor command
 */

import { existsSync } from 'node:fs';

import { beforeEach, describe, it, vi } from 'vitest';

import {
  checkConfigFile,
  checkConfigValid,
  checkGitInstalled,
  checkGitRepository,
  checkNodeVersion,
} from '../../src/commands/doctor.js';
import {
  assertCheckFailed,
  assertCheckPassed,
  mockDoctorConfig,
  mockDoctorEnvironment,
  mockDoctorFileSystem,
} from '../helpers/vat-doctor-test-helpers.js';

// Mock modules before importing
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('@vibe-agent-toolkit/utils', () => ({
  getToolVersion: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('../../src/utils/config-loader.js', () => ({
  findConfigPath: vi.fn(),
  loadConfig: vi.fn(),
}));

// Constants
const CHECK_NODE_VERSION = 'Node.js version';
const CHECK_CONFIG_VALID = 'Configuration valid';

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
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true); // .git exists

      const result = checkGitRepository();

      assertCheckPassed(result, 'Git repository', 'git repository');
    });

    it('fails when not in git repository', async () => {
      await mockDoctorEnvironment();
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false); // No .git

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
});
