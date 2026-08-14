/**
 * `@vibe-agent-toolkit/lab` — the quality lab.
 *
 * Generates analyzable reports about a subject, and compares them along exactly
 * one of three axes: which project, which version of that project, and which
 * build of vat did the measuring. That is what lets one tool answer "did vat get
 * better or faster", "what moved upstream", and "how does the ecosystem look" —
 * for quality as well as for speed.
 *
 * Drives vat through its CLI boundary only, never through its internals, which
 * is what makes it able to measure two different vat versions in one run.
 */

export {
  type Axis,
  type ComparisonDecision,
  type Coordinate,
  CoordinateSchema,
  decideComparison,
  type DecideComparisonOptions,
  type InstrumentVersion,
  InstrumentVersionSchema,
  movedAxes,
  type SubjectRef,
  SubjectRefSchema,
  type SubjectVersion,
  SubjectVersionSchema,
} from './envelope/coordinate.js';

export {
  type EnvelopeAccepted,
  type EnvelopeRefusal,
  type EnvelopeResult,
  readEnvelope,
  refuseIncomparableSchemas,
  REPORT_FORMAT_VERSION,
  type ReportEnvelope,
  ReportEnvelopeSchema,
} from './envelope/envelope.js';

export { captureIo, type CaptureIoOptions } from './facets/io/capture.js';
export {
  compareIo,
  type CompareIoOptions,
  type IoCommandDiff,
  type IoCommandVerdict,
  type IoComparison,
  type IoComparisonRefused,
  type IoComparisonResult,
  type IoCountDelta,
  type IoMovement,
  type IoSiteMovement,
  type IoSiteMovementKind,
  type IoTotalsDelta,
} from './facets/io/compare.js';
export {
  renderIoComparison,
  renderIoReport,
  type RenderIoReportOptions,
} from './facets/io/render.js';
export {
  type DumpsAccepted,
  IO_DUMP_VERSION,
  type IoClass,
  type IoDump,
  type IoDumpRow,
  IoDumpSchema,
  type MergedDumps,
  type MergedDumpsResult,
  mergeDumps,
  normalizeSite,
  readDumps,
  sameBuckets,
  type SiteRoots,
} from './facets/io/dump.js';
export {
  IO_FACET,
  IO_FACET_VERSION,
  type IoBody,
  IoBodySchema,
  type IoCommandStats,
  type IoSite,
} from './facets/io/types.js';

export { captureParse, type CaptureParseOptions } from './facets/parse/capture.js';
export {
  compareParse,
  type CompareParseOptions,
  type ParseCommandDiff,
  type ParseCommandVerdict,
  type ParseComparison,
  type ParseComparisonRefused,
  type ParseComparisonResult,
  type ParseCountDelta,
  type ParseMovement,
  type ParseMsDelta,
  type ParsePassMovement,
  type ParsePassMovementKind,
} from './facets/parse/compare.js';
export {
  attributionOf,
  type MergedParseDumps,
  type MergedParseDumpsResult,
  type MergedParseKind,
  mergeParseDumps,
  PARSE_DUMP_VERSION,
  PARSE_TIMING_DIR_ENV,
  type ParseDump,
  type ParseDumpKind,
  type ParseDumpPass,
  type ParseDumpProcess,
  type ParseDumpsAccepted,
  ParseDumpSchema,
  parseTotalName,
  readParseDumps,
  sameParseWork,
} from './facets/parse/dump.js';
export { renderParseComparison, renderParseReport } from './facets/parse/render.js';
export {
  PARSE_FACET,
  PARSE_FACET_VERSION,
  type ParseAttribution,
  type ParseBody,
  ParseBodySchema,
  type ParseCommandStats,
  type ParseKindStats,
  parsePassShape,
  type ParsePassStats,
} from './facets/parse/types.js';

export { capturePerf, type CapturePerfOptions } from './facets/perf/capture.js';
export {
  comparePerf,
  type ComparePerfOptions,
  type PerfCommandDiff,
  type PerfCommandVerdict,
  type PerfComparison,
  type PerfComparisonRefused,
  type PerfComparisonResult,
} from './facets/perf/compare.js';
export { renderPerfComparison, renderPerfReport } from './facets/perf/render.js';
export {
  isSignificant,
  type MedianWithSpread,
  type PerfSummary,
  type SignificanceGate,
  type SignificanceOptions,
  type SignificanceResult,
  summarize,
} from './facets/perf/stats.js';
export {
  PERF_FACET,
  PERF_FACET_VERSION,
  type PerfBody,
  PerfBodySchema,
  type PerfCommandStats,
} from './facets/perf/types.js';

export {
  type AbArmSummary,
  type AbCommandResult,
  abExitCondition,
  type AbNoiseVerdict,
  type AbResult,
  type AbSpec,
  CHANGED_VERDICT,
  type ComparisonLike,
  type FacetEstimate,
  type FacetFunctions,
  type RefusalLike,
  renderAb,
  runAb,
  UNMEASURABLE_VERDICT,
} from './harness/ab.js';
export {
  completedExitCodesOf,
  DEFAULT_COMPLETED_EXIT_CODES,
  DEFAULT_MEASURED_COMMANDS,
  MEASURABLE_COMMAND_NAMES,
  MEASURABLE_COMMANDS,
  measurableCommand,
  type MeasuredCommandSpec,
} from './harness/commands.js';
export { bothSides, pairByKey, type Pairing } from './harness/diff.js';
export { type Estimate, estimate, quantile } from './harness/estimator.js';
export {
  describeIssues,
  type DumpFilesAccepted,
  type DumpFilesResult,
  type DumpKind,
  type DumpParser,
  type DumpsRefusal,
  messageOf,
  readDumpFiles,
  refuseDumps,
  withDumpDirs,
} from './harness/dumps.js';
export { type GitOutcome, hasUncommittedChanges, runGit } from './harness/git-state.js';
export { resolveInstrument } from './harness/instrument.js';
export {
  DEFAULT_LOAD_PER_CPU_THRESHOLD,
  judgeLoad,
  type JudgeLoadOptions,
  type LoadSample,
  readLoad,
} from './harness/load-guard.js';
export {
  classifyRunFailure,
  materializeArgs,
  measureSpec,
  type RepeatSpec,
  runRepeats,
  runRepeatsFor,
  type SpecMeasurement,
  SUBJECT_TOKEN,
  summarizeRepeatFailures,
} from './harness/repeat.js';
export {
  type ComparisonFrame,
  comparisonHeading,
  comparisonText,
  coordinateLines,
  instrumentLabel,
  instrumentTrustNotes,
  type LoadPhrasing,
  loadLine,
  noMeasurementLines,
  oneSidedLines,
  SHORT_HASH,
  tally,
  versionLabel,
} from './harness/render.js';
export { buildReportEnvelope } from './harness/report.js';
export { runCommand } from './harness/run.js';
export { resolveSubject } from './harness/subject.js';
export type {
  CacheMode,
  CaptureRequest,
  InstrumentSource,
  LoadReadings,
  ResolvedInstrument,
  ResolvedSubject,
  RunOptions,
  RunResult,
  SubjectSource,
} from './harness/types.js';

export { readReport, reportFileName, writeReport } from './store.js';
