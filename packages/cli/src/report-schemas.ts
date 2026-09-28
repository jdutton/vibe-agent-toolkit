/**
 * Every shape VAT publishes — on stdout, in a file, as an exported library
 * type, as a committed JSON Schema — and what each one is.
 *
 * 🔑 **One list, asserted both ways.** `test/published-shapes.test.ts` holds
 * every claim here against the tree: each writer call in `commands/` names an
 * entry and each entry has its writer call; each Commander leaf with an action
 * is covered by exactly one entry; each `packages/<pkg>/schemas/*.json` is
 * registered and each registered file exists; each `*Result` / `*Report` /
 * `*Document` type a published barrel exports is registered and each
 * registered one is exported. A registry asserted only one way is a hand-kept
 * list, and hand-kept lists are how a shape shipped with nothing describing it.
 *
 * ## Kinds and channels
 *
 * - `report` / `stdout` — the document IS the union envelope (`Report<T>`).
 *   The writer (`utils/document-writer.ts`) validates it against `schema`
 *   before a byte leaves, derives the run-integrity refusal from `examined`
 *   (the verb's declared denominator — what `examined` counts, and what to
 *   check when it is zero), and ends on the code the written document derives.
 *   `scripts/generate-json-schemas.ts` emits `schemas/<name>.json` from it.
 * - `external` / `stdout` — a payload whose shape someone else owns (the
 *   Anthropic Admin API), passed through; `exitCode` adapts its outcome to the
 *   exit contract, since there is no envelope to derive one from.
 * - `artifact` — a VAT-owned shape that is not a run report: a stdout
 *   artifact (a config to paste), a file a verb writes, or a type a package
 *   barrel exports. `schemaFile` names the committed JSON Schema describing it
 *   (rendered from `schema`), or is `null` when none is published; `writer`
 *   says who puts a file artifact's bytes on disk.
 * - `input` / `schema-file` — a committed JSON Schema describing what an
 *   ADOPTER writes (config, manifests, frontmatter). Registered so the
 *   both-ways file check can tell "describes an input" from "unregistered".
 * - `legacy` / `stdout` — INTERIM, shrink-only: every Commander leaf not yet
 *   migrated, each naming the task that migrates it. A leaf that migrates
 *   leaves this list in the same change; a legacy verb that now writes through
 *   a `report` entry is a red test. Only `claude context` survives wave A.
 *
 * ## Why the report schemas live in sibling `*-schema.ts` modules
 *
 * The writer imports this registry, and every report verb imports the
 * writer. A schema declared in the verb's own module would make this file
 * import the verb that imports it — an ESM cycle whose binding is read here
 * before the verb has initialised it. So each verb's `<VERB>_REPORT_SCHEMA`
 * lives beside it in a module that imports nothing from the writer.
 *
 * ## The one lint exception
 *
 * `local/no-stdout-outside-writer` makes the writer the only stdout under
 * `commands/`. Its `allowFiles` is the same interim ratchet as `legacy`, and
 * reaches exactly `commands/agent/run.ts` — whose stdout is the agent's own
 * stdio conversation, not a document.
 */

import { FrictionReportSchema } from '@vibe-agent-toolkit/agent-skills';
import {
  ClaudeContextChainRowSchema,
  ClaudeContextLoadRowSchema,
  EdgeResolutionRowSchema,
  EdgeRowSchema,
  LensEntryPointRowSchema,
  PROJECTION_TABLES,
} from '@vibe-agent-toolkit/resources';
import { ExitCode, type ExitCodeValue, type Report, type ReportZodSchema } from '@vibe-agent-toolkit/schema';
import type { ZodTypeAny } from 'zod';

