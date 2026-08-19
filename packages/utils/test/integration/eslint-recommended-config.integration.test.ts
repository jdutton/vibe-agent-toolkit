/* eslint-disable security/detect-non-literal-fs-filename -- Test code writing into its own temp project */
/**
 * `configs.recommended`, exercised through the PUBLISHED artifact.
 *
 * This repo's `eslint.config.js` does NOT consume `configs.recommended` — it keeps
 * its own explicit severity map under the `local` namespace. So the flat config an
 * adopter actually installs is the one surface of the `./eslint` subpath that
 * nothing else touches: a misnamed rule key, a `files`-field omission that leaves
 * `eslint/rules/` out of the tarball, a missing `"./eslint"` export, or a namespace
 * typo would all ship green through lint, unit tests and CI.
 *
 * The test therefore refuses to import `../../eslint/index.cjs`. It runs:
 *   npm pack  →  materialize exactly the packed file set as an installed package
 *   in a throwaway project OUTSIDE the workspace  →  write the `eslint.config.js`
 *   from the README verbatim  →  lint.
 *
 * Everything resolves from the throwaway project's own `node_modules`, by bare
 * specifier, through the manifest's `exports` map — so a file present in the source
 * tree but missing from `files`, or an `exports` key pointing at a path that only
 * exists pre-publish, fails here and only here.
 *
 * **Why the file set rather than the tarball.** Until the rules moved into `utils`
 * this installed the tarball with `npm install --offline`, which worked because the
 * standalone plugin package had ZERO dependencies — there was nothing for npm to
 * resolve. `utils` has five runtime dependencies, so that same command now needs
 * them in the local npm cache; CI installs with `bun`, leaving that cache cold, and
 * the install would fail on a clean runner for reasons having nothing to do with
 * what is under test. `npm pack --dry-run --json` is npm's own authoritative answer
 * to "what ships?" — computed from `files` and the ignore rules by the same code
 * path that builds the tarball — so copying exactly that list preserves every
 * failure this test was built to catch while depending on neither the network, the
 * npm cache, nor an external archiver. The rule pack needs none of those five
 * dependencies to load, which is the whole point of it being pure data.
 *
 * Tier: integration. It spawns one `npm` process and copies a few hundred files.
 *
 * ESLint itself is the repo's ESLint 9 (asserted below) driven through its Node
 * API rather than an npm install: installing eslint from the registry would make
 * this test network-dependent for no added signal — the API and the CLI load the
 * same flat config through the same resolver.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { ESLint, type Linter } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, resolveFromImportMeta } from '../../src/fs.js';
import { safePath, toForwardSlash } from '../../src/path.js';
import { safeExecResult, safeExecSync } from '../../src/process.js';

const PACKAGE_DIR = resolveFromImportMeta(import.meta.url, '..', '..');

/** Where an adopter's resolver finds the package: `<project>/node_modules/<name>`. */
const INSTALL_SUBPATH = 'node_modules/@vibe-agent-toolkit/utils';

/** ESLint's numeric severities, named. */
const SEVERITY = { warn: 1, error: 2 } as const;

/**
 * `eslint.config.js` — copied verbatim from the README ("Usage").
 *
 * If the README snippet and this string diverge, the test stops proving anything
 * about what an adopter is told to write.
 */
const README_USAGE_CONFIG = `// eslint.config.js
import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  vat.configs.recommended,
];
`;

/**
 * `recommended` plus the documented `exemptFiles` option on one rule.
 *
 * `src/paths.js` is the declared implementation file; `tools/hooks/paths.js` is
 * the decoy that shares its basename. The decoy must still fire — a substring
 * exemption check is exactly how a private `tools/hooks/path-utils.ts` full of
 * raw `tmpdir()` calls linted clean for months.
 */
const EXEMPT_CONFIG = `import vat from '@vibe-agent-toolkit/utils/eslint';

export default [
  vat.configs.recommended,
  {
    rules: {
      '@vibe-agent-toolkit/no-os-tmpdir': ['error', { exemptFiles: ['src/paths.js'] }],
    },
  },
];
`;

