/**
 * `PUBLISHED_SHAPES` is the one list of every shape VAT publishes, and every
 * claim it makes is asserted BOTH ways against the tree:
 *
 * - every writer call in `commands/` names a registered verb or artifact, and
 *   every registered one has its writer call;
 * - every Commander leaf with an action is covered by exactly one entry;
 * - the one `legacy` entry is `claude context`, a live, unmigrated leaf;
 * - every committed JSON Schema under `packages/*` is registered, and every
 *   registered one exists (and, for an artifact, is what its Zod renders);
 * - every exported `*Result` / `*Report` / `*Document` type of a published
 *   package barrel is registered, and every registered export exists;
 * - every report entry is the union envelope and declares its denominator.
 *
 * A registry asserted only one way is a hand-kept list; this file is what makes
 * it a contract.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { ExitCode, REPORT_ENVELOPE_KEYS } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils/fs';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findEmittedSchemaDrift, renderEmittedSchema } from '../../dev-tools/src/pin-emitted-schemas.js';
import { CLI_SCHEMA_TARGETS, CLI_SCHEMAS_DIR } from '../scripts/generate-json-schemas.js';
import { COMMAND_LOADERS } from '../src/command-loaders.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { exitCodeForExternal, PUBLISHED_SHAPES, type PublishedShape } from '../src/report-schemas.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');
const COMMANDS_DIR = safePath.join(REPO_ROOT, 'packages', 'cli', 'src', 'commands');
const byName = (a: string, b: string): number => a.localeCompare(b);

type Kind<K extends PublishedShape['kind']> = Extract<PublishedShape, { kind: K }>;
const ofKind = <K extends PublishedShape['kind']>(kind: K): Kind<K>[] =>
  PUBLISHED_SHAPES.filter((shape): shape is Kind<K> => shape.kind === kind);

const reportEntries = ofKind('report');
const externalEntries = ofKind('external');
const legacyEntries = ofKind('legacy');
const artifactEntries = ofKind('artifact');
type ExportEntry = Extract<Kind<'artifact'>, { channel: 'export' }>;
type PublishedArtifact = Exclude<Kind<'artifact'>, ExportEntry>;
const published = artifactEntries.filter((entry): entry is PublishedArtifact => entry.channel !== 'export');
const stdoutArtifacts = published.filter((entry) => entry.channel === 'stdout');
const fileArtifacts = published.filter((entry) => entry.channel === 'file');
const exportEntries = artifactEntries.filter((entry): entry is ExportEntry => entry.channel === 'export');
const inputEntries = ofKind('input');

const reportVerbs = new Set(reportEntries.flatMap((entry) => entry.verbs));
const legacyVerbs = new Set(legacyEntries.flatMap((entry) => entry.verbs));

/** Leaves whose stdout is a protocol stream, not a document. Asserted both ways. */
const PROTOCOL_LEAVES = ['agent run', 'mcp serve'];

