/**
 * LLM judge — Sonnet 4.6, subscription auth via `claude` CLI.
 *
 * Single-message call. The harness controls reproducibility by pinning the
 * model snapshot and the system-prompt file's git SHA in RunMetadata.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- system prompt path is constant */

import { readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { getDirname } from '../../common.js';
import { runClaudeSubscription, type ClaudeSpawnResult } from '../runtimes/shared/claude-cli.js';
import {
  JudgeCallArtifactSchema,
  JudgeResultSchema,
  type ExpectedBehavior,
  type JudgeCallArtifact,
  type JudgeResult,
  type JudgeVerdict,
  type RuntimeObservation,
} from '../types.js';

import { parseVerdictFromEnvelope } from './parse-verdict.js';

const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6';
const JUDGE_TIMEOUT_MS = 120_000;

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

/** Injectable so tests can stub the spawn without a real `claude` on PATH. */
export type ClaudeRunner = (args: string[], opts: { timeoutMs: number }) => Promise<ClaudeSpawnResult>;

const defaultRunner: ClaudeRunner = (args, opts) => runClaudeSubscription(args, opts);

/**
 * Shared call body for both the initial judge phase and the re-judge
 * subcommand. Both want the same `system + user → JSON verdict` round-trip;
 * the difference is what they do with the result and whether they persist a
 * verbatim artifact.
 */
async function executeRecordVerdictCall(args: {
  runClaude: ClaudeRunner;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<RecordVerdictCallResult> {
  const { runClaude, model, systemPrompt, userMessage } = args;
  const cliArgs = [
    '-p', userMessage,
    '--append-system-prompt', systemPrompt,
    '--model', model,
    '--output-format', 'json',
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runClaude(cliArgs, { timeoutMs: JUDGE_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      lastErr = new Error(`claude judge exited ${String(res.exitCode)}: ${res.stderr.slice(0, 500)}`);
      continue;
    }
    try {
      const parsed = parseVerdictFromEnvelope(res.stdout);
      return {
        verdict: parsed.verdict.verdict,
        rationale: parsed.verdict.rationale,
        confidence: parsed.verdict.confidence,
        responseContent: [parsed.envelope],
        responseUsage: parsed.usage,
        ...(parsed.sessionId === undefined ? {} : { requestId: parsed.sessionId }),
      };
    } catch (err) {
      lastErr = err; // malformed verdict — retry once
    }
  }
  throw new Error(`judge verdict unparseable after retry: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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
  runClaude?: ClaudeRunner;
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
    runClaude = defaultRunner,
    model = DEFAULT_JUDGE_MODEL,
    callsDir,
    judgePromptSha = 'unknown',
  } = options;

  const systemPrompt = getSystemPrompt();
  const userMessage = buildUserMessage(triggerPrompt, expected, observation);
  const call = await executeRecordVerdictCall({ runClaude, model, systemPrompt, userMessage });

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
  runClaude?: ClaudeRunner;
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
  const { artifact, runClaude = defaultRunner, model = artifact.judgeModel, systemPromptOverride } = options;
  const call = await executeRecordVerdictCall({
    runClaude,
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