import { ARD_EMIT_REPORT_SCHEMA } from './commands/ard/emit-schema.js';
import { OKF_VALIDATE_REPORT_SCHEMA } from './commands/okf/validate-schema.js';
import { CHECK_REPORT_SCHEMA } from './commands/resources/check-schema.js';
import { SKILL_REVIEW_REPORT_SCHEMA } from './commands/skill/review-schema.js';
import type { ExaminedDeclaration } from './utils/run-integrity.js';

/** How a document is rendered on stdout. */
export type DocumentFormat = 'yaml' | 'json' | 'text';

/** What an external write did, for the adapter that maps it to an exit code. */
export type ExternalOutcome = { kind: 'ok' } | { kind: 'partial'; failed: number } | { kind: 'failed'; cause: string };

/** A verb whose document is the union envelope. */
interface ReportShape {
  readonly kind: 'report';
  readonly channel: 'stdout';
  /** The commands as typed after `vat`, e.g. `okf validate`. */
  readonly verbs: readonly string[];
  /** Basename of `schemas/<name>.json`. */
  readonly name: string;
  readonly schema: ReportZodSchema<ZodTypeAny, ZodTypeAny>;
  /** What `examined` counts, and what to check when it is zero. */
  readonly examined: ExaminedDeclaration;
  /** The `--format text` rendering, when the generic one is not this verb's contract. */
  readonly renderText?: (report: Report<unknown>) => string;
}

/** A payload whose shape someone else owns, passed through. */
interface ExternalShape {
  readonly kind: 'external';
  readonly channel: 'stdout';
  readonly verbs: readonly string[];
  readonly reason: string;
  readonly exitCode: (outcome: ExternalOutcome) => ExitCodeValue;
}

/** A VAT-owned shape on stdout or in a file that is not a run report. */
interface PublishedArtifactShape {
  readonly kind: 'artifact';
  readonly channel: 'stdout' | 'file';
  readonly name: string;
  /** The verbs that publish it. */
  readonly publishers: readonly string[];
  readonly schema: ZodTypeAny | null;
  /** Repo-relative path of the committed JSON Schema rendered from `schema`, or `null` when none is. */
  readonly schemaFile: string | null;
  /** Who puts the bytes out: the document writer (`writeArtifact` / `writeArtifactFile`), or the projection store. */
  readonly writer: 'document-writer' | 'projection-store';
  readonly reason: string;
}

/** A type a published package barrel exports. */
interface ExportedTypeShape {
  readonly kind: 'artifact';
  readonly channel: 'export';
  readonly package: string;
  readonly typeName: string;
  readonly reason: string;
}

/** A committed JSON Schema describing what an adopter writes. */
interface InputShape {
  readonly kind: 'input';
  readonly channel: 'schema-file';
  /** Repo-relative path. */
  readonly file: string;
  readonly reason: string;
}

/** INTERIM: a leaf not yet migrated, naming the task that migrates it. */
interface LegacyShape {
  readonly kind: 'legacy';
  readonly channel: 'stdout';
  readonly verbs: readonly string[];
  readonly reason: string;
}

export type PublishedShape = ReportShape | ExternalShape | PublishedArtifactShape | ExportedTypeShape | InputShape | LegacyShape;

/** Who puts an artifact's bytes out, named once. */
const DOCUMENT_WRITER = 'document-writer';

/** The verb publishing the corpus scan's file artifacts, named once. */
const CORPUS_SCAN = 'corpus scan';

/** The Admin API adapter: only a write that fully landed is `OK`; a partial or failed one is `ERROR`. */
const adminApiExitCode = (outcome: ExternalOutcome): ExitCodeValue =>
  outcome.kind === 'ok' ? ExitCode.OK : ExitCode.ERROR;

/** `ard emit --format text`: the one summary line it has always printed; its findings go to stderr. */
function renderArdEmitText(report: Report<unknown>): string {
  const data = report.data as { outputPath: string | null; entryCount: number } | null;
  if (data?.outputPath === undefined || data.outputPath === null) return '';
  return `Wrote ${data.entryCount} ARD entr${data.entryCount === 1 ? 'y' : 'ies'} to ${data.outputPath}\n`;
}

