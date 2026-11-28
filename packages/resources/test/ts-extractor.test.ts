/**
 * The `ts` instance's extractor (`projection/ts-extractor.ts`), run in-process with the vendored
 * TypeScript: the synthetic names every parse runs under, the nesting pre-scan, parse errors as
 * defects, and the `ts__files` row.
 *
 * Nothing here parses deep text: a parse at `outputDepth` belongs in a parse worker at the
 * configured `stackMb` (the pool test). The pre-scan is measured directly at the default cap, and
 * the extractor is run past a small cap derived from it.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import {
  extractTsRows,
  loadTsExtract,
  nestingDepth,
  SYNTHETIC_NAMES,
  type TsExtraction,
} from '../src/projection/ts-extractor.js';
import type { TsVariant } from '../src/schemas/projection-ts.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

const VARIANTS: readonly TsVariant[] = ['ts', 'dts', 'tsx', 'js'];

/** The vendored module with `createSourceFile` wrapped to record the name of every call. */
function recordingModule(): { readonly module: typeof ts; readonly names: string[] } {
  const names: string[] = [];
  const original = typescript.createSourceFile.bind(typescript);
  const wrapped: typeof ts.createSourceFile = (fileName, ...rest) => {
    names.push(fileName);
    return original(fileName, ...rest);
  };
  const module = Object.create(typescript, { createSourceFile: { value: wrapped } }) as typeof ts;
  return { module, names };
}

/** Extract under the default limits. */
function extract(text: string, variant: TsVariant, module: typeof ts = typescript): TsExtraction {
  return extractTsRows(module, { text, variant }, DEFAULT_PARSE_LIMITS);
}

