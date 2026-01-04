/**
 * Unit tests for doctor command
 */

import { beforeEach, describe, it, vi } from 'vitest';

import { checkNodeVersion } from '../../src/commands/doctor.js';
import {
  assertCheckFailed,
  assertCheckPassed,
  mockDoctorEnvironment,
} from '../helpers/vat-doctor-test-helpers.js';

// Mock modules before importing
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
vi.mock('@vibe-agent-toolkit/utils', () => ({
  getToolVersion: vi.fn(),
}));

// Constants
const CHECK_NODE_VERSION = 'Node.js version';

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
});