const REPORTS = [
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['okf validate'],
    name: 'okf-validate',
    schema: OKF_VALIDATE_REPORT_SCHEMA,
    examined: {
      unit: 'bundle documents',
      whenZero: 'Declare a bundle under okf.bundles in vibe-agent-toolkit.config.yaml, or check that each bundle root holds its markdown documents.',
    },
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skill review'],
    name: 'skill-review',
    schema: SKILL_REVIEW_REPORT_SCHEMA,
    examined: {
      unit: 'skills',
      whenZero: 'Point the command at a SKILL.md file or a directory containing one.',
    },
    // The human report goes to stderr; without --yaml stdout carries nothing.
    renderText: () => '',
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['resources check'],
    name: 'resources-check',
    schema: CHECK_REPORT_SCHEMA,
    examined: {
      unit: 'resources in the population',
      whenZero: 'The projection holds no tracked resource: run from inside the project, and check that its files are tracked or not excluded.',
    },
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['ard emit'],
    name: 'ard-emit',
    schema: ARD_EMIT_REPORT_SCHEMA,
    examined: {
      unit: 'configured surfaces',
      whenZero: 'The ard: block declares no surface this project has — declare skills, marketplaces or OKF bundles to advertise, or do not run vat ard emit for this project.',
    },
    renderText: renderArdEmitText,
  },
] as const satisfies readonly ReportShape[];

const CLAUDE_ORG_EXTERNAL = {
  kind: 'external',
  channel: 'stdout',
  verbs: [
    'claude org info',
    'claude org users list',
    'claude org users get',
    'claude org invites list',
    'claude org workspaces list',
    'claude org workspaces get',
    'claude org workspaces members list',
    'claude org api-keys list',
    'claude org usage',
    'claude org cost',
    'claude org code-analytics',
    'claude org skills list',
    'claude org skills install',
    'claude org skills delete',
    'claude org skills versions list',
    'claude org skills versions add',
    'claude org skills versions delete',
  ],
  reason: 'Anthropic Admin API objects passed through as the API returns them (`has_more`, `data[]`, snake_case). Renaming them would make VAT a second schema for a document Anthropic owns.',
  exitCode: adminApiExitCode,
} as const satisfies ExternalShape;

const EXTERNALS: readonly ExternalShape[] = [CLAUDE_ORG_EXTERNAL];

