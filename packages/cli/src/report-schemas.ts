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
 *   Anthropic Admin API), passed through; `exitCodes` maps each outcome to the
 *   exit contract, since there is no envelope to derive one from.
 * - `artifact` — a VAT-owned shape that is not a run report: a stdout
 *   artifact (a config to paste), a file a verb writes, or a type a package
 *   barrel exports. `schemaFile` names the committed JSON Schema describing it
 *   (rendered from `schema`), or is `null` when none is published; `writer`
 *   says who puts a file artifact's bytes on disk.
 * - `input` / `schema-file` — a committed JSON Schema describing what an
 *   ADOPTER writes (config, manifests, frontmatter). Registered so the
 *   both-ways file check can tell "describes an input" from "unregistered".
 * - `legacy` / `stdout` — exactly `claude context`, the one verb not on the
 *   envelope through wave A (wave C replaces it). Its type admits no other verb.
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
 * `commands/`. Its `allowFiles` is exactly `commands/agent/run.ts` — whose
 * stdout is the agent's reply, not a document.
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

import { AGENT_BUILD_EXAMINED, AGENT_BUILD_REPORT_SCHEMA } from './commands/agent/build-schema.js';
import { AGENT_IMPORT_EXAMINED, AGENT_IMPORT_REPORT_SCHEMA } from './commands/agent/import-schema.js';
import { AGENT_INSTALL_EXAMINED, AGENT_INSTALL_REPORT_SCHEMA } from './commands/agent/install-schema.js';
import { AGENT_INSTALLED_EXAMINED, AGENT_INSTALLED_REPORT_SCHEMA } from './commands/agent/installed-schema.js';
import { AGENT_LIST_EXAMINED, AGENT_LIST_REPORT_SCHEMA } from './commands/agent/list-schema.js';
import { AGENT_UNINSTALL_EXAMINED, AGENT_UNINSTALL_REPORT_SCHEMA } from './commands/agent/uninstall-schema.js';
import { AGENT_VALIDATE_EXAMINED, AGENT_VALIDATE_REPORT_SCHEMA } from './commands/agent/validate-schema.js';
import { ARD_EMIT_REPORT_SCHEMA } from './commands/ard/emit-schema.js';
import { AUDIT_EXAMINED, AUDIT_REPORT_SCHEMA } from './commands/audit-schema.js';
import { AUDIT_SETTINGS_EXAMINED, AUDIT_SETTINGS_REPORT_SCHEMA } from './commands/audit-settings-schema.js';
import { CACHE_CLEAR_EXAMINED, CACHE_CLEAR_REPORT_SCHEMA } from './commands/cache/clear-schema.js';
import { MARKETPLACE_PUBLISH_EXAMINED, MARKETPLACE_PUBLISH_REPORT_SCHEMA } from './commands/claude/marketplace/publish-schema.js';
import { MARKETPLACE_VALIDATE_EXAMINED, MARKETPLACE_VALIDATE_REPORT_SCHEMA } from './commands/claude/marketplace/validate-schema.js';
import { ORG_NOT_IMPLEMENTED_EXAMINED, ORG_NOT_IMPLEMENTED_REPORT_SCHEMA } from './commands/claude/org/stubs-schema.js';
import { PLUGIN_BUILD_EXAMINED, PLUGIN_BUILD_REPORT_SCHEMA } from './commands/claude/plugin/build-schema.js';
import { PLUGIN_INSTALL_EXAMINED, PLUGIN_INSTALL_REPORT_SCHEMA } from './commands/claude/plugin/install-schema.js';
import { PLUGIN_LIST_EXAMINED, PLUGIN_LIST_REPORT_SCHEMA } from './commands/claude/plugin/list-schema.js';
import { PLUGIN_UNINSTALL_EXAMINED, PLUGIN_UNINSTALL_REPORT_SCHEMA } from './commands/claude/plugin/uninstall-schema.js';
import { CORPUS_SCAN_EXAMINED, CORPUS_SCAN_REPORT_SCHEMA } from './commands/corpus/scan-schema.js';
import { renderDoctorText } from './commands/doctor-render.js';
import { DOCTOR_EXAMINED, DOCTOR_REPORT_SCHEMA } from './commands/doctor-schema.js';
import { INVENTORY_EXAMINED, INVENTORY_REPORT_SCHEMA } from './commands/inventory-schema.js';
import { MCP_LIST_COLLECTIONS_EXAMINED, MCP_LIST_COLLECTIONS_REPORT_SCHEMA } from './commands/mcp/list-collections-schema.js';
import { OKF_VALIDATE_REPORT_SCHEMA } from './commands/okf/validate-schema.js';
import { ORCHESTRATOR_EXAMINED, ORCHESTRATOR_REPORT_SCHEMA } from './commands/orchestrator-schema.js';
import { RAG_CLEAR_REPORT_SCHEMA, RAG_DATABASE_EXAMINED, RAG_STATS_REPORT_SCHEMA } from './commands/rag/admin-schema.js';
import { RAG_INDEX_EXAMINED, RAG_INDEX_REPORT_SCHEMA } from './commands/rag/index-schema.js';
import { RAG_QUERY_EXAMINED, RAG_QUERY_REPORT_SCHEMA } from './commands/rag/query-schema.js';
import { CHECK_REPORT_SCHEMA } from './commands/resources/check-schema.js';
import { RESOURCES_QUERY_EXAMINED, RESOURCES_QUERY_REPORT_SCHEMA } from './commands/resources/query-schema.js';
import { RESOURCES_SCAN_EXAMINED, RESOURCES_SCAN_REPORT_SCHEMA } from './commands/resources/scan-schema.js';
import { RESOURCES_VALIDATE_EXAMINED, RESOURCES_VALIDATE_REPORT_SCHEMA } from './commands/resources/validate-schema.js';
import { SKILL_REVIEW_REPORT_SCHEMA } from './commands/skill/review-schema.js';
import { SKILL_TEST_CONFIGURE_EXAMINED, SKILL_TEST_CONFIGURE_REPORT_SCHEMA } from './commands/skill/test/configure-schema.js';
import { SKILL_TEST_RUN_EXAMINED, SKILL_TEST_RUN_REPORT_SCHEMA } from './commands/skill/test/run-schema.js';
import { SKILLS_BUILD_EXAMINED, SKILLS_BUILD_REPORT_SCHEMA } from './commands/skills/build-schema.js';
import { SKILLS_INSTALL_EXAMINED, SKILLS_INSTALL_REPORT_SCHEMA } from './commands/skills/install-schema.js';
import { SKILLS_LIST_EXAMINED, SKILLS_LIST_REPORT_SCHEMA } from './commands/skills/list-schema.js';
import { SKILLS_PACKAGE_EXAMINED, SKILLS_PACKAGE_REPORT_SCHEMA } from './commands/skills/package-schema.js';
import { SKILLS_VALIDATE_EXAMINED, SKILLS_VALIDATE_REPORT_SCHEMA } from './commands/skills/validate-schema.js';
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
  /** The adapter: the code each outcome of the external write ends on. */
  readonly exitCodes: Readonly<Record<ExternalOutcome['kind'], ExitCodeValue>>;
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
  /**
   * Who puts the bytes out: the document writer (`writeArtifact` /
   * `writeArtifactFile`), the projection store, or the skill-test harness
   * (`runSkillTestHarness`, the sole writer of a run's `results/`, which a
   * library cannot hand to the CLI's writer).
   */
  readonly writer: 'document-writer' | 'projection-store' | 'skill-test-harness';
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

