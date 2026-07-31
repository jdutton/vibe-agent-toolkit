#!/usr/bin/env tsx
/**
 * Generate the committed Python standard-library module list.
 *
 * The scanner needs to tell "this import is stdlib" from "this import needs a
 * third-party package installed". Hand-maintaining that list does not work:
 * nobody notices the modules they forgot to type, and the audit then reports a
 * falsehood ("depends on third-party package `zoneinfo`").
 *
 * So we ask Python instead. `sys.stdlib_module_names` (Python 3.10+) is
 * CPython's own answer for a single interpreter version. Because modules are
 * added and removed across releases (`imghdr` and `distutils` exist in 3.10 but
 * were removed by 3.13; `_zstd` only exists from 3.14), we take the UNION over
 * every version in {@link SUPPORTED_PYTHON_VERSIONS}. A plugin script that
 * imports `imghdr` is not depending on a third-party package — it is targeting
 * an older Python — so the union is the right answer for a scanner that must
 * not accuse.
 *
 * Requirements: `uv` (https://docs.astral.sh/uv/). This is a developer-only
 * tool. It never runs in CI or during tests — the generated artifact is
 * committed, and the tests validate that artifact instead.
 *
 * Usage:
 *   bun run generate:python-stdlib
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';

/**
 * Python versions the scanner claims to understand. Every version listed here
 * must be resolvable via `uv`, or generation fails loudly — a partial union
 * would silently drop modules and reintroduce the false-third-party bug.
 */
const SUPPORTED_PYTHON_VERSIONS = ['3.10', '3.11', '3.12', '3.13', '3.14'] as const;

/**
 * Modules that are importable stdlib but absent from `sys.stdlib_module_names`.
 *
 * CPython's generator for that frozenset (`Tools/build/generate_stdlib_module_names.py`)
 * explicitly ignores the `test` package, yet `import test` resolves to the
 * standard library on every supported version. Keep this list as short as the
 * evidence demands: each entry must be justified here, and anything Python can
 * answer for itself belongs in the generated union instead.
 */
const ADDITIONAL_STDLIB_MODULES = ['test'] as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = safePath.join(
  scriptDir,
  '..',
  '..',
  'claude-marketplace',
  'src',
  'scanners',
  'python-stdlib-modules.generated.ts',
);

interface VersionResult {
  /** Requested version, e.g. `3.12`. */
  readonly requested: string;
  /** Actual interpreter version, e.g. `3.12.12`. */
  readonly resolved: string;
  readonly modules: readonly string[];
}

/** Ask one interpreter for its own `sys.stdlib_module_names`. */
function readStdlibNames(requested: string): VersionResult {
  const program =
    'import sys, json; ' +
    'print(json.dumps({' +
    '"version": ".".join(str(p) for p in sys.version_info[:3]), ' +
    '"modules": sorted(sys.stdlib_module_names)' +
    '}))';

  const stdout = safeExecSync(
    'uv',
    ['run', '--no-project', '--python', requested, 'python', '-c', program],
    { encoding: 'utf8' },
  ).toString();

  const parsed = JSON.parse(stdout) as { version: string; modules: string[] };

  if (parsed.modules.length === 0) {
    throw new Error(
      `Python ${requested} reported an empty sys.stdlib_module_names. ` +
        `Refusing to generate a partial list.`,
    );
  }

  return { requested, resolved: parsed.version, modules: parsed.modules };
}

function renderArtifact(results: readonly VersionResult[], modules: readonly string[]): string {
  const provenance = results
    .map(r => ` *   - Python ${r.requested} (${r.resolved}): ${r.modules.length} modules`)
    .join('\n');

  const versionList = results.map(r => `  '${r.resolved}',`).join('\n');
  const moduleList = modules.map(m => `  '${m}',`).join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with:
 *   cd packages/claude-marketplace && bun run generate:python-stdlib
 *
 * Source of truth: CPython's own \`sys.stdlib_module_names\`, unioned across
 * every supported Python version (plus a short, documented list of importable
 * stdlib modules CPython omits from that frozenset — see the generator).
 *
 * Union is deliberate: modules come and go between releases, and a script
 * importing a module that only exists on an older Python is targeting that
 * Python, not depending on a third-party package.
 *
${provenance}
 *
 * Total (union): ${modules.length} modules
 */

/** Interpreter versions whose \`sys.stdlib_module_names\` produced this list. */
export const PYTHON_STDLIB_SOURCE_VERSIONS: readonly string[] = [
${versionList}
];

/** Sorted, de-duplicated union of standard-library module names. */
export const PYTHON_STDLIB_MODULE_NAMES: readonly string[] = [
${moduleList}
];
`;
}

const results = SUPPORTED_PYTHON_VERSIONS.map(version => {
  process.stdout.write(`Reading sys.stdlib_module_names from Python ${version}... `);
  const result = readStdlibNames(version);
  process.stdout.write(`${result.resolved} (${result.modules.length} modules)\n`);
  return result;
});

const union = new Set<string>(ADDITIONAL_STDLIB_MODULES);
for (const result of results) {
  for (const moduleName of result.modules) {
    union.add(moduleName);
  }
}

// Codepoint sort (no comparator), deliberately NOT localeCompare: this artifact
// is committed, so its ordering must be byte-identical on every machine
// regardless of locale, and it must match Python's own `sorted()`.
// eslint-disable-next-line sonarjs/no-alphabetical-sort -- see above
const modules = [...union].sort();

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from import.meta.url
writeFileSync(OUTPUT_PATH, renderArtifact(results, modules), 'utf8');

console.log(`\nWrote ${modules.length} modules to ${OUTPUT_PATH}`);
