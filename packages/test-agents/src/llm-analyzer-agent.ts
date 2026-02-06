/**
 * Simple LLM Analyzer Agent for Testing
 *
 * A minimal LLM-based agent that generates creative names.
 * Used to test runtime adapters' LLM analyzer conversion.
 */

import { defineLLMAnalyzer } from '@vibe-agent-toolkit/agent-runtime';

import { SimpleNameInputSchema, SimpleNameOutputSchema } from './schemas.js';

/**
 * System prompt for the name generator
 */
const SYSTEM_PROMPT = `You are a creative name generator. Given an adjective and a noun,
create a creative name that combines them in an interesting way.
Provide brief reasoning for your choice.

Examples:
- Adjective: "Swift", Noun: "River" → "Rivermist" (evokes flowing water with speed)
- Adjective: "Golden", Noun: "Mountain" → "Auric Peak" (golden mountain in classical style)`;

/**
 * Simple name generator - requires LLM to execute
 */
export const simpleNameGeneratorAgent = defineLLMAnalyzer(
  {
    name: 'simple-name-generator',
    description: 'Generates creative names by combining an adjective and noun',
    version: '1.0.0',
    inputSchema: SimpleNameInputSchema,
    outputSchema: SimpleNameOutputSchema,
    mockable: true,
  },
  async (input, ctx) => {
    const prompt = `${SYSTEM_PROMPT}

Now generate a creative name:
Adjective: "${input.adjective}"
Noun: "${input.noun}"

Respond with JSON: { "name": "...", "reasoning": "..." }`;

    const response = await ctx.callLLM(prompt);
    return JSON.parse(response);
  },
);

export type SimpleNameGeneratorAgent = typeof simpleNameGeneratorAgent;