/** Every `.ts` under `packages/cli/src/commands`, as text. */
function commandSources(): string[] {
  return readdirSync(COMMANDS_DIR, { recursive: true, encoding: 'utf-8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(safePath.join(COMMANDS_DIR, file), 'utf-8'));
}

/**
 * A writer call with a literal first argument. `executeOrgCommand` counts as
 * `writeExternalDocument`: it is the org lane's one route to it, and each
 * external verb names itself there — the writer call inside it takes a variable.
 */
const WRITER_CALL = /\b(endWithReport|writeDocument|endWithRefusal|readForwardedDocument|writeExternalDocument|executeOrgCommand|writeArtifact|writeArtifactFile|writeLegacyDocument)\(\s*'([^']+)'/g;

/** Every literal-first-argument writer call in `commands/`, as `[function, name]`. */
function writerCalls(): Array<readonly [string, string]> {
  return commandSources().flatMap((source) =>
    [...source.matchAll(WRITER_CALL)].map((match) => {
      const fn = match[1] === 'executeOrgCommand' ? 'writeExternalDocument' : match[1] ?? '';
      return [fn, match[2] ?? ''] as const;
    }),
  );
}

/** The registry key a writer call must resolve to, per writer function. */
function registeredNamesFor(fn: string): ReadonlySet<string> {
  switch (fn) {
    case 'writeExternalDocument':
      return new Set(externalEntries.flatMap((entry) => entry.verbs));
    case 'writeArtifact':
      return new Set(stdoutArtifacts.map((entry) => entry.name));
    case 'writeArtifactFile':
      return new Set(fileArtifacts.map((entry) => entry.name));
    case 'writeLegacyDocument':
      return legacyVerbs;
    default:
      return reportVerbs;
  }
}

/** Whether a report entry's `ok` branch publishes `data: null` — a verb that has no data to publish. */
function hasNoData(entry: (typeof reportEntries)[number]): boolean {
  const union = (entry.schema as z.ZodEffects<z.ZodTypeAny>).innerType() as z.ZodDiscriminatedUnion<'status', z.AnyZodObject[]>;
  const ok = union.options.find((option) => option.shape.status.value === 'ok');
  return ok?.shape.data instanceof z.ZodNull;
}

describe('writer calls ↔ registry', () => {
  const calls = writerCalls();

  it('every writer call names a registered verb, and every registered stdout verb has a writer call', () => {
    // The scan must see something, or an emptied scan would pass both ways.
    expect(calls.length).toBeGreaterThan(0);
    const unregistered = calls.filter(([fn, name]) => !registeredNamesFor(fn).has(name));
    expect(unregistered).toEqual([]);

    // A verb that publishes data must have an endWithReport/writeDocument call. Only
    // a verb with NO data (`data: z.null()` — a not-implemented stub) may be
    // covered by its refusal alone: it only ever refuses.
    const reportWriters = new Set(
      calls.filter(([fn]) => fn === 'endWithReport' || fn === 'writeDocument').map(([, name]) => name),
    );
    const refusers = new Set(calls.filter(([fn]) => fn === 'endWithRefusal').map(([, name]) => name));
    const refusalOnly = new Set(reportEntries.filter(hasNoData).flatMap((entry) => entry.verbs));
    expect([...refusalOnly].length).toBeGreaterThan(0);
    expect(
      [...reportVerbs].filter((verb) => !reportWriters.has(verb) && !(refusalOnly.has(verb) && refusers.has(verb))),
    ).toEqual([]);

    const called = new Set(calls.map(([fn, name]) => `${fn}:${name}`));
    const publishers = [
      // Per VERB: an entry is covered only when every one of its verbs has its call.
      ...externalEntries.flatMap((entry) => entry.verbs.map((verb) => ({ key: `external:${verb}`, has: called.has(`writeExternalDocument:${verb}`) }))),
      ...stdoutArtifacts.map((entry) => ({ key: `artifact:${entry.name}`, has: called.has(`writeArtifact:${entry.name}`) })),
    ];
    expect(publishers.filter((p) => !p.has).map((p) => p.key)).toEqual([]);
  });

  it('every file artifact has a writeArtifactFile call and vice versa', () => {
    const called = new Set(calls.filter(([fn]) => fn === 'writeArtifactFile').map(([, name]) => name));
    const written = fileArtifacts.filter((entry) => entry.writer === 'document-writer');
    expect(written.filter((entry) => !called.has(entry.name)).map((entry) => entry.name)).toEqual([]);
    // A projection relation reaches disk through the projection store, and a skill-test
    // artifact through the harness that owns results/ — never through the CLI's writer.
    const misrouted = fileArtifacts.filter((entry) => entry.writer !== 'document-writer' && called.has(entry.name));
    expect(misrouted.map((entry) => entry.name)).toEqual([]);
  });
});

/** Whether a Commander node has its own action (commander keeps it private). */
function hasAction(command: Command): boolean {
  return (command as unknown as { _actionHandler: unknown })._actionHandler != null;
}

function actionLeaves(command: Command, prefix: readonly string[]): string[] {
  const path = [...prefix, command.name()];
  const own = hasAction(command) ? [path.join(' ')] : [];
  return [...own, ...command.commands.flatMap((sub) => actionLeaves(sub, path))];
}

/** Every `vat` node with an action — the loaders' trees plus `doctor`, which attaches itself. */
async function liveLeaves(): Promise<string[]> {
  const leaves: string[] = [];
  for (const load of Object.values(COMMAND_LOADERS)) leaves.push(...actionLeaves(await load(), []));
  const program = new Command('vat');
  doctorCommand(program);
  for (const sub of program.commands) leaves.push(...actionLeaves(sub, []));
  return leaves;
}

/**
 * How many entries cover `leaf` as a stdout document.
 *
 * A stdout artifact counts only for a leaf with no document entry: a leaf may
 * publish its report on one lane and an artifact on another (`skill test
 * configure` writes its report, or under `--print` the config text alone), and
 * the report is what covers it. The price: such a leaf could carry a second
 * artifact unseen by this count.
 */
function coverageOf(leaf: string): number {
  const documents = [
    ...reportEntries.map((entry) => entry.verbs),
    ...externalEntries.map((entry) => entry.verbs),
    ...legacyEntries.map((entry) => entry.verbs),
  ].filter((verbs) => verbs.includes(leaf)).length;
  if (documents > 0) return documents;
  return stdoutArtifacts.filter((entry) => entry.publishers.includes(leaf)).length;
}

describe('Commander leaves ↔ registry', () => {
  it('every Commander leaf with an action is covered by exactly one entry', async () => {
    const leaves = await liveLeaves();
    expect(leaves.length).toBeGreaterThan(0);

    const miscovered = leaves
      .filter((leaf) => !PROTOCOL_LEAVES.includes(leaf))
      .map((leaf) => ({ leaf, entries: coverageOf(leaf) }))
      .filter(({ entries }) => entries !== 1);
    expect(miscovered).toEqual([]);

    // The exception list, both ways: each is live, and none publishes a document.
    expect(PROTOCOL_LEAVES.filter((leaf) => !leaves.includes(leaf))).toEqual([]);
    const documented = PROTOCOL_LEAVES.filter((leaf) =>
      reportVerbs.has(leaf) || legacyVerbs.has(leaf) || externalEntries.some((entry) => entry.verbs.includes(leaf)));
    expect(documented).toEqual([]);
  });

  it('no legacy entry names a verb that publishes through a report entry', () => {
    expect([...legacyVerbs].filter((verb) => reportVerbs.has(verb))).toEqual([]);
    const written = new Set(writerCalls().filter(([fn]) => fn === 'endWithReport' || fn === 'writeDocument').map(([, name]) => name));
    expect([...legacyVerbs].filter((verb) => written.has(verb))).toEqual([]);
  });

  it('the only legacy entry is claude context', () => {
    expect(legacyEntries.map((entry) => entry.verbs)).toEqual([['claude context']]);
  });

  it('every legacy verb is still a live Commander leaf', async () => {
    const leaves = new Set(await liveLeaves());
    expect([...legacyVerbs].filter((verb) => !leaves.has(verb))).toEqual([]);
  });

  it('gives every non-report entry a reason', () => {
    const unexplained = PUBLISHED_SHAPES.filter((shape) => shape.kind !== 'report' && shape.reason.length < 20);
    expect(unexplained).toEqual([]);
  });
});

const PACKAGES_DIR = safePath.join(REPO_ROOT, 'packages');

/** Every directory under `packages/`. */
function packageNames(): string[] {
  // A symlinked package directory is not a workspace package; it is skipped, not followed.
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
    .map((entry) => entry.name);
}

/** Every committed JSON Schema under `packages/<pkg>/schemas/`, repo-relative. */
function committedSchemaFiles(): string[] {
  return packageNames().flatMap((pkg) => {
    const dir = safePath.join(PACKAGES_DIR, pkg, 'schemas');
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return files.filter((file) => file.endsWith('.json')).map((file) => `packages/${pkg}/schemas/${file}`);
  });
}

/** Every schema file the registry claims, one row per claim. */
function claimedSchemaFiles(): string[] {
  return [
    ...reportEntries.map((entry) => `packages/cli/schemas/${entry.name}.json`),
    ...[...stdoutArtifacts, ...fileArtifacts].flatMap((entry) => (entry.schemaFile === null ? [] : [entry.schemaFile])),
    ...inputEntries.map((entry) => entry.file),
  ];
}

describe('JSON Schema files ↔ registry', () => {
  it('every JSON Schema file under packages/*/schemas is registered and every registered one exists', () => {
    const committed = committedSchemaFiles().sort(byName);
    const claimed = claimedSchemaFiles();
    expect(committed.length).toBeGreaterThan(0);
    // Once each: a file claimed twice is two contracts for one shape.
    expect(claimed.filter((file, index) => claimed.indexOf(file) !== index)).toEqual([]);
    expect([...claimed].sort(byName)).toStrictEqual(committed);
  });

  it('an artifact publishes a schema file exactly when it carries a schema, and the file is its render', () => {
    for (const entry of [...stdoutArtifacts, ...fileArtifacts]) {
      expect(entry.schemaFile === null, entry.name).toBe(entry.schema === null);
      if (entry.schemaFile === null || entry.schema === null) continue;
      const committed = readFileSync(safePath.join(REPO_ROOT, entry.schemaFile), 'utf-8');
      expect(committed, entry.name).toBe(renderEmittedSchema({ name: entry.name, schema: entry.schema }));
    }
  });

  it('packages/cli/schemas is committed in the state `generate:schemas` produces', () => {
    expect(CLI_SCHEMA_TARGETS.length).toBeGreaterThan(0);
    expect(findEmittedSchemaDrift(CLI_SCHEMAS_DIR, CLI_SCHEMA_TARGETS)).toEqual([]);
  });
});

// Matched against the barrel with line comments dropped and whitespace collapsed to one space.
const EXPORT_BLOCK = /export (type )?\{([^}]*)\}/g;
const EXPORT_DECLARATION = /export (?:interface|type) (\w+)/g;
const TYPE_NAME = /^[A-Z]\w*$/;
const PUBLISHED_SUFFIX = /(Result|Report|Document)$/;
/** A PascalCase type name ending in Result/Report/Document — the bare names (`Report`) included. */
const isPublishedTypeName = (name: string): boolean => TYPE_NAME.test(name) && PUBLISHED_SUFFIX.test(name);

