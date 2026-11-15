/**
 * Pure helpers `eslint.config.js` builds its lint guard and ignores from, kept apart so they can be
 * unit-tested without loading every plugin (`packages/dev-tools/test/eslint-config-support.test.ts`).
 * Nothing here touches the filesystem: the config reads the files and passes their text in.
 * Types: `eslint-config-support.d.ts`.
 */

/**
 * The repository's ignore files. `generate-lint-config.ts --check` asserts this list equals the
 * tracked `.gitignore` files and that both lint tasks hash every one of them.
 */
export const IGNORE_FILES = ['.gitignore', 'packages/dev-tools/corpus/compat-empirical/run/.gitignore'];

/**
 * One ignore file's patterns as flat-config ignores, so ESLint never lints a file turbo does not
 * hash (turbo hashes only what git does not ignore). It follows gitignore's anchoring: a pattern
 * with a slash before its end is relative to the ignore file's directory, one without matches at
 * any depth, a trailing slash means the directory's contents, and `!` re-includes.
 *
 * @param {string} text - The ignore file's contents
 * @param {string} ignoreFile - Its repo-relative path, forward-slashed
 * @returns {string[]}
 */
export function gitignorePatterns(text, ignoreFile) {
  const base = ignoreFile.includes('/') ? ignoreFile.slice(0, ignoreFile.lastIndexOf('/') + 1) : '';
  return text.split(/\r?\n/).flatMap((raw) => {
    // A `#` starts a comment only at the start of a line in an ignore file.
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return [];
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.includes('/');
    pattern = anchored ? `${base}${pattern.replace(/^\//, '')}` : `${base}**/${pattern}`;
    const globs = dirOnly ? [`${pattern}/**`] : [pattern, `${pattern}/**`];
    return globs.map((glob) => (negated ? `!${glob}` : glob));
  });
}

/**
 * Every `types` value in a manifest: the top-level field and each one under `exports`, at any
 * depth. A wildcard (`./dist/*.d.ts`) names no one file to check, so it is refused.
 *
 * @param {Record<string, unknown>} manifest - A parsed `package.json`
 * @param {string} where - The manifest's path, for the refusal
 * @returns {string[]}
 */
export function declaredTypesFiles(manifest, where) {
  const found = typeof manifest.types === 'string' ? [manifest.types] : [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'types' && typeof value === 'string') found.push(value);
      else visit(value);
    }
  };
  visit(manifest.exports);
  const wildcard = found.find((types) => types.includes('*'));
  if (wildcard !== undefined) {
    throw new Error(`${where} declares a wildcard types path (${wildcard}). The lint build guard checks that each declared types file exists, and a wildcard names no one file: list each subpath export, or teach declaredTypesFiles() in eslint-config-support.js to expand it.`);
  }
  return [...new Set(found)];
}

/**
 * Why a package lint must not run, or `undefined` when it may.
 *
 * A package's `lint` script sets `VAT_LINT_TASK=1`; the root `lint` script sets `VAT_LINT_BUILT=1`
 * only after `turbo run build`. Turbo keys a lint on the emitted declarations, so a lint over a
 * missing or stale `dist/` would type against `any` or an old signature and be cached as a pass.
 * An editor, a direct `eslint` run and a test that loads the config set neither signal.
 *
 * @param {Record<string, string | undefined>} env - The process environment
 * @param {() => string[]} listMissingTypes - Repo-relative declared types files that do not exist
 * @returns {string | undefined}
 */
export function lintTaskRefusal(env, listMissingTypes) {
  if (env.VAT_LINT_TASK !== '1') return undefined;
  if (env.VAT_LINT_BUILT !== '1') {
    return 'A package lint reads workspace types from dist/ and is cached on them, so it runs only after a build: run `bun run lint` (or `bun run lint:fix`) from the repo root, which builds first.';
  }
  const missing = listMissingTypes();
  if (missing.length > 0) {
    return `Lint reads workspace types from dist/, and these are not built: ${missing.join(', ')}. Run \`bun run lint\` from the repo root, which builds first.`;
  }
  return undefined;
}
