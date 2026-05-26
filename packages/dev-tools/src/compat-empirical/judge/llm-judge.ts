/**
 * LLM judge — Sonnet 4.6, temperature 0, forced tool use for structured output.
 *
 * Single-message call. The harness controls reproducibility by pinning the
 * model snapshot and the system-prompt file's git SHA in RunMetadata.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- system prompt path is constant */

import { readFileSync, writeFileSync } from 'node:fs';

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { getDirname } from '../../common.js';
import {
  JudgeCallArtifactSchema,
  JudgeResultSchema,
  JudgeVerdictSchema,
  type ExpectedBehavior,
  type JudgeCallArtifact,
  type JudgeResult,
  type JudgeVerdict,
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
      verdict: { type: 'string', enum: ['completed', 'partial', 'failed', 'off-task', 'refused'] },
      rationale: { type: 'string', maxLength: 240 },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['verdict', 'rationale', 'confidence'],
  },
};

const STDERR_PREVIEW_LIMIT = 500;

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
  const installLine = obs.installResult.ok ? 'ok' : `failed: ${obs.installResult.notes}`;
  // Pull stderr from the existing errors[] payload — the scripted driver
  // includes stderr in errors[] when exitStatus === 'error'.
  const stderrPreview = obs.errors.slice(0, 3).join('\n').slice(0, STDERR_PREVIEW_LIMIT);

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
    `# Install result`,
    installLine,
    '',
    `# Tool-use events`,
    toolUseLines,
    '',
    `# Errors`,
    errorLines,
    '',
    `# Stderr preview`,
    stderrPreview || '<none>',
    '',
    `# Transcript`,
    transcript,
  ].join('\n');
}

interface RecordVerdictCallResult {
  verdict: JudgeVerdict;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  responseContent: unknown[];
  responseUsage: unknown;
  requestId?: string;
}

/**
 * Shared call body for both the initial judge phase and the re-judge
 * subcommand. Both want the same `system + user → record_verdict tool_use`
 * round-trip; the difference is what they do with the result and whether
 * they persist a verbatim artifact.
 */
async function executeRecordVerdictCall(args: {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<RecordVerdictCallResult> {
  const { client, model, systemPrompt, userMessage } = args;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: systemPrompt,
    tools: [RECORD_VERDICT_TOOL],
    tool_choice: { type: 'tool', name: RECORD_VERDICT_TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (toolBlock?.type !== 'tool_use') {
    throw new Error(`judge response missing tool_use block (stop_reason=${String(response.stop_reason)})`);
  }
  const input = ToolUseInputSchema.parse(toolBlock.input);
  // The Anthropic SDK puts request_id on the response object as `_request_id`.
  const requestId = (response as { _request_id?: string })._request_id;
  return {
    verdict: input.verdict,
    rationale: input.rationale.slice(0, 240),
    confidence: input.confidence,
    responseContent: response.content as unknown[],
    responseUsage: response.usage,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * Persist a JudgeCallArtifact to `${callsDir}/${baseName}.json`. The caller
 * supplies the directory and filename so this helper stays unaware of the
 * specific layout owned by the index.ts orchestrator.
 */
function persistJudgeCall(
  callsDir: string,
  artifact: JudgeCallArtifact,
  baseName: string,
): string {
  mkdirSyncReal(callsDir, { recursive: true });
  const filePath = safePath.join(callsDir, `${baseName}.json`);
  writeFileSync(filePath, JSON.stringify(JudgeCallArtifactSchema.parse(artifact), null, 2), 'utf8');
  return filePath;
}

export interface JudgeOptions {
  triggerPrompt: string;
  expected: ExpectedBehavior;
  observation: RuntimeObservation;
  client: Anthropic;
  model?: string;
  /**
   * When set, judgeCompletion writes the verbatim system+user+response
   * artifact to `${callsDir}/<skillId>-<promptId>-<target>-<attemptIdx>.json`
   * and stamps `judgeCallRef` on the returned JudgeResult with a relative
   * path (`judge-calls/<basename>.json`) so the matrix layer can link cells
   * back to their replay artifact.
   */
  callsDir?: string;
  /** SHA pinning the judge-system.md content at the time of the call. */
  judgePromptSha?: string;
}

function judgeCallBaseName(observation: RuntimeObservation): string {
  return `${observation.skillId}-${observation.promptId}-${observation.target}-${observation.attemptIdx}`;
}

export async function judgeCompletion(options: JudgeOptions): Promise<JudgeResult> {
  const {
    triggerPrompt,
    expected,
    observation,
    client,
    model = DEFAULT_JUDGE_MODEL,
    callsDir,
    judgePromptSha = 'unknown',
  } = options;

  const systemPrompt = getSystemPrompt();
  const userMessage = buildUserMessage(triggerPrompt, expected, observation);
  const call = await executeRecordVerdictCall({ client, model, systemPrompt, userMessage });

  let judgeCallRef: string | undefined;
  if (callsDir) {
    const baseName = judgeCallBaseName(observation);
    persistJudgeCall(callsDir, {
      skillId: observation.skillId,
      target: observation.target,
      promptId: observation.promptId,
      attemptIdx: observation.attemptIdx,
      judgeModel: model,
      judgePromptSha,
      systemPrompt,
      userMessage,
      responseContent: call.responseContent,
      responseUsage: call.responseUsage,
      ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
    }, baseName);
    judgeCallRef = `judge-calls/${baseName}.json`;
  }

  return JudgeResultSchema.parse({
    skillId: observation.skillId,
    target: observation.target,
    verdict: call.verdict,
    rationale: call.rationale,
    confidence: call.confidence,
    judgeModel: model,
    ...(judgeCallRef === undefined ? {} : { judgeCallRef }),
  });
}

export interface ReJudgeOptions {
  artifact: JudgeCallArtifact;
  client: Anthropic;
  /** Model to re-judge against — may differ from artifact.judgeModel. */
  model?: string;
  /**
   * Override the persisted system prompt (e.g., to A/B against a freshly
   * edited judge-system.md). When omitted, the persisted systemPrompt is
   * used verbatim so a re-judge with the same model and same SHA yields the
   * same verdict modulo model nondeterminism.
   */
  systemPromptOverride?: string;
}

/**
 * Re-execute a persisted judge call against a (possibly different) model or
 * system prompt. Returns a fresh JudgeResult; the caller decides whether to
 * write it to a separate `judgments-rerun.json` so the original `judgments.json`
 * stays diffable.
 */
export async function reJudgeCompletion(options: ReJudgeOptions): Promise<JudgeResult> {
  const { artifact, client, model = artifact.judgeModel, systemPromptOverride } = options;
  const call = await executeRecordVerdictCall({
    client,
    model,
    systemPrompt: systemPromptOverride ?? artifact.systemPrompt,
    userMessage: artifact.userMessage,
  });
  return JudgeResultSchema.parse({
    skillId: artifact.skillId,
    target: artifact.target,
    verdict: call.verdict,
    rationale: call.rationale,
    confidence: call.confidence,
    judgeModel: model,
  });
}

/** Re-read the on-disk system prompt — used by `re-judge` to A/B against an edited prompt. */
export function readCurrentSystemPrompt(): string {
  return readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
}

export function createJudgeClient(): Anthropic {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set; LLM judge cannot run.');
  }
  return new Anthropic({ apiKey });
}