const LEGACY = [
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['audit', 'audit settings'],
    reason: 'Task 11: the largest document in the CLI (consumed by the corpus runner and the lab) and `SettingsFinding[]` under `path`; both move to the envelope with `location`.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['resources validate', 'resources scan', 'resources query'],
    reason: 'Task 12: the lab measures `resources validate` / `scan` through its population reader, and `query` publishes operator-selected rows; all three move to the envelope together with the reader.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['skills validate', 'claude marketplace validate', 'agent validate'],
    reason: 'Task 13: per-skill COUNT rows, a `vat verify` phase document, and the agent-config result verbatim — each becomes `data` beside flattened findings.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['claude plugin list', 'claude plugin install', 'claude plugin uninstall'],
    reason: 'Task 15: hand-written YAML headers and a `not-available` status word; they become reports with `USAGE_INVALID` refusals.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['claude plugin build', 'claude marketplace publish'],
    reason: 'Task 16: the plugin build document carries `issueCounts` and absolute output paths; publish a results list. Both become reports.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: [
      'claude org users update',
      'claude org users remove',
      'claude org invites create',
      'claude org invites delete',
      'claude org workspaces create',
      'claude org workspaces archive',
      'claude org workspaces members add',
      'claude org workspaces members update',
      'claude org workspaces members remove',
      'claude org api-keys update',
    ],
    reason: 'Task 17: the not-implemented stubs write a hand-rolled `status: not-yet-implemented` document; they refuse with `NOT_IMPLEMENTED` through the writer.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['skills list', 'skills install'],
    reason: 'Task 18: a `warning` status word for an unreadable directory and a `dry-run` status; both become findings and `data`.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['skills build'],
    reason: 'Task 19: `issueCounts` / `runIssueCounts` and a hand-written dry-run document; the in-place refusal becomes a finding.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['skills package', 'skill test configure'],
    reason: 'Task 20: the packaging gate failure is a validation-gate document; `configure --print` becomes a raw stdout artifact.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['skill test run'],
    reason: 'Task 21: a `Summary:` stdout line and forwarded harness exit codes; failed evals become findings.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['doctor', 'cache clear'],
    reason: 'Task 22: a human check block on stdout and a `partial` status decided beside the document.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['agent build', 'agent import', 'agent installed'],
    reason: 'Task 23: ad-hoc result documents; import failures refuse with `INPUT_UNREADABLE`.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['agent list', 'agent install', 'agent uninstall'],
    reason: 'Task 24: a listing with a `count` field, and two verbs that publish no document at all yet.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['rag index', 'rag query'],
    reason: 'Task 25: a `partial` outcome and per-document errors; they become findings, and an unavailable backend a refusal.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['rag stats', 'rag clear', 'mcp list-collections'],
    reason: 'Task 26: status-word documents with a `message` and a `count`; each becomes `data`.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: [CORPUS_SCAN, 'claude context'],
    reason: 'Task 27: corpus scan writes its file artifacts by hand; `claude context` stays the one legacy document through wave A and moves onto writeLegacyDocument.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['build', 'validate', 'verify'],
    reason: 'Task 28: the phase orchestrators nest each phase\'s own document, so they migrate after every phase does.',
  },
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['inventory'],
    reason: 'Task 29: the structural inventory `serializeInventory` builds, published verbatim; it becomes `data.inventory`.',
  },
] as const satisfies readonly LegacyShape[];

/** Relations VAT publishes to adopter SQL that no projection table materialises (the per-lens derived rows). */
const DERIVED_RELATION_SCHEMAS: ReadonlyArray<readonly [string, ZodTypeAny]> = [
  ['projection-edges', EdgeRowSchema],
  ['projection-edge-resolutions', EdgeResolutionRowSchema],
  ['projection-lens-entry-points', LensEntryPointRowSchema],
  ['projection-claude-context-chains', ClaudeContextChainRowSchema],
  ['projection-claude-context-loads', ClaudeContextLoadRowSchema],
];

/** Every relation `vat resources query` / `check` expose to an adopter's SQL, as a file artifact. */
const PROJECTION_RELATIONS: readonly PublishedArtifactShape[] = [
  ...Object.values(PROJECTION_TABLES).map((spec) => [`projection-${spec.name.replaceAll('_', '-')}`, spec.schema] as const),
  ...DERIVED_RELATION_SCHEMAS,
].map(([name, schema]) => ({
  kind: 'artifact',
  channel: 'file',
  name,
  publishers: ['resources query', 'resources check'],
  schema,
  schemaFile: `packages/resources/schemas/${name}.json`,
  writer: 'projection-store',
  reason: 'A relation VAT publishes to adopter SQL; its row shape is what a check or query statement reads.',
}));