/** Trips several rules at both severities `recommended` declares. */
const VIOLATIONS_FIXTURE = `import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function build(name, target) {
  const dir = path.join(tmpdir(), name);
  execSync('node --version');
  return {
    dir,
    href: \`file://\${dir}\`,
    secure: /^https:/.test(target),
  };
}
`;

/** Calls the banned primitive `no-os-tmpdir` exempts by path. */
const TMPDIR_FIXTURE = `import { tmpdir } from 'node:os';

export function base() {
  return tmpdir();
}
`;

/**
 * A consumer `eslint.config.ts`, type-checked against the SHIPPED `index.d.cts`.
 *
 * ESLint has supported TypeScript flat configs since 9.18, so this is a real
 * adopter shape — and `./eslint` is the only one of the 14 exports whose types are
 * hand-written rather than emitted by `tsc`. Nothing else in this repo can catch a
 * mistake in them: `utils`' tsconfig includes only `src/**‍/*.ts`, so
 * `bun run typecheck` never reads the declaration, and the repo's own
 * `eslint.config.js` is JavaScript. Without this case, a broken `.d.cts` ships
 * green.
 */
const TS_CONSUMER = `import vat from '@vibe-agent-toolkit/utils/eslint';

const severity: string | undefined = vat.configs.recommended.rules['@vibe-agent-toolkit/no-path-join'];
const ruleNames: string[] = Object.keys(vat.rules);
const pluginName: string = vat.meta.name;

export default [vat.configs.recommended];
export { severity, ruleNames, pluginName };
`;

/** `nodenext` specifically — it is the resolution mode that demands `.d.cts` for a `.cjs` file. */
const TS_CONSUMER_TSCONFIG = `{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2024",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["types-consumer.ts"]
}
`;

const TS_CONSUMER_FILE = 'types-consumer.ts';
const TS_CONSUMER_TSCONFIG_FILE = 'tsconfig.types-consumer.json';

/** Project-relative fixture paths. `EXEMPT_CONFIG` declares `IMPL_FILE` by this exact string. */
const NO_OS_TMPDIR = '@vibe-agent-toolkit/no-os-tmpdir';

const VIOLATIONS_FILE = 'src/violations.js';
const IMPL_FILE = 'src/paths.js';
const DECOY_FILE = 'tools/hooks/paths.js';

interface PackedProject {
  dir: string;
  configPath: string;
  exemptConfigPath: string;
  /** Every package-relative path npm reported as shipping. */
  packedFiles: string[];
}

/** npm's `pack --dry-run --json` shape, reduced to the field this test reads. */
interface PackDryRunEntry {
  files: { path: string }[];
}

/**
 * Ask npm which files the published tarball contains.
 *
 * `--dry-run` skips writing the archive; the reported list is still computed from
 * `files` plus the ignore rules by the packer itself, so it is the shipped set, not
 * a re-derivation of it.
 */
function packedFileList(): string[] {
  const stdout = safeExecSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    stdio: 'pipe',
  }).toString();
  const parsed = JSON.parse(stdout) as PackDryRunEntry[];
  const files = parsed[0]?.files?.map((file) => file.path);
  if (!files || files.length === 0) {
    throw new Error(`npm pack --dry-run reported no files (stdout: ${JSON.stringify(stdout)})`);
  }
  return files;
}

