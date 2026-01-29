import { RESULT_ERROR, RESULT_SUCCESS } from '@vibe-agent-toolkit/agent-schema';
import type { OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { describe, expect, it } from 'vitest';

import { ResultTranslator } from '../../src/server/result-translator.js';


describe('ResultTranslator', () => {
  const translator = new ResultTranslator();

  it('should translate success with structured data', () => {
    const agentOutput: OneShotAgentOutput<{ name: string; valid: boolean }, never> = {
      result: {
        status: RESULT_SUCCESS,
        data: { name: 'Fluffy', valid: true },
      },
    };

    const mcpResult = translator.toMCPResult(agentOutput);

    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content).toHaveLength(1);
    expect(mcpResult.content[0]?.type).toBe('text');
    expect(mcpResult.content[0]?.text).toContain('Fluffy');
    expect(mcpResult.content[0]?.text).toContain('true');
  });

  it('should translate success with reply field (conversational)', () => {
    const agentOutput = {
      result: {
        status: RESULT_SUCCESS,
        data: { reply: 'Hello! How can I help?' },
      },
    } as const;

    const mcpResult = translator.toMCPResult(agentOutput);

    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0]?.text).toBe('Hello! How can I help?');
  });

  it('should translate error', () => {
    const agentOutput: OneShotAgentOutput<never, 'llm-timeout'> = {
      result: {
        status: RESULT_ERROR,
        error: 'llm-timeout',
      },
    };

    const mcpResult = translator.toMCPResult(agentOutput);

    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content[0]?.text).toContain('llm-timeout');
    expect(mcpResult.content[0]?.text).toContain('Error');
  });

  it('should include confidence and warnings if present', () => {
    const agentOutput: OneShotAgentOutput<{ value: string }, never> = {
      result: {
        status: RESULT_SUCCESS,
        data: { value: 'test' },
        confidence: 0.85,
        warnings: ['Low confidence in parsing'],
      },
    };

    const mcpResult = translator.toMCPResult(agentOutput);

    expect(mcpResult.content[0]?.text).toContain('Confidence: 0.85');
    expect(mcpResult.content[0]?.text).toContain('Warnings:');
    expect(mcpResult.content[0]?.text).toContain('Low confidence in parsing');
  });
});