const ARTIFACTS: readonly PublishedArtifactShape[] = [
  {
    kind: 'artifact',
    channel: 'stdout',
    name: 'claude-desktop-config',
    publishers: ['mcp serve'],
    schema: null,
    schemaFile: null,
    writer: DOCUMENT_WRITER,
    reason: '`mcp serve --print-config`: the Claude Desktop config snippet an operator pastes; its shape is the MCP client config.',
  },
  {
    kind: 'artifact',
    channel: 'file',
    name: 'friction-report',
    publishers: ['skill test run'],
    schema: FrictionReportSchema,
    schemaFile: 'packages/agent-skills/schemas/friction-report.json',
    writer: DOCUMENT_WRITER,
    reason: 'The graded friction report a skill test run writes beside its output.',
  },
  {
    kind: 'artifact',
    channel: 'file',
    name: 'corpus-summary',
    publishers: [CORPUS_SCAN],
    schema: null,
    schemaFile: null,
    writer: DOCUMENT_WRITER,
    reason: 'corpus scan `summary.yaml`: the per-plugin index of one scan run.',
  },
  {
    kind: 'artifact',
    channel: 'file',
    name: 'corpus-audit',
    publishers: [CORPUS_SCAN],
    schema: null,
    schemaFile: null,
    writer: DOCUMENT_WRITER,
    reason: 'corpus scan `<name>-audit.yaml`: the full audit document per plugin.',
  },
  ...PROJECTION_RELATIONS,
];

/** A library result type an adopter's code receives. */
function exported(pkg: string, typeNames: readonly string[], reason: string): ExportedTypeShape[] {
  return typeNames.map((typeName) => ({ kind: 'artifact', channel: 'export', package: `@vibe-agent-toolkit/${pkg}`, typeName, reason }));
}

const AGENT_SKILLS = 'agent-skills';
const SCHEMA_PACKAGE = 'schema';

const LIBRARY_RESULT = 'A result type the package barrel exports; its shape is the library API contract.';

const EXPORTS: readonly ExportedTypeShape[] = [
  ...exported('agent-config', ['ValidationResult'], LIBRARY_RESULT),
  ...exported('agent-runtime', ['AgentResult', 'StatefulAgentResult'], 'The agent result envelope every runtime adapter returns.'),
  ...exported(AGENT_SKILLS, [
    'BuildResult', 'FrontmatterResult', 'GitCloneResult', 'ImportResult', 'LinkGraphResult',
    'PackageSkillResult', 'PackagingValidationResult', 'ValidationResult',
    'PreflightResult', 'RunHarnessResult', 'StageHarnessResult',
  ], LIBRARY_RESULT),
  ...exported(AGENT_SKILLS, ['FrictionReport', 'GradingReport', 'ToolEvalReport'], 'A skill-test report the harness writes and a caller reads back.'),
  ...exported('claude-marketplace', [
    'CompatibilityResult', 'MultipartResult', 'PluginListResult', 'SettingsAuditResult',
    'SettingsPathCandidatesResult', 'SettingsPathsResult', 'SettingsValidateResult', 'UninstallPluginResult',
  ], LIBRARY_RESULT),
  ...exported('discovery', ['ScanResult'], LIBRARY_RESULT),
  ...exported('gateway-mcp', ['MCPToolResult'], 'The MCP tool result the gateway returns to a client.'),
  ...exported('rag', ['ChunkingResult', 'DocumentResult', 'IndexResult', 'RAGResult'], LIBRARY_RESULT),
  ...exported('resource-compiler', ['CompileResult', 'ParseResult'], LIBRARY_RESULT),
  ...exported('resources', [
    'BlobPopulationReport', 'BlobPopulationResult', 'ContentFetchResult', 'OkfBundleReport',
    'ParseResult', 'ProjectionDocument', 'ResolveLocalHrefResult', 'ValidationResult',
  ], LIBRARY_RESULT),
  ...exported('runtime-claude-agent-sdk', ['AgentConversionResult', 'BatchConversionResult'], LIBRARY_RESULT),
  ...exported('runtime-langchain', ['ConversationalResult'], LIBRARY_RESULT),
  ...exported('runtime-vercel-ai-sdk', ['ConversionResult'], LIBRARY_RESULT),
  ...exported(SCHEMA_PACKAGE, ['Report', 'OkReport', 'FindingsReport', 'ErrorReport'], 'The union report envelope every report verb publishes; its JSON Schemas are the `report` entries above.'),
  ...exported(SCHEMA_PACKAGE, ['ExitDeterminingDocument'], 'The envelope fields an exit code derives from.'),
  ...exported(SCHEMA_PACKAGE, ['AgentResult', 'StatefulAgentResult', 'FrameworkResult'], 'The agent result envelope every runtime adapter returns.'),
  ...exported(SCHEMA_PACKAGE, ['AllowFilterResult'], LIBRARY_RESULT),
  ...exported('vat-example-cat-agents', [
    'ApprovalResult', 'ChoiceResult', 'CustomApprovalResult', 'HaikuValidationResult', 'NameValidationResult',
  ], 'An example agent\'s result type, published as part of the example package.'),
];

