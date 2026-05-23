/**
 * LLM judge — Sonnet 4.6, temperature 0, forced tool use for structured output.
 *
 * Single-message call. The harness controls reproducibility by pinning the
 * model snapshot and the system-prompt file's git SHA in RunMetadata.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- system prompt path is constant */

import { readFileSync } from 'node:fs';

import Anthropic from '@anthropic-ai/sdk';
import { safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { getDirname } from '../../common.js';
import {
  JudgeResultSchema,
  JudgeVerdictSchema,
  type ExpectedBehavior,
  type JudgeResult,
  type RuntimeObservation,
} from '../types.js';

/**
 * The schema the Anthropic input_schema declares for the record_verdict tool.
 * Validated locally so a malformed model response produces a clear Zod error
 * with the offending field, not a TypeError on `undefined.slice` downstream.
 *
 * Strict because the tool's input_schema fully specifies what the model should
 * return — extras indicate a model bug we'd rather see than silently absorb.
 */
const ToolUseInputSchema = z
  .object({
    verdict: JudgeVerdictSchema,
    rationale: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();

const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 512;

const SYSTEM_PROMPT_PATH = safePath.join(
  getDirname(import.meta.url),
  'prompts',
  'judge-system.md',
);

let cachedSystemPrompt: string | undefined;

function getSystemPrompt(): string {
  cachedSystemPrompt ??= readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  return cachedSystemPrompt;
}

const RECORD_VERDICT_TOOL: Anthropic.Messages.Tool = {
  name: 'record_verdict',
  description: 'Record the judge\'s classification of the runtime transcript.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['completed', 'partial', 'failed', 'off-task'] },
      rationale: { type: 'string', maxLength: 240 },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['verdict', 'rationale', 'confidence'],
  },
};

function buildUserMessage(
  triggerPrompt: string,
  expected: ExpectedBehavior,
  obs: RuntimeObservation,
): string {
  const transcript = obs.outputText.trim() || '<empty transcript>';
  const toolUseLines = obs.toolUseEvents.length === 0
    ? '<no tool-use events captured>'
    : obs.toolUseEvents.map((t) => `- ${t.name}: ${t.inputSummary}`).join('\n');
  const errorLines = obs.errors.length === 0 ? '<none>' : obs.errors.map((e) => `- ${e}`).join('\n');

  return [
    `# User request (trigger prompt)`,
    triggerPrompt.trim(),
    '',
    `# Expected behavior`,
    expected.description.trim(),
    expected.invocationSignals.length > 0
      ? `Invocation signals (any of): ${expected.invocationSignals.join(', ')}`
      : '',
    '',
    `# Runtime facts`,
    `- target: ${obs.target}`,
    `- driverMode: ${obs.driverMode}`,
    `- exitStatus: ${obs.exitStatus}`,
    `- durationMs: ${obs.durationMs}`,
    `- invocationDetected: ${String(obs.invocationDetected)}`,
    '',
    `# Tool-use events`,
    toolUseLines,
    '',
    `# Errors`,
    errorLines,
    '',
    `# Transcript`,
    transcript,
  ].join('\n');
}

export interface JudgeOptions {
  triggerPrompt: string;
  expected: ExpectedBehavior;
  observation: RuntimeObservation;
  client: Anthropic;
  model?: string;
}

export async function judgeCompletion(options: JudgeOptions): Promise<JudgeResult> {
  const { triggerPrompt, expected, observation, client, model = DEFAULT_JUDGE_MODEL } = options;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: getSystemPrompt(),
    tools: [RECORD_VERDICT_TOOL],
    tool_choice: { type: 'tool', name: RECORD_VERDICT_TOOL.name },
    messages: [
      { role: 'user', content: buildUserMessage(triggerPrompt, expected, observation) },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (toolBlock?.type !== 'tool_use') {
    throw new Error(`judge response missing tool_use block (stop_reason=${String(response.stop_reason)})`);
  }

  const input = ToolUseInputSchema.parse(toolBlock.input);

  return JudgeResultSchema.parse({
    skillId: observation.skillId,
    target: observation.target,
    verdict: input.verdict,
    rationale: input.rationale.slice(0, 240),
    confidence: input.confidence,
    judgeModel: model,
  });
}

export function createJudgeClient(): Anthropic {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set; LLM judge cannot run.');
  }
  return new Anthropic({ apiKey });
}
