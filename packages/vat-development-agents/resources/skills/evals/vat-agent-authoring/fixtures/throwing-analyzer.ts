import { z } from 'zod';

import type { AgentContext } from '@vibe-agent-toolkit/agent-runtime';

const OutputSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
});

type SentimentResult = z.infer<typeof OutputSchema>;

// One LLM call to classify the sentiment of a support ticket.
export async function analyzeSentiment(
  text: string,
  context: AgentContext,
): Promise<SentimentResult> {
  let response: string;

  try {
    response = await context.callLLM([
      { role: 'user', content: `Classify the sentiment of: "${text}"` },
    ]);
  } catch (err) {
    // Let the caller deal with it.
    throw new Error(`sentiment LLM call failed: ${(err as Error).message}`);
  }

  // If the model hands back something that isn't the JSON we asked for,
  // JSON.parse / schema parse will throw straight out of here.
  return OutputSchema.parse(JSON.parse(response));
}

// How a route handler uses it today.
export async function handleTicket(text: string, context: AgentContext) {
  const result = await analyzeSentiment(text, context);
  return { routedTo: result.sentiment === 'negative' ? 'priority-queue' : 'normal-queue' };
}
