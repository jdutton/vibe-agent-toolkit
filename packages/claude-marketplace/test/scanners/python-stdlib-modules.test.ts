/**
 * Guards the committed Python stdlib module list.
 *
 * The old hand-written allowlist was checked by tests that named ~31 modules it
 * was supposed to contain and ~11 packages it was supposed to omit. Two
 * hand-written lists checked against a third cannot detect the module nobody
 * thought to name — and 179 real stdlib modules were missing, so `import
 * zoneinfo` was reported as a third-party dependency that does not exist.
 *
 * These tests instead iterate the whole table, and cross-check it against a
 * live interpreter when one is available.
 */
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';
import { describe, expect, it } from 'vitest';

import {
  PYTHON_STDLIB_MODULE_NAMES,
  PYTHON_STDLIB_SOURCE_VERSIONS,
} from '../../src/scanners/python-stdlib-modules.generated.js';
import { PYTHON_STDLIB_MODULES, scanPythonImports } from '../../src/scanners/script-file-scanner.js';

/**
 * Packages that must never appear in the stdlib list. If one does, the scanner
 * would silently stop reporting a genuine third-party dependency.
 */
const THIRD_PARTY_PACKAGES = [
  'anthropic', 'attrs', 'boto3', 'bs4', 'click', 'django', 'flask', 'httpx',
  'jinja2', 'matplotlib', 'numpy', 'openai', 'pandas', 'pip', 'pydantic',
  'pytest', 'requests', 'rich', 'scikit-learn', 'scipy', 'seaborn',
  'setuptools', 'six', 'sklearn', 'torch', 'transformers', 'wheel', 'yaml',
];

/**
 * The subset usable in an `import` statement. `scikit-learn` is a distribution
 * name, not a module name — Python cannot import it, so the scanner never sees
 * it (its import name, `sklearn`, is listed separately).
 */
const THIRD_PARTY_IMPORT_NAMES = THIRD_PARTY_PACKAGES.filter(p => /^[A-Za-z_]\w*$/.test(p));

/** `sys.stdlib_module_names` was added in Python 3.10. */
const MIN_LIVE_MINOR = 10;

/** Highest Python minor version the committed artifact claims to cover. */
const MAX_COVERED_MINOR = Math.max(
  ...PYTHON_STDLIB_SOURCE_VERSIONS.map(v => Number(v.split('.')[1])),
);

interface LiveInterpreter {
  readonly version: string;
  readonly minor: number;
  readonly modules: readonly string[];
}

/**
 * Ask the local `python3` for its own `sys.stdlib_module_names`. Returns
 * undefined when no interpreter is available or it predates 3.10 — this check
 * is a bonus signal, never a requirement (CI runs Node on Ubuntu/Windows).
 */
function readLiveInterpreter(): LiveInterpreter | undefined {
  const program =
    'import sys, json; ' +
    'names = getattr(sys, "stdlib_module_names", None); ' +
    'print(json.dumps({' +
    '"version": ".".join(str(p) for p in sys.version_info[:3]), ' +
    '"minor": sys.version_info[1], ' +
    '"modules": sorted(names) if names else None}))';

  const result = safeExecResult('python3', ['-c', program]);
  if (!result.success) return undefined;

  try {
    const parsed = JSON.parse(result.stdout.toString()) as {
      version: string;
      minor: number;
      modules: string[] | null;
    };
    if (parsed.modules === null || parsed.minor < MIN_LIVE_MINOR) return undefined;
    return { version: parsed.version, minor: parsed.minor, modules: parsed.modules };
  } catch {
    return undefined;
  }
}

