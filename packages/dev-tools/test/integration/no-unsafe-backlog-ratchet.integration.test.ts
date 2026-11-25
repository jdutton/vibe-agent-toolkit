/**
 * The `@typescript-eslint/no-unsafe-member-access` / `no-unsafe-assignment`
 * ratchet (`NO_UNSAFE_BACKLOG` in `eslint.config.js`), asserted from the side
 * the rules cannot see.
 *
 * The block that enables the pair applies it to every `src` file NOT on the
 * list, so a listed file that becomes clean is invisible to `bun run lint` and
 * its entry never leaves. This lints each listed file type-aware with the
 * exemption lifted and requires at least one finding, so a clean file fails
 * here until its entry is deleted. Integration tier: the pair needs type
 * information, and a typed program over the 23 files costs seconds.
 *
 * The list is imported from the config module itself, so there is one owner
 * of the fact and this test cannot drift from it.
 */

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { filesWithoutFinding, importRootEslintConfig } from '../eslint-clean-files.js';

/** The one `eslint.config.js` export this file reads: the backlog's repo-relative paths. */
const { NO_UNSAFE_BACKLOG } = await importRootEslintConfig<{ readonly NO_UNSAFE_BACKLOG: readonly string[] }>();


const RULES = ['@typescript-eslint/no-unsafe-member-access', '@typescript-eslint/no-unsafe-assignment'] as const;
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..', '..');

/**
 * Compiler options that say where output goes or whether there is any, never what a type is.
 * `noEmit` and `composite: false` are what `tsconfig.eslint.json` adds to the base.
 */
const EMIT_OPTIONS = new Set(['composite', 'configFilePath', 'noEmit', 'outDir', 'rootDir', 'tsBuildInfoFile']);

/** A tsconfig's compiler options, as TypeScript resolves them (`extends` applied). */
function compilerOptionsOf(config: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    },
  });
  if (parsed === undefined) throw new Error(`${config} did not parse`);
  return parsed.options;
}

/** The program per-package lint gives a listed file: its package's `tsconfig.eslint.json`. */
function lintConfigOf(file: string): string {
  const match = /^packages\/[^/]+\//.exec(file);
  if (match === null) throw new Error(`${file} is not in a workspace package`);
  const config = safePath.join(REPO_ROOT, match[0], 'tsconfig.eslint.json');
  if (!ts.sys.fileExists(config)) throw new Error(`${file}: its package has no tsconfig.eslint.json, so lint gives it no program to compare with`);
  return config;
}

/** Every diagnostic the program reports for the listed files and for the program as a whole. */
function backlogDiagnostics(program: ts.Program, rootNames: readonly string[]): string[] {
  const missing = rootNames.filter((file) => program.getSourceFile(file) === undefined).map((file) => `${file}: not in the program`);
  const perFile = rootNames.flatMap((file): readonly ts.Diagnostic[] => {
    const source = program.getSourceFile(file);
    return source === undefined ? [] : [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  });
  const reported = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...perFile].map((diagnostic) => {
    const where = diagnostic.file === undefined ? '' : `${safePath.relative(REPO_ROOT, diagnostic.file.fileName)}: `;
    return `${where}TS${String(diagnostic.code)} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
  return [...missing, ...reported];
}

/**
 * One typed program rooted at exactly the listed files, under `tsconfig.base.json`'s options.
 *
 * Through `projectService` each file got its package's program over that package's whole `src`
 * (about 4.3 s and 680 MB here, `cli` and `agent-skills` ~1.5 s each for five files), which a
 * loaded floor runner stretched past the integration tier's 60 s in a publish run. Rooted at the
 * backlog alone it is about 2 s and 400 MB, with the same finding in every file, count for count.
 * (The program that once crossed the tier's 1024 MB heap cap was the whole monorepo, tests
 * included.) It answers the same type question as per-package lint only if two things hold, and
 * both are asserted rather than assumed:
 *
 * - every package's `tsconfig.eslint.json` (the program its lint uses) resolves to the base
 *   options but for emit, so a package that adds a type-affecting option fails here, naming it;
 * - the program types every listed file without a diagnostic. An import this one program cannot
 *   resolve (a workspace package whose `dist/` is missing, a path only a project reference would
 *   reach) types as `any`, which is exactly what the pair reports: a cleaned file would look dirty
 *   for ever. Each listed file passes `typecheck` in its own package, so any diagnostic here means
 *   the two programs disagree.
 */
function backlogProgram(files: readonly string[]): ts.Program {
  const base = compilerOptionsOf(safePath.join(REPO_ROOT, 'tsconfig.base.json'));
  const rootNames = files.map((file) => safePath.join(REPO_ROOT, file));
  for (const config of new Set(files.map((file) => lintConfigOf(file)))) {
    const options = compilerOptionsOf(config);
    const differing = [...new Set([...Object.keys(base), ...Object.keys(options)])]
      .filter((key) => !EMIT_OPTIONS.has(key) && JSON.stringify(base[key]) !== JSON.stringify(options[key]));
    if (differing.length > 0) {
      throw new Error(`${config} sets compiler options the base program does not (${differing.join(', ')}): lint its backlog files under their own program`);
    }
  }
  const program = ts.createProgram({ rootNames, options: { ...base, noEmit: true, composite: false } });
  const diagnostics = backlogDiagnostics(program, rootNames);
  if (diagnostics.length > 0) {
    throw new Error(`The backlog program does not type the listed files as their package does, so an unresolved type would read as a no-unsafe finding:\n${diagnostics.join('\n')}`);
  }
  return program;
}

/** Lint the backlog with the repo config plus the pair forced on for exactly those files. */
async function cleanWithoutExemption(files: readonly string[]): Promise<string[]> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    // Only the pair runs: the question is about these two rules alone, and every other
    // type-aware rule in the repo config was cost with no bearing on the answer.
    ruleFilter: ({ ruleId }) => (RULES as readonly string[]).includes(ruleId),
    overrideConfig: [{
      files: [...files],
      // `tsconfigRootDir` because typescript-eslint defaults it to the PROCESS cwd
      // — the package dir here. See `backlogProgram` for the program.
      languageOptions: { parserOptions: { tsconfigRootDir: REPO_ROOT, project: null, projectService: false, programs: [backlogProgram(files)] } },
      rules: Object.fromEntries(RULES.map((rule) => [rule, 'error'])),
    }],
  });
  return filesWithoutFinding(
    eslint,
    REPO_ROOT,
    files,
    (m) => m.ruleId !== null && (RULES as readonly string[]).includes(m.ruleId),
  );
}

describe('NO_UNSAFE_BACKLOG only names files that still carry a no-unsafe finding', () => {
  it('is non-empty while the backlog exists', () => {
    expect(NO_UNSAFE_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every listed file still trips one of the pair — remove the entry when it does not', async () => {
    expect(
      await cleanWithoutExemption(NO_UNSAFE_BACKLOG),
      'These files are clean under both no-unsafe rules. Delete their NO_UNSAFE_BACKLOG entries in '
        + 'eslint.config.js — the list may only shrink, and a stale entry hides the next offender.',
    ).toEqual([]);
  });
});
