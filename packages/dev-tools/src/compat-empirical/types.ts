/**
 * Zod schemas for the empirical compat harness.
 *
 * Strict per Postel's Law — VAT produces this data, so unknown fields are bugs.
 * Schemas mirror the design at docs/research/2026-MM-DD-runtime-compatibility-empirical.md.
 */

import { z } from 'zod';

export const TargetSchema = z.enum(['claude-chat', 'claude-cowork', 'claude-code']);
export type Target = z.infer<typeof TargetSchema>;

export const BucketSchema = z.enum(['own', 'official', 'community']);
export type Bucket = z.infer<typeof BucketSchema>;

export const DriverModeSchema = z.enum(['scripted', 'scripted-assisted', 'manual']);
export type DriverMode = z.infer<typeof DriverModeSchema>;

export const ExitStatusSchema = z.enum(['completed', 'timeout', 'error', 'user-aborted', 'skipped']);
export type ExitStatus = z.infer<typeof ExitStatusSchema>;

export const SkillSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string() }).strict(),
  z.object({ kind: z.literal('npm'), pkg: z.string(), version: z.string() }).strict(),
  z.object({ kind: z.literal('git'), repo: z.string().url(), ref: z.string() }).strict(),
]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const ExpectedBehaviorSchema = z
  .object({
    description: z.string(),
    invocationSignals: z.array(z.string()),
    artifacts: z.array(z.string()).optional(),
  })
  .strict();
export type ExpectedBehavior = z.infer<typeof ExpectedBehaviorSchema>;

export const TriggerPromptSchema = z
  .object({
    id: z.string(),
    forSkillId: z.string(),
    prompt: z.string(),
    expectedBehavior: ExpectedBehaviorSchema,
    authoring: z.enum(['hand', 'llm-draft-human-edited']),
    kind: z.enum(['positive', 'paraphrase', 'edge', 'negative']),
    tag: z.string().optional(),
  })
  .strict();
export type TriggerPrompt = z.infer<typeof TriggerPromptSchema>;

export const CorpusEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    bucket: BucketSchema,
    source: SkillSourceSchema,
    skillRelPath: z.string(),
    declaredTargets: z.array(TargetSchema).optional(),
    expectedCapabilities: z.array(z.string()),
    triggerPromptRefs: z.array(z.string()).min(2),
    notes: z.string().optional(),
  })
  .strict();
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

export const CorpusManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(CorpusEntrySchema),
    repeatN: z.number().int().positive().default(1),
  })
  .strict();
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

export const TriggerPromptsFileSchema = z
  .object({
    version: z.literal(1),
    prompts: z.array(TriggerPromptSchema),
  })
  .strict();
export type TriggerPromptsFile = z.infer<typeof TriggerPromptsFileSchema>;