/** One `{ … }` item's exported name, when it names a type. */
function typeItemName(raw: string, typeOnlyBlock: boolean): string | undefined {
  const item = raw.trim();
  const typed = typeOnlyBlock || item.startsWith('type ');
  const name = (item.startsWith('type ') ? item.slice('type '.length) : item).split(' as ').pop()?.trim() ?? '';
  return typed && name !== '' ? name : undefined;
}

/** A module's text with line comments dropped and whitespace collapsed, so every export reads on one line. */
function flatten(source: string): string {
  return source
    .split('\n')
    .map((line) => (line.includes('//') ? line.slice(0, line.indexOf('//')) : line))
    .join(' ')
    .replaceAll(/\s+/g, ' ');
}

/** The type names a module declares or lists in an export block — not what it re-exports wholesale. */
function ownTypeNames(flat: string): string[] {
  const names: string[] = [];
  for (const match of flat.matchAll(EXPORT_BLOCK)) {
    for (const raw of (match[2] ?? '').split(',')) {
      const name = typeItemName(raw, match[1] !== undefined);
      if (name !== undefined) names.push(name);
    }
  }
  for (const match of flat.matchAll(EXPORT_DECLARATION)) names.push(match[1] ?? '');
  return names;
}

// `export * from './x.js'` — a wholesale re-export (not `export * as ns`, which exports one name).
const EXPORT_STAR = /export \* from '(\.[^']+)'/g;