/** The one verb not yet on the envelope; wave C replaces it. */
interface LegacyShape {
  readonly kind: 'legacy';
  readonly channel: 'stdout';
  readonly verbs: readonly ['claude context'];
  readonly reason: string;
}

export type PublishedShape = ReportShape | ExternalShape | PublishedArtifactShape | ExportedTypeShape | InputShape | LegacyShape;

/** Who puts an artifact's bytes out, named once. */
const DOCUMENT_WRITER = 'document-writer';

/** The verb publishing the corpus scan's file artifacts, named once. */
const CORPUS_SCAN = 'corpus scan';

/** The Admin API adapter: only a write that fully landed is `OK`; a partial or failed one is `ERROR`. */
const ADMIN_API_EXIT_CODES = { ok: ExitCode.OK, partial: ExitCode.ERROR, failed: ExitCode.ERROR } as const;

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
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['audit'],
    name: 'audit',
    schema: AUDIT_REPORT_SCHEMA,
    examined: AUDIT_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['inventory'],
    name: 'inventory',
    schema: INVENTORY_REPORT_SCHEMA,
    examined: INVENTORY_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['audit settings'],
    name: 'audit-settings',
    schema: AUDIT_SETTINGS_REPORT_SCHEMA,
    examined: AUDIT_SETTINGS_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['resources validate'],
    name: 'resources-validate',
    schema: RESOURCES_VALIDATE_REPORT_SCHEMA,
    examined: RESOURCES_VALIDATE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['resources scan'],
    name: 'resources-scan',
    schema: RESOURCES_SCAN_REPORT_SCHEMA,
    examined: RESOURCES_SCAN_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['resources query'],
    name: 'resources-query',
    schema: RESOURCES_QUERY_REPORT_SCHEMA,
    examined: RESOURCES_QUERY_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skills validate'],
    name: 'skills-validate',
    schema: SKILLS_VALIDATE_REPORT_SCHEMA,
    examined: SKILLS_VALIDATE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skills build'],
    name: 'skills-build',
    schema: SKILLS_BUILD_REPORT_SCHEMA,
    examined: SKILLS_BUILD_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skills package'],
    name: 'skills-package',
    schema: SKILLS_PACKAGE_REPORT_SCHEMA,
    examined: SKILLS_PACKAGE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skills list'],
    name: 'skills-list',
    schema: SKILLS_LIST_REPORT_SCHEMA,
    examined: SKILLS_LIST_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skills install'],
    name: 'skills-install',
    schema: SKILLS_INSTALL_REPORT_SCHEMA,
    examined: SKILLS_INSTALL_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skill test run'],
    name: 'skill-test-run',
    schema: SKILL_TEST_RUN_REPORT_SCHEMA,
    examined: SKILL_TEST_RUN_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['skill test configure'],
    name: 'skill-test-configure',
    schema: SKILL_TEST_CONFIGURE_REPORT_SCHEMA,
    examined: SKILL_TEST_CONFIGURE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['doctor'],
    name: 'doctor',
    schema: DOCTOR_REPORT_SCHEMA,
    examined: DOCTOR_EXAMINED,
    // The human check block, every check listed; under yaml/json it goes to stderr instead.
    renderText: renderDoctorText,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['cache clear'],
    name: 'cache-clear',
    schema: CACHE_CLEAR_REPORT_SCHEMA,
    examined: CACHE_CLEAR_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['rag index'],
    name: 'rag-index',
    schema: RAG_INDEX_REPORT_SCHEMA,
    examined: RAG_INDEX_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['rag query'],
    name: 'rag-query',
    schema: RAG_QUERY_REPORT_SCHEMA,
    examined: RAG_QUERY_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['rag stats'],
    name: 'rag-stats',
    schema: RAG_STATS_REPORT_SCHEMA,
    examined: RAG_DATABASE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['rag clear'],
    name: 'rag-clear',
    schema: RAG_CLEAR_REPORT_SCHEMA,
    examined: RAG_DATABASE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['mcp list-collections'],
    name: 'mcp-list-collections',
    schema: MCP_LIST_COLLECTIONS_REPORT_SCHEMA,
    examined: MCP_LIST_COLLECTIONS_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: [CORPUS_SCAN],
    name: 'corpus-scan',
    schema: CORPUS_SCAN_REPORT_SCHEMA,
    examined: CORPUS_SCAN_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude marketplace validate'],
    name: 'claude-marketplace-validate',
    schema: MARKETPLACE_VALIDATE_REPORT_SCHEMA,
    examined: MARKETPLACE_VALIDATE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent validate'],
    name: 'agent-validate',
    schema: AGENT_VALIDATE_REPORT_SCHEMA,
    examined: AGENT_VALIDATE_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent build'],
    name: 'agent-build',
    schema: AGENT_BUILD_REPORT_SCHEMA,
    examined: AGENT_BUILD_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent import'],
    name: 'agent-import',
    schema: AGENT_IMPORT_REPORT_SCHEMA,
    examined: AGENT_IMPORT_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent installed'],
    name: 'agent-installed',
    schema: AGENT_INSTALLED_REPORT_SCHEMA,
    examined: AGENT_INSTALLED_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent list'],
    name: 'agent-list',
    schema: AGENT_LIST_REPORT_SCHEMA,
    examined: AGENT_LIST_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent install'],
    name: 'agent-install',
    schema: AGENT_INSTALL_REPORT_SCHEMA,
    examined: AGENT_INSTALL_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['agent uninstall'],
    name: 'agent-uninstall',
    schema: AGENT_UNINSTALL_REPORT_SCHEMA,
    examined: AGENT_UNINSTALL_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude plugin list'],
    name: 'claude-plugin-list',
    schema: PLUGIN_LIST_REPORT_SCHEMA,
    examined: PLUGIN_LIST_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude plugin install'],
    name: 'claude-plugin-install',
    schema: PLUGIN_INSTALL_REPORT_SCHEMA,
    examined: PLUGIN_INSTALL_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude plugin uninstall'],
    name: 'claude-plugin-uninstall',
    schema: PLUGIN_UNINSTALL_REPORT_SCHEMA,
    examined: PLUGIN_UNINSTALL_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude plugin build'],
    name: 'claude-plugin-build',
    schema: PLUGIN_BUILD_REPORT_SCHEMA,
    examined: PLUGIN_BUILD_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    verbs: ['claude marketplace publish'],
    name: 'claude-marketplace-publish',
    schema: MARKETPLACE_PUBLISH_REPORT_SCHEMA,
    examined: MARKETPLACE_PUBLISH_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    // The not-implemented stubs: each only ever publishes the error branch (NOT_IMPLEMENTED).
    verbs: [
      'claude org api-keys update',
      'claude org invites create',
      'claude org invites delete',
      'claude org users update',
      'claude org users remove',
      'claude org workspaces create',
      'claude org workspaces archive',
      'claude org workspaces members add',
      'claude org workspaces members update',
      'claude org workspaces members remove',
    ],
    name: 'claude-org-not-implemented',
    schema: ORG_NOT_IMPLEMENTED_REPORT_SCHEMA,
    examined: ORG_NOT_IMPLEMENTED_EXAMINED,
  },
  {
    kind: 'report',
    channel: 'stdout',
    // ONE shape for the three: each folds its phases' reports the same way.
    verbs: ['build', 'validate', 'verify'],
    name: 'orchestrator',
    schema: ORCHESTRATOR_REPORT_SCHEMA,
    examined: ORCHESTRATOR_EXAMINED,
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
  reason: 'Anthropic Admin API objects passed through as the API returns them (`has_more`, `data[]`, snake_case). Renaming them would make VAT a second schema for a document Anthropic owns. A run that threw publishes `{ error: { code, message } }` instead (endWithExternalRefusal).',
  exitCodes: ADMIN_API_EXIT_CODES,
} as const satisfies ExternalShape;

