/**
 * The archive-library ban (`ARCHIVE_LIBRARY_BAN` in `eslint.config.js`), fired on fixtures: `tar`
 * and `adm-zip` may be loaded — statically, with `import()`, with `require` or through
 * `createRequire`, by their bare name or by any subpath (`tar/extract` is the whole extractor) —
 * by the archive module (`packages/utils/src/archive/`) and by nothing else, product source and
 * tests alike.
 *
 * `bun run lint` proves the tree holds no such import today. This proves the rule that says so
 * can FIRE, on every shape of file it has to cover, and that its one exemption is exactly the
 * archive module — so a second extractor cannot be written WITH EITHER LIBRARY without a lint error
 * (another archive library, or a spawned `tar`, is outside what a lint rule on two names can see).
 *
 * Integration tier: it loads the repo's whole ESLint config. Only the two rules that carry the
 * ban are run, so no type information is needed and a fixture need not exist on disk.
 */

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

const STATIC_BAN = 'no-restricted-imports';
const DYNAMIC_BAN = 'no-restricted-syntax';

const eslint = new ESLint({
  cwd: REPO_ROOT,
  ruleFilter: ({ ruleId }) => ruleId === STATIC_BAN || ruleId === DYNAMIC_BAN,
  // The two rules read syntax alone: no program is built for a fixture that is not on disk.
  overrideConfig: [{ files: ['**/*.ts', '**/*.cts'], languageOptions: { parserOptions: { project: null, projectService: false } } }],
});

/** The ban's findings on `code`, linted as if it were the file `relative` of this repo: each as `rule: message`. */
async function banFindings(relative: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: safePath.join(REPO_ROOT, relative) });
  return (result?.messages ?? []).map((message) => `${message.ruleId ?? 'fatal'}: ${message.message}`);
}

const STATIC_TAR = "import * as tar from 'tar';\nexport const list = tar.list;\n";
const STATIC_ZIP = "import AdmZip from 'adm-zip';\nexport const Zip = AdmZip;\n";
const DYNAMIC_TAR = "export const load = (): Promise<unknown> => import('tar');\n";
const DYNAMIC_ZIP = "export const load = (): Promise<unknown> => import('adm-zip');\n";

