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
 * edit it guards against produces a diagnostic on that line (TS2344, a constraint not met):
 *
 * - the port's members are an exact list, held both ways, and so are the file-backed factory's.
 *   A member of any kind added to either, SQL or not, reds its line; one added to the port reds
 *   the factory's line too, since the factory returns the port. Adding an operation to the port,
 *   or changing what the factory returns, therefore means editing this list on purpose;
 * - the run database and the port are not assignable to each other, either way;
 * - the opener takes a whole projection and nothing else;
 * - no other export produces a run database: not a function returning one, possibly
 *   `undefined` or behind a promise, and not a class constructing one.
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
  '/** The port, member by member. Adding an operation to it means adding it here, deliberately. */',
  "type PortMembers = 'writeBlobFacts' | 'readBlobFacts' | 'writeExtent' | 'readExtent' | 'close';",
  "type Backend = typeof import('@vibe-agent-toolkit/projection-sqlite');",
  '/** What an export produces: a constructor\'s instance, or a function\'s awaited result. */',
  'type Produces<T> = T extends abstract new (...args: never[]) => infer I ? I : T extends (...args: never[]) => infer R ? Awaited<R> : never;',
  '/** Every export of the backend that produces a run database, in any member of what it produces. */',
  'type RunDatabaseOpeners = { [Name in keyof Backend]: [Extract<Produces<Backend[Name]>, RunDatabase>] extends [never] ? never : Name }[keyof Backend];',
  // 12, 13: the port is exactly its member list, both ways.
  'export type PortAddsNoMember = Expect<Equal<Exclude<keyof FactStore, PortMembers>, never>>;',
  'export type PortLacksNoMember = Expect<Equal<Exclude<PortMembers, keyof FactStore>, never>>;',
  // 14, 15: and so is what the file-backed factory returns.
  'export type FactoryAddsNoMember = Expect<Equal<Exclude<keyof ReturnType<typeof openSqliteFactStore>, PortMembers>, never>>;',
  'export type FactoryLacksNoMember = Expect<Equal<Exclude<PortMembers, keyof ReturnType<typeof openSqliteFactStore>>, never>>;',
  // 16, 17: the run database and the port are not interchangeable, either way.
  'export type RunDatabaseIsNotAPort = Expect<Equal<RunDatabase extends FactStore ? true : false, false>>;',
  'export type PortIsNotARunDatabase = Expect<Equal<FactStore extends RunDatabase ? true : false, false>>;',
  // 18: the opener takes a whole projection and nothing else — no relation set.
  'export type OpenerTakesAProjection = Expect<Equal<Parameters<typeof openRunDatabase>, [projection: Projection]>>;',
  // 19: and it is the only export that produces a run database.
  "export type OnlyOneOpener = Expect<Equal<RunDatabaseOpeners, 'openRunDatabase'>>;",
  // 20, 21: the old names are gone.
  "import type { ProjectionStore } from '@vibe-agent-toolkit/resources';",
  "import type { SqlQueryableStore } from '@vibe-agent-toolkit/projection-sqlite';",
];

/** The lines expected to carry a diagnostic, and the codes each may carry. */
const EXPECTED: Readonly<Record<number, readonly number[]>> = { 20: NO_EXPORTED_MEMBER, 21: NO_EXPORTED_MEMBER };

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
