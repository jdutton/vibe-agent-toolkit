/**
 * `normalizePath` takes `within` as an options object so that a call written against the old
 * `normalizePath(...paths)` signature fails to compile instead of silently changing meaning: the
 * old two-path call was `normalizePath(rel, base)` and resolved `rel` against `base`, and a
 * positional `within` would accept the same call and resolve `rel` against cwd instead.
 *
 * A `@ts-expect-error` in a test file asserts nothing here — `tsc` never reads `test/` — so the
 * compiler is run on a probe module against the real source, and its diagnostics are the oracle.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { safePath } from '../../src/path-utils.js';

const UTILS_SRC = safePath.resolve(import.meta.dirname, '..', '..', 'src');
const PROBE = safePath.join(UTILS_SRC, '__normalize-path-probe__.ts');

/** Semantic diagnostics of `body` (after the import line), keyed by the probe's 1-based line. */
function diagnosticsOf(body: readonly string[]): Map<number, number[]> {
  const text = ["import { normalizePath } from './path-utils.js';", ...body].join('\n');
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, strict: true, exactOptionalPropertyTypes: true,
    noEmit: true, skipLibCheck: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, ...rest) =>
    safePath.resolve(name) === PROBE ? ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true) : getSourceFile(name, ...rest);
  host.fileExists = (name) => safePath.resolve(name) === PROBE || fileExists(name);
  host.readFile = (name) => (safePath.resolve(name) === PROBE ? text : readFile(name));
  const program = ts.createProgram([PROBE], options, host);
  const probe = program.getSourceFile(PROBE);
  if (probe === undefined) throw new Error('probe module was not loaded');
  const byLine = new Map<number, number[]>();
  for (const d of program.getSemanticDiagnostics(probe)) {
    const line = probe.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    byLine.set(line, [...(byLine.get(line) ?? []), d.code]);
  }
  return byLine;
}

describe('normalizePath signature', () => {
  it('rejects every spelling of the old variadic signature and accepts { within }', () => {
    const diagnostics = diagnosticsOf([
      "normalizePath('docs', '/base');", // line 2: the old (rel, base) — must NOT compile
      "normalizePath('/base');", // line 3: the old one-path form — `within` is required
      "normalizePath('/base', 'docs', 'a.md');", // line 4: the old variadic form
      "export const ok: string = normalizePath('/base/docs', { within: '/base' });", // line 5
    ]);
    // TS2345: argument not assignable; TS2554: wrong argument count.
    expect(Object.fromEntries(diagnostics)).toEqual({ 2: [2345], 3: [2554], 4: [2554] });
  });
});