/** The `.ts` module a relative `.js` specifier names: the file, or the directory's `index.ts`. */
function resolveModule(fromFile: string, specifier: string): string {
  const base = safePath.resolve(safePath.join(fromFile, '..'), specifier.replace(/\.js$/, ''));
  return existsSync(`${base}.ts`) ? `${base}.ts` : safePath.join(base, 'index.ts');
}

/**
 * The type names a module exports, FOLLOWING every `export * from` recursively —
 * eleven barrels publish most of their types that way, and a scan that read
 * only the barrel's own text registered none of them.
 */
function exportedTypeNames(file: string, seen: Set<string> = new Set()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const flat = flatten(readFileSync(file, 'utf-8'));
  const reexported = [...flat.matchAll(EXPORT_STAR)].flatMap((match) =>
    exportedTypeNames(resolveModule(file, match[1] ?? ''), seen));
  return [...ownTypeNames(flat), ...reexported];
}

/** `<package name>:<type>` for every published barrel's `*Result|*Report|*Document` type. */
function exportedPublishedTypes(): string[] {
  return packageNames().flatMap((pkg) => {
    const manifestPath = safePath.join(PACKAGES_DIR, pkg, 'package.json');
    const barrel = safePath.join(PACKAGES_DIR, pkg, 'src', 'index.ts');
    if (!existsSync(manifestPath) || !existsSync(barrel)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name: string; private?: boolean };
    if (manifest.private === true) return [];
    return [...new Set(exportedTypeNames(barrel).filter(isPublishedTypeName))]
      .map((name) => `${manifest.name}:${name}`);
  });
}

