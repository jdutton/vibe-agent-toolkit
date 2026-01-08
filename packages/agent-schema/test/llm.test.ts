import { describe, expect, it } from 'vitest';


import { LLMConfigSchema } from '../src/llm';

const CLAUDE_SONNET_MODEL = 'claude-sonnet-4.5';

describe('LLMConfigSchema', () => {
  it('should validate basic LLM config', () => {
    const data = {
      provider: 'anthropic',
      model: CLAUDE_SONNET_MODEL,
    };

    const result = LLMConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate LLM config with parameters', () => {
    const data = {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 4096,
    };

    const result = LLMConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should validate LLM config with alternatives', () => {
    const data = {
      provider: 'anthropic',
      model: CLAUDE_SONNET_MODEL,
      alternatives: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'google', model: 'gemini-2.0-flash' },
      ],
    };

    const result = LLMConfigSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should reject temperature out of range', () => {
    const data = {
      provider: 'anthropic',
      model: CLAUDE_SONNET_MODEL,
      temperature: 2.5,
    };

    const result = LLMConfigSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