/** The `ts__files` row of an extraction that must be rows. */
function fileRowOf(extraction: TsExtraction): { moduleSyntax: boolean; hasJsx: boolean } {
  if (extraction.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(extraction)}`);
  return extraction.rows.files[0];
}

/** Expect a `TS_PARSE_ERROR` naming `code` at `line`, and no source text. */
function expectParseError(extraction: TsExtraction, code: number, line: number): void {
  expect(extraction).toMatchObject({ outcome: 'defect', code: 'TS_PARSE_ERROR' });
  if (extraction.outcome !== 'defect') return;
  expect(extraction.message.startsWith(`TS${String(code)} at line ${String(line)}, column `)).toBe(true);
  expect(extraction.message).toMatch(/, column \d+$/);
}

describe('synthetic names (path independence)', () => {
  it('passes every createSourceFile call one of the four synthetic names, its variant\'s', () => {
    const { module, names } = recordingModule();
    for (const variant of VARIANTS) {
      const before = names.length;
      extract('export const a = 1;', variant, module);
      expect(names.slice(before)).toEqual([SYNTHETIC_NAMES[variant]]);
    }
    expect(new Set(names)).toEqual(new Set(['vat.ts', 'vat.d.ts', 'vat.tsx', 'vat.js']));
  });

  it('answers identical bytes identically within one variant (`.ts`, `.mts` and `.cts` all route `ts`)', () => {
    const text = 'import a from "a";\nexport const b = a;\n';
    expect(extract(text, 'ts')).toEqual(extract(text, 'ts'));
  });

  it('answers the same bytes differently as `ts` and `dts` where the ambient context changes the parse', () => {
    // Outside a declaration file a module's top-level `await` is reparsed as an await expression,
    // so a bare `await;` misses its operand; a declaration file is never reparsed.
    const text = 'export {};\nawait;\n';
    expectParseError(extract(text, 'ts'), 1109, 2);
    expect(fileRowOf(extract(text, 'dts'))).toEqual({ moduleSyntax: true, hasJsx: false });
  });
});

describe('parse errors are defects', () => {
  it('refuses JSX in a `ts` file and reads the same bytes as `tsx`', () => {
    const text = 'const a = 1;\nconst b = <div/>;\n';
    expectParseError(extract(text, 'ts'), 1005, 2);
    expect(fileRowOf(extract(text, 'tsx'))).toEqual({ moduleSyntax: false, hasJsx: true });
  });

  it('reads TypeScript-only syntax in a `js` file as rows: the parser reports none of it', () => {
    const text = 'import type { A } from "a";\nconst b: number = 1;\ninterface C { d: string }\n';
    expect(fileRowOf(extract(text, 'js'))).toEqual({ moduleSyntax: true, hasJsx: false });
  });

  it('names the first diagnostic, not a later one', () => {
    expectParseError(extract('const a = ;\nconst b = ;\n', 'ts'), 1109, 1);
  });
});

/** Each bracket kind and a template substitution, nested `depth` deep around one literal. */
const NESTERS: Readonly<Record<string, (depth: number) => string>> = {
  paren: (depth) => `x = ${'('.repeat(depth)}1${')'.repeat(depth)};`,
  bracket: (depth) => `x = ${'['.repeat(depth)}${']'.repeat(depth)};`,
  brace: (depth) => `x = ${'{a:'.repeat(depth)}1${'}'.repeat(depth)};`,
  template: (depth) => `x = ${'`${'.repeat(depth)}1${'}`'.repeat(depth)};`,
};

describe('the nesting pre-scan', () => {
  const { outputDepth } = DEFAULT_PARSE_LIMITS;

  for (const [kind, nest] of Object.entries(NESTERS)) {
    it(`measures ${kind} nesting exactly, at and past the default outputDepth`, () => {
      expect(nestingDepth(typescript, nest(outputDepth), 'ts')).toBe(outputDepth);
      expect(nestingDepth(typescript, nest(outputDepth + 1), 'ts')).toBe(outputDepth + 1);
    });

    it(`refuses ${kind} nesting past outputDepth as the depth breach, without a parse`, () => {
      const { module, names } = recordingModule();
      const answer = extractTsRows(module, { text: nest(outputDepth + 1), variant: 'ts' }, DEFAULT_PARSE_LIMITS);
      expect(answer).toEqual({ outcome: 'breach', limit: 'outputDepth', found: outputDepth + 1 });
      expect(names).toEqual([]);
    });
  }

  it('parses nesting at a small cap and refuses one level past it, in every kind', () => {
    const cap = 3;
    const limits = { ...DEFAULT_PARSE_LIMITS, outputDepth: cap };
    for (const nest of Object.values(NESTERS)) {
      expect(extractTsRows(typescript, { text: nest(cap), variant: 'ts' }, limits).outcome).toBe('rows');
      expect(extractTsRows(typescript, { text: nest(cap + 1), variant: 'ts' }, limits)).toMatchObject({ outcome: 'breach', limit: 'outputDepth' });
    }
  });

  it('counts a template middle as the same substitution, and closes it at the tail', () => {
    expect(nestingDepth(typescript, 'x = `${a}b${c}d${e}`; y = `${`${1}`}`;', 'ts')).toBe(2);
    expect(nestingDepth(typescript, 'x = `${ {a: (1)} }`;', 'ts')).toBe(3);
    // The text after a substitution's `}` is template text: its brackets are never code.
    expect(nestingDepth(typescript, 'x = `${a}((([[[${b}]]])))`;', 'ts')).toBe(1);
  });

  it('does not count brackets in comments or strings, and does not pop on a closer that does not match', () => {
    expect(nestingDepth(typescript, '// (((\n/* [[[ */ x = "{{{" + \'(((\';', 'ts')).toBe(0);
    expect(nestingDepth(typescript, '{ ) { ) {', 'ts')).toBe(3);
  });

  it('does not count brackets inside regular-expression literals, a backtick inside one included', () => {
    expect(nestingDepth(typescript, 'x = /[({[]/g;', 'ts')).toBe(0);
    expect(nestingDepth(typescript, 'x = /(\\()+/; y = /`[({]/; z = `${(1)}`;', 'ts')).toBe(2);
    expect(nestingDepth(typescript, 'f(/[[[(((/, 1);', 'ts')).toBe(1);
    expect(nestingDepth(typescript, 'return /[[(]/.test(x);', 'ts')).toBe(1);
  });

  it('still reads a slash after an operand as division', () => {
    expect(nestingDepth(typescript, 'x = (a) / (b) / [c] / 2; y = a++ / 2 / (((1)));', 'ts')).toBe(3);
    expect(nestingDepth(typescript, 'x = <a b={(1)} />; y = <A<T> />;', 'tsx')).toBe(2);
  });

  it('measures the committed regex-heavy fixture at its real depth and extracts it at a small cap', () => {
    const text = readFileSync(new URL('./fixtures/ts-regex-heavy/regex-heavy.ts', import.meta.url), 'utf8');
    expect(nestingDepth(typescript, text, 'ts')).toBeLessThanOrEqual(4);
    const answer = extractTsRows(typescript, { text, variant: 'ts' }, { ...DEFAULT_PARSE_LIMITS, outputDepth: 6 });
    expect(answer).toMatchObject({ outcome: 'rows', rows: { imports: [{ kind: 'import', specifier: './helper.js' }] } });
  });

  it('scans braces inside JSX expressions under the JSX language variant', () => {
    expect(nestingDepth(typescript, 'x = <a b={(1)}>{[c]}</a>;', 'tsx')).toBe(2);
  });
});