describe('python-stdlib-modules.generated.ts (committed artifact)', () => {
  it('is non-empty and records the interpreter versions it came from', () => {
    expect(PYTHON_STDLIB_MODULE_NAMES.length).toBeGreaterThan(250);
    expect(PYTHON_STDLIB_SOURCE_VERSIONS.length).toBeGreaterThan(0);
    for (const version of PYTHON_STDLIB_SOURCE_VERSIONS) {
      expect(version).toMatch(/^3\.\d+\.\d+$/);
    }
    expect(MAX_COVERED_MINOR).toBeGreaterThanOrEqual(MIN_LIVE_MINOR);
  });

  it('is sorted and de-duplicated (so regeneration produces a clean diff)', () => {
    // Codepoint sort, deliberately NOT localeCompare — the generator commits a
    // codepoint-sorted list so the artifact is byte-identical on every machine.
    // eslint-disable-next-line sonarjs/no-alphabetical-sort -- see above
    const sorted = [...PYTHON_STDLIB_MODULE_NAMES].sort();
    expect(PYTHON_STDLIB_MODULE_NAMES).toEqual(sorted);
    expect(new Set(PYTHON_STDLIB_MODULE_NAMES).size).toBe(PYTHON_STDLIB_MODULE_NAMES.length);
  });

  it('contains only legal Python module identifiers', () => {
    const malformed = PYTHON_STDLIB_MODULE_NAMES.filter(m => !/^[A-Za-z_]\w*$/.test(m));
    expect(malformed).toEqual([]);
  });

  it('contains no third-party package names', () => {
    const polluted = THIRD_PARTY_PACKAGES.filter(p => PYTHON_STDLIB_MODULE_NAMES.includes(p));
    expect(polluted).toEqual([]);
  });
});

describe('PYTHON_STDLIB_MODULES ↔ committed artifact', () => {
  it('recognizes every module in the committed artifact', () => {
    const missing = PYTHON_STDLIB_MODULE_NAMES.filter(m => !PYTHON_STDLIB_MODULES.has(m));
    expect(missing).toEqual([]);
  });

  it('claims no module the committed artifact does not list', () => {
    const extra = [...PYTHON_STDLIB_MODULES].filter(m => !PYTHON_STDLIB_MODULE_NAMES.includes(m));
    expect(extra).toEqual([]);
  });

  it('reports no third-party evidence for any stdlib module (import form)', () => {
    const source = PYTHON_STDLIB_MODULE_NAMES.map(m => `import ${m}`).join('\n');
    const flagged = scanPythonImports(source, 'scripts/stdlib.py').map(e => e.matchText);
    expect(flagged).toEqual([]);
  });

  it('reports no third-party evidence for any stdlib module (from-import form)', () => {
    const source = PYTHON_STDLIB_MODULE_NAMES.map(m => `from ${m} import thing`).join('\n');
    const flagged = scanPythonImports(source, 'scripts/stdlib.py').map(e => e.matchText);
    expect(flagged).toEqual([]);
  });

  it('still reports third-party packages as third-party', () => {
    const source = THIRD_PARTY_IMPORT_NAMES.map(p => `import ${p}`).join('\n');
    const flagged = scanPythonImports(source, 'scripts/deps.py');
    expect(flagged.map(e => e.patternId)).toEqual(
      THIRD_PARTY_IMPORT_NAMES.map(() => 'PYTHON_IMPORT_THIRD_PARTY'),
    );
  });
});

describe('committed artifact ↔ live python3 (skipped when unavailable)', () => {
  const live = readLiveInterpreter();

  it('covers everything the local interpreter calls stdlib', ctx => {
    if (live === undefined) {
      const message =
        'SKIPPED: no local python3 with sys.stdlib_module_names (needs Python 3.10+). ' +
        'The committed artifact is still checked for internal consistency above.';
      console.warn(message);
      ctx.skip(message);
      return;
    }

    if (live.minor > MAX_COVERED_MINOR) {
      const message =
        `SKIPPED: local python3 is ${live.version}, newer than the highest version the ` +
        `committed artifact covers (3.${MAX_COVERED_MINOR}.x). Add it to ` +
        'SUPPORTED_PYTHON_VERSIONS in scripts/generate-python-stdlib.ts and regenerate.';
      console.warn(message);
      ctx.skip(message);
      return;
    }

    const committed = new Set(PYTHON_STDLIB_MODULE_NAMES);
    const missing = live.modules.filter(m => !committed.has(m));
    expect(
      missing,
      `python3 ${live.version} reports stdlib modules absent from the committed artifact. ` +
        'Run `bun run generate:python-stdlib`.',
    ).toEqual([]);
  });
});
