import { describe, expect, it } from 'vitest';

import { requestApproval, requestChoice, requestCustomApproval } from '../../src/external-event-integrator/human-approval.js';
import { createNumberValidator } from '../test-helpers.js';

const TIMEOUT_MESSAGE = 'Timed out';
const AUTO_APPROVED_MESSAGE = 'Auto-approved';
const THIS_WILL_TIMEOUT = 'This will timeout';
const MUST_BE_A_NUMBER = 'Must be a number';
const CHOOSE_AN_OPTION = 'Choose an option';
const ONLY_CHOICE = 'Only Choice';

describe('requestApproval', () => {
  it('should auto-approve when autoResponse is approve', async () => {
    const result = await requestApproval(
      'Should we proceed?',
      undefined,
      { autoResponse: 'approve' },
    );

    expect(result.approved).toBe(true);
    expect(result.reason).toContain(AUTO_APPROVED_MESSAGE);
  });

  it('should auto-reject when autoResponse is reject', async () => {
    const result = await requestApproval(
      'Should we proceed?',
      undefined,
      { autoResponse: 'reject' },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Auto-rejected');
  });

  it('should handle context object', async () => {
    const context = {
      name: 'Fluffy',
      reason: 'Testing approval',
    };

    const result = await requestApproval(
      'Approve this name?',
      context,
      { autoResponse: 'approve' },
    );

    expect(result.approved).toBe(true);
  });

  it('should timeout and reject by default', async () => {
    const result = await requestApproval(
      THIS_WILL_TIMEOUT,
      undefined,
      { timeoutMs: 100, onTimeout: 'reject' },
    );

    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toContain(TIMEOUT_MESSAGE);
  });

  it('should timeout and approve if configured', async () => {
    const result = await requestApproval(
      THIS_WILL_TIMEOUT,
      undefined,
      { timeoutMs: 100, onTimeout: 'approve' },
    );

    expect(result.approved).toBe(true);
    expect(result.timedOut).toBe(true);
  });

  it('should default to no timeout', async () => {
    const result = await requestApproval(
      'Quick test',
      undefined,
      { autoResponse: 'approve' },
    );

    expect(result.timedOut).toBeUndefined();
  });
});

describe('requestCustomApproval', () => {
  it('should validate response with custom validator', async () => {
    const validator = (response: string) => {
      if (response === 'magic') {
        return { valid: true, value: 42 };
      }
      return { valid: false, error: 'Wrong answer' };
    };

    const result = await requestCustomApproval(
      'What is the magic word?',
      validator,
      { autoResponse: 'magic' },
    );

    expect(result.approved).toBe(true);
    expect(result.value).toBe(42);
  });

  it('should reject invalid responses', async () => {
    const validator = (response: string) => {
      if (response === 'correct') {
        return { valid: true, value: 'success' };
      }
      return { valid: false, error: 'Invalid input' };
    };

    const result = await requestCustomApproval(
      'Enter correct',
      validator,
      { autoResponse: 'wrong' },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Invalid input');
    expect(result.value).toBeUndefined();
  });

  it('should handle timeout', async () => {
    const validator = (response: string) => ({ valid: true, value: response });

    const result = await requestCustomApproval(
      THIS_WILL_TIMEOUT,
      validator,
      { timeoutMs: 100 },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain(TIMEOUT_MESSAGE);
  });

  it('should provide custom error messages', async () => {
    const validator = createNumberValidator({ requirePositive: true });

    const result = await requestCustomApproval(
      'Enter a number',
      validator,
      { autoResponse: 'not-a-number' },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toBe(MUST_BE_A_NUMBER);
  });

  it('should accept valid custom responses', async () => {
    const validator = createNumberValidator();

    const result = await requestCustomApproval(
      'Enter a number',
      validator,
      { autoResponse: '42' },
    );

    expect(result.approved).toBe(true);
    expect(result.value).toBe(42);
  });
});

describe('requestChoice', () => {
  const options = ['Option A', 'Option B', 'Option C'];

  it('should accept choice by text', async () => {
    const result = await requestChoice(
      CHOOSE_AN_OPTION,
      options,
      { autoResponse: 'Option B' },
    );

    expect(result.approved).toBe(true);
    expect(result.choice).toBe('Option B');
  });

  it('should accept choice case-insensitively', async () => {
    const result = await requestChoice(
      CHOOSE_AN_OPTION,
      options,
      { autoResponse: 'option b' },
    );

    expect(result.approved).toBe(true);
    expect(result.choice).toBe('Option B');
  });

  it('should reject invalid choice text', async () => {
    const result = await requestChoice(
      CHOOSE_AN_OPTION,
      options,
      { autoResponse: 'Option D' },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Invalid');
  });

  it('should handle timeout', async () => {
    const result = await requestChoice(
      'Choose quickly',
      options,
      { timeoutMs: 100 },
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain(TIMEOUT_MESSAGE);
  });

  it('should accept single option', async () => {
    const result = await requestChoice(
      'Only one option',
      [ONLY_CHOICE],
      { autoResponse: ONLY_CHOICE },
    );

    expect(result.approved).toBe(true);
    expect(result.choice).toBe(ONLY_CHOICE);
  });

  it('should handle many options', async () => {
    const manyOptions = Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`);

    const result = await requestChoice(
      'Choose from many',
      manyOptions,
      { autoResponse: 'Option 7' },
    );

    expect(result.approved).toBe(true);
    expect(result.choice).toBe('Option 7');
  });
});