/** Write `content` to `<dir>/<relativePath>`, creating parent directories. */
function writeProjectFile(dir: string, relativePath: string, content: string): string {
  const absolute = safePath.join(dir, relativePath);
  mkdirSyncReal(safePath.join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return absolute;
}

/** Copy one packed file from the source package into the installed copy. */
function installPackedFile(projectDir: string, relativePath: string): void {
  const destination = safePath.join(projectDir, INSTALL_SUBPATH, relativePath);
  mkdirSyncReal(safePath.join(destination, '..'), { recursive: true });
  copyFileSync(safePath.join(PACKAGE_DIR, relativePath), destination);
}

/** Build the throwaway project: pack, install the packed set, then write config + fixtures. */
function createPackedProject(): PackedProject {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-utils-eslint-pack-'));
  writeProjectFile(dir, 'package.json', '{ "name": "adopter", "version": "1.0.0", "type": "module", "private": true }\n');

  const packedFiles = packedFileList();
  for (const relativePath of packedFiles) {
    installPackedFile(dir, relativePath);
  }

  const configPath = writeProjectFile(dir, 'eslint.config.js', README_USAGE_CONFIG);
  const exemptConfigPath = writeProjectFile(dir, 'eslint.exempt.config.js', EXEMPT_CONFIG);
  writeProjectFile(dir, VIOLATIONS_FILE, VIOLATIONS_FIXTURE);
  writeProjectFile(dir, IMPL_FILE, TMPDIR_FIXTURE);
  writeProjectFile(dir, DECOY_FILE, TMPDIR_FIXTURE);
  writeProjectFile(dir, TS_CONSUMER_FILE, TS_CONSUMER);
  writeProjectFile(dir, TS_CONSUMER_TSCONFIG_FILE, TS_CONSUMER_TSCONFIG);

  return { dir, configPath, exemptConfigPath, packedFiles };
}

/**
 * Run this repo's `tsc` over the throwaway project, returning `{status, output}`.
 *
 * Spawned as `node <path-to-tsc>` rather than the `tsc` bin: the throwaway project
 * has no `node_modules/.bin`, and going through `process.execPath` sidesteps
 * Windows `.cmd` shim resolution entirely.
 */
function typecheckProject(project: PackedProject): { status: number; output: string } {
  const requireFromTest = createRequire(import.meta.url);
  const typescriptRoot = safePath.resolve(requireFromTest.resolve('typescript'), '..', '..');
  const result = safeExecResult(process.execPath, [
    safePath.join(typescriptRoot, 'bin', 'tsc'),
    '--project',
    safePath.join(project.dir, TS_CONSUMER_TSCONFIG_FILE),
  ]);
  // tsc writes diagnostics to stdout, not stderr; keep both so a spawn failure is legible.
  return { status: result.status, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** Lint one project-relative file and return every message it produced. */
async function lintProjectFile(
  project: PackedProject,
  relativePath: string,
  overrideConfigFile: string,
): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: project.dir, overrideConfigFile });
  const results = await eslint.lintFiles([safePath.join(project.dir, relativePath)]);
  return results.flatMap((result) => result.messages);
}

/** Collapse messages into `ruleId -> severity`, failing loudly on a fatal parse error. */
function severityByRule(messages: Linter.LintMessage[]): Map<string, number> {
  const byRule = new Map<string, number>();
  for (const message of messages) {
    if (message.fatal || !message.ruleId) {
      throw new Error(`Non-rule ESLint message: ${message.message}`);
    }
    byRule.set(message.ruleId, message.severity);
  }
  return byRule;
}

let project: PackedProject;

beforeAll(() => {
  project = createPackedProject();
});

