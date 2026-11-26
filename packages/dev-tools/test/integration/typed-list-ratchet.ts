/**
 * The typed half of the ESLint allowlist ratchets: for a rule that needs type information, lint each
 * file a list in `eslint.config.js` exempts, with the exemption lifted, under one typed program
 * rooted at exactly those files, and return the ones the rule stays silent on. A listed file that
 * comes back is clean and must leave the list. `NO_UNSAFE_BACKLOG` and `CONTENT_KEY_OPAQUE_ALLOW`
 * are held this way; the syntactic lists are in `../eslint-allowlist-ratchets.test.ts`.
 */

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';

import { filesWithoutFinding } from '../eslint-clean-files.js';

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
function listDiagnostics(program: ts.Program, rootNames: readonly string[]): string[] {
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
 * list alone it is about 2 s and 400 MB, with the same finding in every file, count for count.
 * (The program that once crossed the tier's 1024 MB heap cap was the whole monorepo, tests
 * included.) It answers the same type question as per-package lint only if two things hold, and
 * both are asserted rather than assumed:
 *
 * - the `tsconfig.eslint.json` (the program its lint uses) of each package holding a listed file
 *   resolves to the base options but for emit, so such a package that adds a type-affecting option
 *   fails here, naming it (a package with no listed file is not checked: none of its files is in
 *   this program);
 * - the program types every listed file without a diagnostic. An import this one program cannot
 *   resolve (a workspace package whose `dist/` is missing, a path only a project reference would
 *   reach) types as `any`, which a type-aware rule reads differently from its package's lint: a
 *   cleaned file could look dirty for ever, or a dirty one clean. Each listed file passes
 *   `typecheck` in its own package, so any diagnostic here means the two programs disagree.
 */
function listProgram(files: readonly string[]): ts.Program {
  const base = compilerOptionsOf(safePath.join(REPO_ROOT, 'tsconfig.base.json'));
  const rootNames = files.map((file) => safePath.join(REPO_ROOT, file));
  for (const config of new Set(files.map((file) => lintConfigOf(file)))) {
    const options = compilerOptionsOf(config);
    const differing = [...new Set([...Object.keys(base), ...Object.keys(options)])]
      .filter((key) => !EMIT_OPTIONS.has(key) && JSON.stringify(base[key]) !== JSON.stringify(options[key]));
    if (differing.length > 0) {
      throw new Error(`${config} sets compiler options the base program does not (${differing.join(', ')}): lint its listed files under their own program`);
    }
  }
  const program = ts.createProgram({ rootNames, options: { ...base, noEmit: true, composite: false } });
  const diagnostics = listDiagnostics(program, rootNames);
  if (diagnostics.length > 0) {
    throw new Error(`The list's program does not type the listed files as their package does, so a type-aware rule would read them differently:\n${diagnostics.join('\n')}`);
  }
  return program;
}

/**
 * Lint `files` with the repo config plus `rules` forced on for exactly those files (each with the
 * options that lift its exemption), under {@link listProgram}, and return the files none of `rules`
 * reports.
 *
 * @param files - Repo-relative paths, the list as `eslint.config.js` exports it
 * @param rules - Each rule to run and its severity-and-options entry, exemption lifted
 * @returns The listed files clean under every one of `rules`
 */
export function typedFilesWithoutFinding(
  files: readonly string[],
  rules: Readonly<Record<string, Linter.RuleEntry>>,
): Promise<string[]> {
  const ruleIds = Object.keys(rules);
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    // Only these rules run: the question is about them alone, and every other type-aware rule in
    // the repo config was cost with no bearing on the answer.
    ruleFilter: ({ ruleId }) => ruleIds.includes(ruleId),
    overrideConfig: [{
      files: [...files],
      // `tsconfigRootDir` because typescript-eslint defaults it to the PROCESS cwd
      // — the package dir here. See `listProgram` for the program.
      languageOptions: { parserOptions: { tsconfigRootDir: REPO_ROOT, project: null, projectService: false, programs: [listProgram(files)] } },
      rules: { ...rules },
    }],
  });
  return filesWithoutFinding(eslint, REPO_ROOT, files, (m) => m.ruleId !== null && ruleIds.includes(m.ruleId));
}
