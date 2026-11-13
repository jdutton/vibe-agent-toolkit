/**
 * The storage port and the run database, held by the compiler.
 *
 * `resources` declares one storage port, `FactStore`, with no SQL on it; `projection-sqlite`
 * implements it and declares, beside it, the run database: the one handle SQL runs on, which
 * holds no storage operation and is opened only from a whole `Projection`. Every claim here is
 * about types, and a `@ts-expect-error` in a test file asserts nothing (`tsc` never reads
 * `test/`), so the compiler is run on a probe module and its diagnostics are the oracle.
 *
 * Both packages are mapped to their `src/index.ts` through absolute `paths`, so the probe reads
 * the source as it stands: a seeded edit to either package reds this test with no rebuild. That
 * mapping is also why the probe can be an ordinary file in a temp directory.
 *
 * Every probe line but the two old-name imports compiles clean. Each one is written so that the
 * edit it guards against produces one diagnostic on that line and nowhere else:
 *
 * - SQL seeded onto the port reds the port line, and SQL seeded onto the factory's return reds
 *   the factory line (TS2339: a member read on `never`);
 * - the port's operations seeded onto the run database red the assignability line (TS2344);
 * - a relation-set parameter seeded onto the opener reds the opener line (TS2344).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES = safePath.resolve(import.meta.dirname, '..', '..', '..');

/** A package's `src/index.ts`, absolute: what the probe resolves the package name to. */
function sourceEntry(dir: string): string {
  return safePath.join(PACKAGES, dir, 'src', 'index.ts');
}

/** "has no exported member": plain (TS2305), or with a did-you-mean suggestion (TS2724). */
const NO_EXPORTED_MEMBER = [2305, 2724];

/** The probe, one statement per line; line 1 is the first entry. */
const PROBE_LINES = [
  "import type { FactStore, Projection } from '@vibe-agent-toolkit/resources';",
  "import { openRunDatabase, openSqliteFactStore, type RunDatabase } from '@vibe-agent-toolkit/projection-sqlite';",
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
  'type Expect<T extends true> = T;',
  "type SqlMember = 'query' | 'columns' | 'writeDerived' | 'exec';",
  '/** `T` when it carries no SQL member, `never` when it carries one. */',
  'type WithoutSql<T> = [Extract<keyof T, SqlMember>] extends [never] ? T : never;',
  "type Backend = typeof import('@vibe-agent-toolkit/projection-sqlite');",
  '/** Every export of the backend that hands back a run database. */',
  'type RunDatabaseOpeners = { [Name in keyof Backend]: Backend[Name] extends (...args: never[]) => infer R ? (Awaited<R> extends RunDatabase ? Name : never) : never }[keyof Backend];',
  'declare const port: WithoutSql<FactStore>;',
  'declare const factoryExtras: WithoutSql<Omit<ReturnType<typeof openSqliteFactStore>, keyof FactStore> & { readonly close: FactStore["close"] }>;',
  // 13: the port has no SQL member.
  'export const portCloses = port.close;',
  // 14: the file-backed factory adds no SQL member to the port.
  'export const factoryCloses = factoryExtras.close;',
  // 15, 16: the run database and the port are not interchangeable, either way.
  'export type RunDatabaseIsNotAPort = Expect<Equal<RunDatabase extends FactStore ? true : false, false>>;',
  'export type PortIsNotARunDatabase = Expect<Equal<FactStore extends RunDatabase ? true : false, false>>;',
  // 17: the opener takes a whole projection and nothing else — no relation set.
  'export type OpenerTakesAProjection = Expect<Equal<Parameters<typeof openRunDatabase>, [projection: Projection]>>;',
  // 18: and it is the only export that opens a run database.
  "export type OnlyOneOpener = Expect<Equal<RunDatabaseOpeners, 'openRunDatabase'>>;",
  // 19, 20: the old names are gone.
  "import type { ProjectionStore } from '@vibe-agent-toolkit/resources';",
  "import type { SqlQueryableStore } from '@vibe-agent-toolkit/projection-sqlite';",
];

/** The lines expected to carry a diagnostic, and the codes each may carry. */
const EXPECTED: Readonly<Record<number, readonly number[]>> = { 19: NO_EXPORTED_MEMBER, 20: NO_EXPORTED_MEMBER };

/** Semantic diagnostics of the probe, keyed by its 1-based line. */
function probeDiagnostics(): Map<number, number[]> {
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fact-store-probe-'));
  try {
    const probePath = safePath.join(directory, 'probe.ts');
    writeFileSync(probePath, PROBE_LINES.join('\n'), 'utf8');
    const program = ts.createProgram([probePath], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
      lib: ['lib.es2024.d.ts'],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      // The probe sits outside the repository, so `node`'s types are named by where they live.
      typeRoots: [safePath.join(PACKAGES, '..', 'node_modules', '@types')],
      types: ['node'],
      paths: {
        '@vibe-agent-toolkit/resources': [sourceEntry('resources')],
        '@vibe-agent-toolkit/projection-sqlite': [sourceEntry('projection-sqlite')],
      },
    });
    const probe = program.getSourceFile(probePath);
    if (probe === undefined) throw new Error('probe module was not loaded');
    const lineOf = (diagnostic: ts.Diagnostic): number =>
      probe.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    const grouped = Map.groupBy(program.getSemanticDiagnostics(probe), lineOf);
    return new Map([...grouped].map(([line, diagnostics]) => [line, diagnostics.map(({ code }) => code)]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the storage port and the run database', () => {
  it('keeps SQL off the port, keeps the two apart, and opens the run database only from a projection', () => {
    const diagnostics = probeDiagnostics();

    // Every diagnostic, and the line it sits on: one per expected line, none elsewhere.
    const unexpected = [...diagnostics].filter(([line, codes]) => {
      const allowed = EXPECTED[line];
      return allowed === undefined || codes.length !== 1 || !allowed.includes(codes[0] ?? 0);
    });
    expect(Object.fromEntries(unexpected)).toEqual({});
    expect([...diagnostics.keys()].sort((a, b) => a - b)).toEqual(Object.keys(EXPECTED).map(Number));
  });
});