export const ObservationCodeSchema = z
  .object({
    code: z.string(),
    summary: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ObservationCode = z.infer<typeof ObservationCodeSchema>;

export const VerdictCodeEntrySchema = z
  .object({
    code: z.string(),
    observationCode: z.string(),
    summary: z.string(),
  })
  .strict();

export const PerTargetPredictionSchema = z
  .object({
    target: TargetSchema,
    verdicts: z.array(VerdictCodeEntrySchema),
    predictedOutcome: z.enum(['expected', 'needs-review', 'incompatible', 'undeclared']),
  })
  .strict();
export type PerTargetPrediction = z.infer<typeof PerTargetPredictionSchema>;

export const StaticPredictionSchema = z
  .object({
    skillId: z.string(),
    observations: z.array(ObservationCodeSchema),
    verdictByTarget: z.array(PerTargetPredictionSchema),
    vatVersion: z.string(),
    predictionError: z.string().optional(),
  })
  .strict();
export type StaticPrediction = z.infer<typeof StaticPredictionSchema>;

export const ToolUseEventSchema = z
  .object({
    name: z.string(),
    inputSummary: z.string(),
  })
  .strict();

export const InstallResultSchema = z
  .object({
    ok: z.boolean(),
    notes: z.string(),
  })
  .strict();

export const RuntimeObservationSchema = z
  .object({
    skillId: z.string(),
    target: TargetSchema,
    startedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    exitStatus: ExitStatusSchema,
    invocationDetected: z.boolean(),
    outputText: z.string(),
    toolUseEvents: z.array(ToolUseEventSchema),
    errors: z.array(z.string()),
    installResult: InstallResultSchema,
    transcriptPath: z.string(),
    driverMode: DriverModeSchema,
    promptId: z.string(),
    attemptIdx: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>;

export const DeterministicClassSchema = z.enum([
  'invoked-output',
  'invoked-no-output',
  'not-invoked-engaged',
  'not-invoked-empty',
  'install-failed',
  'runtime-error',
  'refused',
  'timeout',
  'skipped',
]);
export type DeterministicClass = z.infer<typeof DeterministicClassSchema>;

export const JudgeVerdictSchema = z.enum(['completed', 'partial', 'failed', 'off-task', 'refused']);
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeResultSchema = z
  .object({
    skillId: z.string(),
    target: TargetSchema,
    verdict: JudgeVerdictSchema,
    rationale: z.string().max(240),
    confidence: z.enum(['high', 'medium', 'low']),
    judgeModel: z.string(),
    judgeCallRef: z.string().optional(),
  })
  .strict();
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

/**
 * Verbatim record of a judge call — system prompt, user message, raw model
 * response blocks, usage, and identifying metadata. Persisted at
 * `judge-calls/<skillId>-<promptId>-<target>-<attemptIdx>.json` during the
 * judge phase so the `re-judge` subcommand can re-run the same user message
 * against a different model (or the same model with a freshly edited system
 * prompt) without re-spending operator hours on the run/install side.
 *
 * Strict (Postel's Law — VAT-emitted). The `responseContent` and
 * `responseUsage` fields hold opaque SDK shapes; z.unknown() preserves them
 * without claiming a fragile contract over the Anthropic response schema.
 */
export const JudgeCallArtifactSchema = z
  .object({
    skillId: z.string(),
    target: TargetSchema,
    promptId: z.string(),
    attemptIdx: z.number().int().nonnegative(),
    judgeModel: z.string(),
    judgePromptSha: z.string(),
    systemPrompt: z.string(),
    userMessage: z.string(),
    responseContent: z.array(z.unknown()),
    responseUsage: z.unknown().optional(),
    requestId: z.string().optional(),
  })
  .strict();
export type JudgeCallArtifact = z.infer<typeof JudgeCallArtifactSchema>;

export const AgreementSchema = z.enum([
  'agree',
  'vat-pessimistic',
  'vat-optimistic',
  'ambiguous',
]);
export type Agreement = z.infer<typeof AgreementSchema>;

export const AttemptStatsSchema = z
  .object({
    n: z.number().int().positive(),
    extendedFromN3: z.boolean(),
    byDeterministicClass: z.record(DeterministicClassSchema, z.number().int().nonnegative()),
    byJudgeVerdict: z.record(JudgeVerdictSchema, z.number().int().nonnegative()),
  })
  .strict();
export type AttemptStats = z.infer<typeof AttemptStatsSchema>;

export const JoinedMatrixRowSchema = z
  .object({
    skillId: z.string(),
    bucket: BucketSchema,
    target: TargetSchema,
    promptId: z.string(),
    predicted: z.enum(['expected', 'needs-review', 'incompatible', 'undeclared']),
    observedDeterministic: DeterministicClassSchema,
    observedJudge: JudgeVerdictSchema.optional(),
    agreement: AgreementSchema,
    driverMode: DriverModeSchema,
    evidenceRefs: z.array(z.string()),
    attemptStats: AttemptStatsSchema,
    highVariance: z.boolean(),
  })
  .strict();
export type JoinedMatrixRow = z.infer<typeof JoinedMatrixRowSchema>;

export const RunMetadataSchema = z
  .object({
    runId: z.string(),
    runDate: z.string().datetime(),
    vatVersion: z.string(),
    nodeVersion: z.string(),
    bunVersion: z.string().optional(),
    judgeModel: z.string(),
    authMode: z.literal('subscription'),
    judgePromptSha: z.string(),
    triggerPromptsSha: z.string(),
    manifestSha: z.string(),
    claudeCodeVersion: z.string().optional(),
    runtimesCovered: z.array(TargetSchema),
    totalEntries: z.number().int().nonnegative(),
  })
  .strict();
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