/** An adopter-written shape's committed JSON Schema. */
function inputs(pkg: string, names: readonly string[], reason: string): InputShape[] {
  return names.map((name) => ({ kind: 'input', channel: 'schema-file', file: `packages/${pkg}/schemas/${name}.json`, reason }));
}

const INPUTS: readonly InputShape[] = [
  ...inputs('agent-skills', ['skill-frontmatter', 'vat-skill-frontmatter', 'marketplace-manifest'], 'The SKILL.md frontmatter or marketplace.json an author writes.'),
  ...inputs('resources', ['project-config'], 'vibe-agent-toolkit.config.yaml, the adopter\'s project config.'),
  ...inputs('resources', ['okf-concept-frontmatter'], 'The OKF concept-document frontmatter a bundle author writes.'),
  ...inputs('schema', ['agent-manifest', 'agent-metadata', 'agent-interface', 'llm-config', 'tool', 'resource-registry'], 'A part of the agent.yaml manifest an agent author writes.'),
  ...inputs('schema', ['vat-package-metadata'], 'The `vat` block an adopter writes in package.json.'),
  ...inputs('schema', ['validation-config'], 'The `validation` block (`severity` / `allow`) an adopter writes.'),
];

/** Every shape VAT publishes. See the module docstring for the kinds and the both-ways test. */
export const PUBLISHED_SHAPES: readonly PublishedShape[] = [
  ...REPORTS,
  ...EXTERNALS,
  ...ARTIFACTS,
  ...EXPORTS,
  ...INPUTS,
  ...LEGACY,
];

/** A verb whose document is the union envelope. */
export type ReportVerb = (typeof REPORTS)[number]['verbs'][number];

/** A verb still on the interim legacy path. */
export type LegacyVerb = (typeof LEGACY)[number]['verbs'][number];

/**
 * The registry entry a report verb publishes through.
 *
 * @throws When `verb` has no report entry — a defect in the caller, never a user mistake
 */
export function reportShapeFor(verb: string): ReportShape {
  const entry: ReportShape | undefined = REPORTS.find((shape) => (shape.verbs as readonly string[]).includes(verb));
  if (entry === undefined) throw new Error(`No report entry in PUBLISHED_SHAPES for verb '${verb}'`);
  return entry;
}

/**
 * The published artifact named `name` on `channel`.
 *
 * @throws When no such artifact is registered
 */
export function artifactShapeFor(name: string, channel: 'stdout' | 'file'): PublishedArtifactShape {
  const entry = ARTIFACTS.find((shape) => shape.name === name && shape.channel === channel);
  if (entry === undefined) throw new Error(`No ${channel} artifact in PUBLISHED_SHAPES named '${name}'`);
  return entry;
}

/**
 * The exit code an external verb's outcome maps to — the adapter its entry declares.
 *
 * @throws When `verb` has no external entry
 */
export function exitCodeForExternal(verb: string, outcome: ExternalOutcome): ExitCodeValue {
  const entry = EXTERNALS.find((shape) => shape.verbs.includes(verb));
  if (entry === undefined) throw new Error(`No external entry in PUBLISHED_SHAPES for verb '${verb}'`);
  return entry.exitCode(outcome);
}