afterAll(() => {
  if (project?.dir) {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

describe('the ./eslint subpath ships', () => {
  it('includes the rule pack in the published file set', () => {
    expect(project.packedFiles).toContain('eslint/index.cjs');
    expect(project.packedFiles).toContain('eslint/rules/no-os-tmpdir.cjs');
    // 22 registered rules + three shared factories (`eslint-rule-factory`,
    // `path-function-rule-factory`, `no-command-direct-factory`) + `exempt-path-matcher`
    // + `safe-import` (the autofix target and the already-bound check)
    // + `dead-import` (removing the binding a fixer orphaned).
    // Exact, not a floor: a floor lets rules silently fall out of the tarball.
    // npm reports manifest paths POSIX-style; normalize anyway so the count cannot
    // quietly become zero on a platform that reports them otherwise.
    const rules = project.packedFiles.filter((file) => toForwardSlash(file).startsWith('eslint/rules/'));
    expect(rules).toHaveLength(28);
  });

  it('ships the hand-written types alongside them', () => {
    expect(project.packedFiles).toContain('eslint/index.d.cts');
  });

  /**
   * The declaration is the only shipped type surface in this package that `tsc`
   * does not generate, and no other lane reads it. Compiled here under
   * `moduleResolution: nodenext` — the mode that requires `.d.cts` (not `.d.ts`)
   * to describe a `.cjs` file inside a `"type": "module"` package.
   */
  it('type-checks a consumer eslint.config.ts under nodenext', () => {
    const { status, output } = typecheckProject(project);
    expect(output).toBe('');
    expect(status).toBe(0);
  });
});

describe('configs.recommended (published artifact)', () => {
  it('is driven by ESLint 9', () => {
    expect(ESLint.version.startsWith('9.')).toBe(true);
  });

  it('reports findings from the README usage snippet alone', async () => {
    const messages = await lintProjectFile(project, VIOLATIONS_FILE, project.configPath);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.ruleId).toMatch(/^@vibe-agent-toolkit\//);
    }
  });

  it('applies the severity split recommended declares', async () => {
    const messages = await lintProjectFile(project, VIOLATIONS_FILE, project.configPath);
    const byRule = severityByRule(messages);

    // warn — the high-churn auto-fixable path rules. The criterion is migration
    // volume, not how real the finding is (see RECOMMENDED_WARN in index.cjs).
    expect(byRule.get('@vibe-agent-toolkit/no-path-join')).toBe(SEVERITY.warn);

    // error — everything else in the safety core, including the rules whose value is
    // shifting a static-analysis finding left of a merge rather than catching a crash.
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
    expect(byRule.get('@vibe-agent-toolkit/no-child-process-execSync')).toBe(SEVERITY.error);
    expect(byRule.get('@vibe-agent-toolkit/no-file-url-string-concat')).toBe(SEVERITY.error);
    expect(byRule.get('@vibe-agent-toolkit/prefer-startswith-over-regex')).toBe(SEVERITY.error);

    // The split is real, not an artifact of one severity being unused.
    const severities = new Set(byRule.values());
    expect([...severities].sort((a, b) => a - b)).toEqual([SEVERITY.warn, SEVERITY.error]);
  });

  /**
   * Three rules ship without riding in `recommended`, for two different reasons.
   * `no-test-scoped-functions` and `require-justified-skip` are positions on test
   * style. `no-unsafe-root-join` is excluded on CORRECTNESS: it keys on whether an
   * identifier's name ends in `root` rather than on taint, so it fires on
   * all-literal calls and stays silent on `safePath.join(base, userInput)` — the
   * shape it exists to catch. Measured on a 4,670-file adopter tree: 108 findings,
   * none autofixable.
   */
  it('omits the three opt-in rules', async () => {
    const eslint = new ESLint({ cwd: project.dir, overrideConfigFile: project.configPath });
    const config = (await eslint.calculateConfigForFile(
      safePath.join(project.dir, VIOLATIONS_FILE),
    )) as { rules: Record<string, unknown> };

    expect(config.rules['@vibe-agent-toolkit/no-path-join']).toBeDefined();
    expect(config.rules['@vibe-agent-toolkit/no-test-scoped-functions']).toBeUndefined();
    expect(config.rules['@vibe-agent-toolkit/require-justified-skip']).toBeUndefined();
    expect(config.rules['@vibe-agent-toolkit/no-unsafe-root-join']).toBeUndefined();
  });

  // The pack still SHIPS all three — they are opt-in, not withdrawn.
  it('still ships the opt-in rules for explicit enabling', () => {
    expect(project.packedFiles).toContain('eslint/rules/no-unsafe-root-join.cjs');
    expect(project.packedFiles).toContain('eslint/rules/no-test-scoped-functions.cjs');
    expect(project.packedFiles).toContain('eslint/rules/require-justified-skip.cjs');
  });
});

describe('exemptFiles through the published artifact', () => {
  it('fires on the implementation file when nothing is exempted', async () => {
    const messages = await lintProjectFile(project, IMPL_FILE, project.configPath);
    const byRule = severityByRule(messages);
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
  });

  it('silences the declared exempt file', async () => {
    const messages = await lintProjectFile(project, IMPL_FILE, project.exemptConfigPath);
    expect(messages).toEqual([]);
  });

  it('still fires on a decoy with the same basename in another directory', async () => {
    const messages = await lintProjectFile(project, DECOY_FILE, project.exemptConfigPath);
    const byRule = severityByRule(messages);
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
  });
});
