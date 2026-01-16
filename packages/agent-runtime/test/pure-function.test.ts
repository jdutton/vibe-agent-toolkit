import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { definePureFunction } from '../src/pure-function.js';

import { addHandler, createAddAgentConfig } from './test-helpers.js';

const ADD_AGENT_NAME = 'add';
const ADD_AGENT_DESC = 'Adds two numbers';

describe('definePureFunction', () => {
  it('should create an agent with valid manifest', () => {
    const addAgent = definePureFunction(createAddAgentConfig(), addHandler);

    expect(addAgent.name).toBe(ADD_AGENT_NAME);
    expect(addAgent.manifest.name).toBe(ADD_AGENT_NAME);
    expect(addAgent.manifest.description).toBe(ADD_AGENT_DESC);
    expect(addAgent.manifest.version).toBe('1.0.0');
    expect(addAgent.manifest.archetype).toBe('pure-function');
    expect(addAgent.manifest.inputSchema).toBeDefined();
    expect(addAgent.manifest.outputSchema).toBeDefined();
    expect(addAgent.manifest.metadata).toBeUndefined();
  });

  it('should execute with valid input', () => {
    const addAgent = definePureFunction(createAddAgentConfig(), addHandler);

    const result = addAgent.execute({ a: 2, b: 3 });
    expect(result).toBe(5);
  });

  it('should throw error for invalid input', () => {
    const addAgent = definePureFunction(createAddAgentConfig(), addHandler);

    expect(() => addAgent.execute({ a: 'not a number', b: 3 } as never)).toThrow(
      `Invalid input for agent "${ADD_AGENT_NAME}"`,
    );
  });

  it('should throw error for invalid output', () => {
    const badAgent = definePureFunction(
      {
        name: 'bad-agent',
        description: 'Returns wrong type',
        version: '1.0.0',
        inputSchema: z.object({
          value: z.number(),
        }),
        outputSchema: z.number(),
      },
      () => 'not a number' as never,
    );

    expect(() => badAgent.execute({ value: 42 })).toThrow(
      'Invalid output from agent "bad-agent"',
    );
  });

  it('should include metadata in manifest', () => {
    const agent = definePureFunction(
      {
        name: 'test',
        description: 'Test agent',
        version: '1.0.0',
        inputSchema: z.string(),
        outputSchema: z.string(),
        metadata: {
          author: 'Test Author',
          tags: ['test', 'example'],
        },
      },
      (input) => input,
    );

    expect(agent.manifest.metadata).toEqual({
      author: 'Test Author',
      tags: ['test', 'example'],
    });
  });

  it('should handle complex nested schemas', () => {
    const agent = definePureFunction(
      {
        name: 'complex',
        description: 'Complex transformation',
        version: '1.0.0',
        inputSchema: z.object({
          user: z.object({
            name: z.string(),
            age: z.number(),
          }),
          tags: z.array(z.string()),
        }),
        outputSchema: z.object({
          summary: z.string(),
          count: z.number(),
        }),
      },
      (input) => ({
        summary: `${input.user.name} (${input.user.age})`,
        count: input.tags.length,
      }),
    );

    const result = agent.execute({
      user: { name: 'Alice', age: 30 },
      tags: ['a', 'b', 'c'],
    });

    expect(result).toEqual({
      summary: 'Alice (30)',
      count: 3,
    });
  });
});