describe('ts__files', () => {
  const cases: readonly { variant: TsVariant; text: string; moduleSyntax: boolean; hasJsx: boolean }[] = [
    { variant: 'ts', text: 'const a = 1;', moduleSyntax: false, hasJsx: false },
    { variant: 'ts', text: 'import a from "a";', moduleSyntax: true, hasJsx: false },
    { variant: 'ts', text: 'const u = import.meta.url;', moduleSyntax: true, hasJsx: false },
    { variant: 'dts', text: 'declare const a: number;', moduleSyntax: false, hasJsx: false },
    { variant: 'dts', text: 'export declare const a: number;', moduleSyntax: true, hasJsx: false },
    { variant: 'tsx', text: 'const a = <></>;', moduleSyntax: false, hasJsx: true },
    { variant: 'tsx', text: 'export const a = <b>c</b>;', moduleSyntax: true, hasJsx: true },
    { variant: 'tsx', text: 'export const a = 1 < 2;', moduleSyntax: true, hasJsx: false },
    { variant: 'js', text: 'const a = f(<b/>);', moduleSyntax: false, hasJsx: true },
    { variant: 'js', text: 'module.exports = require("a");', moduleSyntax: false, hasJsx: false },
    { variant: 'js', text: 'export default 1;', moduleSyntax: true, hasJsx: false },
  ];
  for (const { variant, text, moduleSyntax, hasJsx } of cases) {
    it(`${variant}: ${text}`, () => {
      expect(fileRowOf(extract(text, variant))).toEqual({ moduleSyntax, hasJsx });
    });
  }

  it('answers hasJsx as TypeScript\'s module detection reads JSX under `jsx: react-jsx`', () => {
    // `getSetExternalModuleIndicator` is internal; under `moduleDetection: auto` and `react-jsx`,
    // a file with no import or export syntax is a module exactly when it holds a JSX tag.
    const internals = typescript as unknown as {
      getSetExternalModuleIndicator(options: ts.CompilerOptions): (file: ts.SourceFile) => void;
    };
    const setIndicator = internals.getSetExternalModuleIndicator({
      jsx: typescript.JsxEmit.ReactJSX,
      moduleDetection: typescript.ModuleDetectionKind.Auto,
    });
    const texts = ['const a = <div/>;', 'const a = <></>;', 'const a = <a>x</a>;', 'const a = 1 < 2;', 'const a = f(<b/>);', 'const a = 1;'];
    for (const variant of ['tsx', 'js'] as const) {
      for (const text of texts) {
        const standIn = typescript.createSourceFile(SYNTHETIC_NAMES[variant], text, {
          languageVersion: typescript.ScriptTarget.Latest,
          setExternalModuleIndicator: setIndicator,
        });
        const detected = (standIn as { externalModuleIndicator?: unknown }).externalModuleIndicator !== undefined;
        expect(fileRowOf(extract(text, variant)).hasJsx, `${variant}: ${text}`).toBe(detected);
      }
    }
  });

  it('counts the bytes of every table in the row set', () => {
    const extraction = extract("import b from 'b';\nexport const a = b;", 'ts');
    expect(extraction).toMatchObject({ outcome: 'rows', rows: { imports: [{ kind: 'import' }], importNames: [{ local: 'b' }], exports: [{ name: 'a' }] } });
    if (extraction.outcome === 'rows') expect(extraction.bytes).toBe(Buffer.byteLength(JSON.stringify(extraction.rows)));
  });

  it('holds the rows to the output caps', () => {
    const limits = { ...DEFAULT_PARSE_LIMITS, outputBytes: 1 };
    expect(extractTsRows(typescript, { text: 'const a = 1;', variant: 'ts' }, limits)).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
  });
});

describe('loadTsExtract', () => {
  it('binds the vendored TypeScript', async () => {
    const run = await loadTsExtract();
    expect(fileRowOf(run({ text: 'export {};', variant: 'ts' }, DEFAULT_PARSE_LIMITS))).toEqual({ moduleSyntax: true, hasJsx: false });
  });
});
