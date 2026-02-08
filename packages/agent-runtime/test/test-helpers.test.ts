/**
 * Contract tests for test-helpers.ts
 * Ensures the test helper API works correctly for adopting projects
 */

import type { AgentResult, StatefulAgentResult } from '@vibe-agent-toolkit/agent-schema';
import { describe, expect, it } from 'vitest';

import { resultMatchers } from '../src/test-helpers.js';

// Test constants to avoid duplication warnings
const TEST_ERROR_CODE = 'test-error';
const IN_PROGRESS_STATUS = 'in-progress';

describe('resultMatchers', () => {
  describe('expectSuccess', () => {
    it('should not throw for success result', () => {
      const result = { status: 'success' as const, data: { value: 42 } };

      expect(() => resultMatchers.expectSuccess(result)).not.toThrow();
    });

    it('should throw for error result', () => {
      const result: AgentResult<unknown, string> = { status: 'error', error: TEST_ERROR_CODE };

      expect(() => resultMatchers.expectSuccess(result)).toThrow();
    });

    it('should throw for in-progress result', () => {
      const result: StatefulAgentResult<unknown, string, unknown> = { status: IN_PROGRESS_STATUS };

      expect(() => resultMatchers.expectSuccess(result)).toThrow();
    });
  });

  describe('expectError', () => {
    it('should not throw for error result', () => {
      const result = { status: 'error' as const, error: TEST_ERROR_CODE };

      expect(() => resultMatchers.expectError(result)).not.toThrow();
    });

    it('should throw for success result', () => {
      const result: AgentResult<unknown, string> = { status: 'success', data: { value: 42 } };

      expect(() => resultMatchers.expectError(result)).toThrow();
    });

    it('should throw for in-progress result', () => {
      const result: StatefulAgentResult<unknown, string, unknown> = { status: IN_PROGRESS_STATUS };

      expect(() => resultMatchers.expectError(result)).toThrow();
    });
  });

  describe('expectInProgress', () => {
    it('should not throw for in-progress result', () => {
      const result: StatefulAgentResult<unknown, string, unknown> = { status: IN_PROGRESS_STATUS };

      expect(() => resultMatchers.expectInProgress(result)).not.toThrow();
    });

    it('should not throw for in-progress result with metadata', () => {
      const result: StatefulAgentResult<unknown, string, { step: number }> = { status: IN_PROGRESS_STATUS, metadata: { step: 1 } };

      expect(() => resultMatchers.expectInProgress(result)).not.toThrow();
    });

    it('should throw for success result', () => {
      const result: StatefulAgentResult<unknown, string, unknown> = { status: 'success', data: { value: 42 } };

      expect(() => resultMatchers.expectInProgress(result)).toThrow();
    });

    it('should throw for error result', () => {
      const result: StatefulAgentResult<unknown, string, unknown> = { status: 'error', error: TEST_ERROR_CODE };

      expect(() => resultMatchers.expectInProgress(result)).toThrow();
    });
  });
});
