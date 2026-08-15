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

export { captureCrawl, type CaptureCrawlOptions } from './facets/crawl/capture.js';
export {
  compareCrawl,
  type CompareCrawlOptions,
  type CrawlCommandDiff,
  type CrawlCommandVerdict,
  type CrawlComparison,
  type CrawlComparisonRefused,
  type CrawlComparisonResult,
  type CrawlCountDelta,
  type CrawlMovement,
  type CrawlMsDelta,
  type CrawlRowMovement,
  type CrawlRowMovementKind,
} from './facets/crawl/compare.js';
export {
  CRAWL_DUMP_VERSION,
  CRAWL_INCUMBENT_STRATUM,
  CRAWL_SHARED_STRATUM,
  CRAWL_TIMING_DIR_ENV,
  crawlAttributionOf,
  type CrawlDump,
  type CrawlDumpEntry,
  type CrawlDumpProcess,
  CrawlDumpSchema,
  type CrawlDumpsAccepted,
  crawlEntryKey,
  type CrawlProcessRecord,
  crawlRoleTotalOf,
  crawlRowRole,
  type MergedCrawlDumps,
  type MergedCrawlDumpsResult,
  mergeCrawlDumps,
  readCrawlDumps,
  sameCrawlWork,
} from './facets/crawl/dump.js';
export { renderCrawlComparison, renderCrawlReport } from './facets/crawl/render.js';
export {
  CRAWL_FACET,
  CRAWL_FACET_VERSION,
  CRAWL_ROW_ROLES,
  type CrawlAttribution,
  type CrawlBody,
  CrawlBodySchema,
  type CrawlCommandStats,
  crawlEntryShape,
  type CrawlEntryStats,
  crawlProcessShape,
  type CrawlProcessStats,
  type CrawlRoleTotals,
  type CrawlRowRole,
  type CrawlSeamRow,
  crawlSeamRowShape,
  type CrawlStratumStats,
} from './facets/crawl/types.js';

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
export {
  type CountDelta,
  countDelta,
  DEFAULT_MIN_ABSOLUTE_MS,
  DEFAULT_MIN_RELATIVE,
  type DeltaThresholds,
  type LabelledRow,
  labelledMovements,
  type MsDelta,
  msDelta,
  type RowMovement,
  type RowMovementKind,
} from './harness/delta.js';
export { bothSides, pairByKey, type Pairing } from './harness/diff.js';
export { captureCommandRows } from './harness/dump-capture.js';
export {
  type BodyParser,
  cacheModeCaveat,
  type CommandBody,
  type CommandDiff,
  type CommandsCompared,
  type ComparableRow,
  compareCommandRows,
  type ComparisonOpened,
  type ComparisonOpening,
  type ComparisonRefusal,
  diffPairedCommand,
  type FacetContract,
  failureCaveat,
  type OneSidedVerdict,
  openComparison,
  unmeasurableReasonFor,
} from './harness/facet-compare.js';
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
  countMovement,
  facetReportText,
  instrumentLabel,
  instrumentTrustNotes,
  type LoadPhrasing,
  loadLine,
  movementMark,
  type MovementMark,
  ms,
  msMovement,
  msPair,
  noMeasurementLines,
  oneSidedLines,
  perUnit,
  renderFacetComparison,
  renderFacetReport,
  share,
  SHORT_HASH,
  signedMs,
  tally,
  unmeasuredBlock,
  verdictBlock,
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