describe('exported library types ↔ registry', () => {
  it('every exported *Result/*Report/*Document type in a package barrel is registered, and every registered export exists', () => {
    const exported = exportedPublishedTypes().sort(byName);
    expect(exported.length).toBeGreaterThan(0);
    const registered = exportEntries.map((entry) => `${entry.package}:${entry.typeName}`);
    expect(registered.filter((key, index) => registered.indexOf(key) !== index)).toEqual([]);
    expect([...registered].sort(byName)).toStrictEqual(exported);
  });
});

describe('report entries', () => {
  it('every report entry declares its examined denominator', () => {
    for (const entry of reportEntries) {
      expect(entry.examined.unit.length, entry.name).toBeGreaterThan(0);
      expect(entry.examined.whenZero.length, entry.name).toBeGreaterThan(20);
    }
  });

  it.each(reportEntries.map((entry) => [entry.name, entry] as const))('every report entry schema is the union envelope: %s', (_name, entry) => {
    expect(entry.schema).toBeInstanceOf(z.ZodEffects);
    const union = (entry.schema as z.ZodEffects<z.ZodTypeAny>).innerType();
    expect(union).toBeInstanceOf(z.ZodDiscriminatedUnion);
    const options = (union as z.ZodDiscriminatedUnion<'status', z.AnyZodObject[]>).options;
    expect(options.map((option) => option.shape.status.value).sort(byName)).toStrictEqual(['error', 'findings', 'ok']);
    for (const option of options) {
      expect(option._def.unknownKeys).toBe('strict');
      for (const key of REPORT_ENVELOPE_KEYS) expect(Object.keys(option.shape)).toContain(key);
    }
  });

  it('names each schema artifact and each verb once', () => {
    const names = [...stdoutArtifacts, ...fileArtifacts].map((entry) => entry.name);
    const all = [...reportEntries.map((entry) => entry.name), ...names];
    expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual([]);
    const verbs = [...reportEntries, ...externalEntries, ...legacyEntries].flatMap((entry) => entry.verbs);
    expect(verbs.filter((verb, index) => verbs.indexOf(verb) !== index)).toEqual([]);
  });
});

describe('the external exit adapter', () => {
  it('maps ok to 0 and partial or failed Admin API writes to 2', () => {
    const verb = externalEntries[0]?.verbs[0] ?? '';
    expect(exitCodeForExternal(verb, { kind: 'ok' })).toBe(ExitCode.OK);
    expect(exitCodeForExternal(verb, { kind: 'partial', failed: 1 })).toBe(ExitCode.ERROR);
    expect(exitCodeForExternal(verb, { kind: 'failed', cause: 'boom' })).toBe(ExitCode.ERROR);
  });
});