const EXTERNALS: readonly ExternalShape[] = [CLAUDE_ORG_EXTERNAL];

const LEGACY = [
  {
    kind: 'legacy',
    channel: 'stdout',
    verbs: ['claude context'],
    reason: 'The one legacy document through wave A, published through writeLegacyDocument; wave C replaces the verb.',
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
    channel: 'stdout',
    name: 'skill-test-config',
    publishers: ['skill test configure'],
    schema: null,
    schemaFile: null,
    writer: DOCUMENT_WRITER,
    reason: '`skill test configure --print`: the updated vibe-agent-toolkit.config.yaml text, verbatim, for redirecting over the file; its shape is the project config.',
  },
  {
    kind: 'artifact',
    channel: 'file',
    name: 'friction-report',
    publishers: ['skill test run'],
    schema: FrictionReportSchema,
    schemaFile: 'packages/agent-skills/schemas/friction-report.json',
    writer: 'skill-test-harness',
    reason: 'The graded friction report a skill test run writes into its results/ directory (`data.artifacts.frictionReport`), validated against its schema before the run reports.',
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
    schema: AUDIT_REPORT_SCHEMA,
    schemaFile: 'packages/cli/schemas/corpus-audit.json',
    writer: DOCUMENT_WRITER,
    reason: 'corpus scan `<name>-audit.yaml`: the `vat audit` report for one plugin, the same envelope and schema the verb publishes.',
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

/** A verb of an `external` entry: its payload is passed through, its code decided by the entry's adapter. */
export type ExternalVerb = (typeof CLAUDE_ORG_EXTERNAL)['verbs'][number];

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
  return entry.exitCodes[outcome.kind];
}
