import { extname } from 'node:path';

import { anchorEvidencePath, buildEvidence, type EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

import { PYTHON_STDLIB_MODULE_NAMES } from './python-stdlib-modules.generated.js';

/**
 * Python standard-library module names, used to tell a stdlib import from a
 * genuine third-party dependency.
 *
 * Generated from CPython's own `sys.stdlib_module_names` across every supported
 * Python version — never hand-edited. See
 * `scripts/generate-python-stdlib.ts`.
 */
export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set(PYTHON_STDLIB_MODULE_NAMES);

/** Map script extensions to the pattern ID that records their presence. */
const SCRIPT_EXTENSION_PATTERNS: Record<string, string> = {
  '.py': 'SCRIPT_FILE_PYTHON',
  '.sh': 'SCRIPT_FILE_SHELL',
  '.bash': 'SCRIPT_FILE_SHELL',
  '.mjs': 'SCRIPT_FILE_NODE',
  '.js': 'SCRIPT_FILE_NODE',
  '.cjs': 'SCRIPT_FILE_NODE',
};

/** Regex for `import X` and `import X as Y` */
const IMPORT_RE = /^import\s+(\w+)/;

/** Regex for `from X import Y` and `from X.sub import Y` */
const FROM_IMPORT_RE = /^from\s+(\w+)/;

/**
 * Classify a script file by its extension. Returns a single SCRIPT_FILE_*
 * evidence record when the extension matches a known script type.
 */
export function classifyScriptFile(filePath: string, locationRoot: string): EvidenceRecord | undefined {
  const ext = extname(filePath).toLowerCase();
  const patternId = SCRIPT_EXTENSION_PATTERNS[ext];
  if (patternId === undefined) {
    return undefined;
  }
  // The message names the file, so it must be spelled the same anchored way the
  // location is — otherwise an absolute path leaks via `matchText` instead.
  const anchored = anchorEvidencePath(filePath, locationRoot);
  return buildEvidence(patternId, filePath, locationRoot, `script file: ${anchored}`);
}

/**
 * Parse Python source content for import statements and return evidence
 * for any third-party (non-stdlib) imports found, one record per distinct
 * module.
 */
export function scanPythonImports(
  content: string,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  const thirdPartyModules = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    let moduleName: string | undefined;

    const importMatch = IMPORT_RE.exec(trimmed);
    if (importMatch) {
      moduleName = importMatch[1];
    }

    const fromMatch = FROM_IMPORT_RE.exec(trimmed);
    if (fromMatch) {
      moduleName = fromMatch[1];
    }

    if (moduleName && !PYTHON_STDLIB_MODULES.has(moduleName)) {
      thirdPartyModules.add(moduleName);
    }
  }

  const evidence: EvidenceRecord[] = [];

  for (const moduleName of thirdPartyModules) {
    evidence.push(
      buildEvidence(
        'PYTHON_IMPORT_THIRD_PARTY',
        filePath,
        locationRoot,
        `third-party import: ${moduleName}`,
      ),
    );
  }

  return evidence;
}