/** Every other way to reach one of the two libraries: by subpath, and through CommonJS. */
const OTHER_SHAPES: ReadonlyArray<readonly [what: string, code: string, rule: string]> = [
  ['a static import of a tar subpath', "import { extract } from 'tar/extract';\nexport const x = extract;\n", STATIC_BAN],
  ['a static import of a deep tar subpath', "import { Unpack } from 'tar/dist/esm/unpack.js';\nexport const U = Unpack;\n", STATIC_BAN],
  ['a static import of an adm-zip file', "import ZipFile from 'adm-zip/zipFile.js';\nexport const Z = ZipFile;\n", STATIC_BAN],
  ['a re-export of a tar subpath', "export { extract } from 'tar/extract';\n", STATIC_BAN],
  ['a lazy import of a tar subpath', "export const load = (): Promise<unknown> => import('tar/x');\n", DYNAMIC_BAN],
  ['a lazy import of an adm-zip file', "export const load = (): Promise<unknown> => import('adm-zip/zipEntry.js');\n", DYNAMIC_BAN],
  ['a require', "export const tar: unknown = require('tar');\n", DYNAMIC_BAN],
  ['a require of a subpath', "export const unpack: unknown = require('tar/unpack');\n", DYNAMIC_BAN],
  ['createRequire called in place', "import { createRequire } from 'node:module';\nexport const zip: unknown = createRequire(import.meta.url)('adm-zip');\n", DYNAMIC_BAN],
  ['a TypeScript import-equals', "import tar = require('tar');\nexport const list = tar.list;\n", STATIC_BAN],
  ['a TypeScript import-equals of a subpath', "import unpack = require('tar/unpack');\nexport const U = unpack;\n", STATIC_BAN],
  ['a lazy import spelled as a template literal', 'export const load = (): Promise<unknown> => import(`adm-zip`);\n', DYNAMIC_BAN],
  ['a require spelled as a template literal', 'export const tar: unknown = require(`tar/extract`);\n', DYNAMIC_BAN],
  ['a require made by createRequire', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const tar: unknown = require('tar/extract');\n", DYNAMIC_BAN],
];

/** Specifiers that only LOOK like the two libraries: the ban is on the packages, not on the letters. */
const LOOKALIKES = "import a from 'tarball';\nimport b from './tar.js';\nimport c from '../helpers/adm-zip/x.js';\nexport const all = [a, b, c, import('tar-stream'), require('target')];\n";

describe('the archive-library ban', () => {
  it.each([
    ['a CLI command', 'packages/cli/src/commands/claude/plugin/second-extractor.ts', STATIC_TAR, STATIC_BAN],
    ['a domain package', 'packages/agent-skills/src/skill-source/sources/second-extractor.ts', STATIC_ZIP, STATIC_BAN],
    ['utils outside the archive module', 'packages/utils/src/second-extractor.ts', STATIC_TAR, STATIC_BAN],
    ['the test-fixture writer itself', 'packages/utils/src/testing/archive-fixtures.ts', STATIC_ZIP, STATIC_BAN],
    ['a test file', 'packages/cli/test/integration/second-extractor.integration.test.ts', STATIC_ZIP, STATIC_BAN],
    ['a test helper', 'packages/cli/test/helpers/tarball.ts', STATIC_TAR, STATIC_BAN],
    ['a dev tool', 'packages/dev-tools/src/second-extractor.ts', STATIC_ZIP, STATIC_BAN],
    ['a lazy import in product source', 'packages/agent-skills/src/second-extractor.ts', DYNAMIC_ZIP, DYNAMIC_BAN],
    ['a lazy import in a test', 'packages/cli/test/second-extractor.test.ts', DYNAMIC_TAR, DYNAMIC_BAN],
    ['a lazy import in a script', 'packages/dev-tools/second-extractor.mjs', "export const load = () => import('tar');\n", DYNAMIC_BAN],
    // Every other shape, in the file a second extractor would most plausibly be written in.
    ...OTHER_SHAPES.map(([what, code, rule]) => [what, 'packages/cli/src/commands/claude/plugin/second-extractor.ts', code, rule] as const),
  ])('fires on %s', async (_what, file, code, rule) => {
    const findings = await banFindings(file, code);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${rule}: `);
    expect(findings[0]).toContain('@vibe-agent-toolkit/utils/archive');
  });

  it.each(OTHER_SHAPES)('lets the archive module use %s', async (_what, code) => {
    expect(await banFindings('packages/utils/src/archive/tar-reader.ts', code)).toEqual([]);
  });

  // Every other rule of the file is off for the VatError base class (its one `extends Error`); the ban is not.
  it('still fires in the one file whose other syntax restrictions are lifted', async () => {
    expect(await banFindings('packages/utils/src/errors/vat-error.ts', DYNAMIC_TAR)).toEqual([expect.stringContaining(`${DYNAMIC_BAN}: `)]);
    expect(await banFindings('packages/utils/src/errors/vat-error.ts', 'export class VatError extends Error {}\n')).toEqual([]);
  });

  it('says nothing about a specifier that merely begins or ends like one of the two', async () => {
    expect(await banFindings('packages/cli/src/commands/claude/plugin/second-extractor.ts', LOOKALIKES)).toEqual([]);
  });

  it.each([
    ['tar', 'packages/utils/src/archive/tar-reader.ts', STATIC_TAR],
    ['adm-zip', 'packages/utils/src/archive/zip-reader.ts', STATIC_ZIP],
    ['either, lazily', 'packages/utils/src/archive/lazy.ts', DYNAMIC_TAR],
  ])('lets the archive module import %s', async (_what, file, code) => {
    expect(await banFindings(file, code)).toEqual([]);
  });

  // The exemption drops the archive ban and nothing else the two rules carry.
  it('still holds the archive module to every other restriction of the two rules', async () => {
    expect(await banFindings('packages/utils/src/archive/tar-reader.ts', "import yaml from 'js-yaml';\nexport const load = yaml.load;\n")).toEqual([expect.stringContaining(`${STATIC_BAN}: `)]);
    expect(await banFindings('packages/utils/src/archive/tar-reader.ts', 'export class Refused extends Error {}\n')).toEqual([expect.stringContaining(`${DYNAMIC_BAN}: `)]);
  });

  // The control: the fixtures are otherwise clean, so every finding above is the ban's.
  it('says nothing about an import of the archive module itself', async () => {
    expect(await banFindings('packages/cli/src/commands/skills/install.ts', "import { extractArchive } from '@vibe-agent-toolkit/utils/archive';\nexport const extract = extractArchive;\n")).toEqual([]);
  });
});
