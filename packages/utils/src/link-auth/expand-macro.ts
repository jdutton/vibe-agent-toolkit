/**
 * Macro loader + expander.
 *
 * Loads the bundled `macros.yaml` once at module init and exposes
 * `expandMacro(name, overrides?)` which deep-merges the named macro with any
 * adopter overrides. The merge is "adopter wins": objects merge recursively,
 * arrays and primitives are replaced wholesale (no element-wise array merge).
 *
 * The shipped macro file is at `link-auth/macros.yaml`, copied into the dist
 * tree by `packages/dev-tools/src/copy-yaml-assets.ts` during build so the
 * runtime `fs.readFileSync(new URL('./macros.yaml', import.meta.url))`
 * resolves in both source-mode (vitest) and built-mode (dist).
 *
 * Per design issue #113 §5 (macros are config, not a privileged code path).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

let macrosCache: Record<string, Record<string, unknown>> | undefined;

/**
 * Load macros lazily on first use rather than at module init.
 *
 * Why lazy: vitest tests elsewhere in the repo mock `node:fs` (replacing
 * `readFileSync` with `vi.fn()` that returns `undefined`). If we eagerly read
 * at module load, any unrelated test that imports `@vibe-agent-toolkit/utils`
 * and mocks fs crashes inside `parseYaml(undefined)` — module-init code runs
 * unconditionally, before the mock-setup intent reaches our file.
 *
 * Lazy load makes module import side-effect-free; only callers of
 * `expandMacro` pay the fs cost. `macrosPath` is also computed here (not at
 * module top level) so that merely importing this module leaves no `new URL()`
 * reference for bundler static analysis to trip over.
 */
function getMacros(): Record<string, Record<string, unknown>> {
  if (macrosCache !== undefined) return macrosCache;

  // Path is derived from `import.meta.url`, not user input — points at the
  // shipped macros.yaml asset next to this module in both src and dist trees.
  const macrosPath = fileURLToPath(new URL('./macros.yaml', import.meta.url));
  // Not a content read: `macros.yaml` is an asset THIS PACKAGE authors, commits
  // and publishes beside this module, so the encoding was chosen at the write
  // rather than discovered at the read. Left on the raw reader deliberately —
  // the lazy-load note above documents that tests elsewhere mock
  // `readFileSync`, and routing this through another module's import of it is
  // gratuitous risk for a file whose bytes we control.
  // eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-raw-text-decode -- our own published asset; writer is this package
  const macrosFileContent = readFileSync(macrosPath, 'utf8');
  const parsed = parseYaml(macrosFileContent) as unknown;

  if (!isPlainObject(parsed)) {
    throw new Error('macros.yaml: expected top-level object mapping macro name → provider config.');
  }

  macrosCache = freezeMacros(parsed);
  return macrosCache;
}

/**
 * Thrown when a `use: <name>` references a macro not in the shipped set.
 * Message lists the available macros so a typo surfaces clearly.
 */
export class UnknownMacroError extends Error {
  constructor(name: string, available: readonly string[]) {
    super(`Unknown macro "${name}". Available: ${available.join(', ')}.`);
    this.name = 'UnknownMacroError';
  }
}

/**
 * Look up a macro by name and deep-merge optional adopter overrides on top.
 *
 * Merge semantics:
 *   - Plain objects merge recursively (sibling keys preserved).
 *   - Arrays are replaced wholesale (override's array wins; no concat).
 *   - Primitives are replaced.
 *   - `undefined` in an override is treated as "not provided" (base wins).
 *
 * The returned object and all nested plain objects use null prototypes so
 * `__proto__` / `constructor` keys can never poison consumers.
 *
 * @throws {UnknownMacroError} if `name` is not in the shipped macro set
 */
export function expandMacro(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const macros = getMacros();
  const base = macros[name];
  if (base === undefined) {
    throw new UnknownMacroError(name, Object.keys(macros));
  }
  if (overrides === undefined) {
    return cloneWithNullProto(base);
  }
  const merged = deepMerge(base, overrides);
  // Top-level result is guaranteed object here because base is.
  return merged as Record<string, unknown>;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return cloneValue(override);

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) {
    result[key] = cloneValue(value);
  }
  for (const [key, value] of Object.entries(override)) {
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) return cloneWithNullProto(value);
  return value;
}

function cloneWithNullProto(obj: Record<string, unknown>): Record<string, unknown> {
  const cloned = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    cloned[key] = cloneValue(value);
  }
  return cloned;
}

function freezeMacros(parsed: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const frozen: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [name, value] of Object.entries(parsed)) {
    if (!isPlainObject(value)) {
      throw new Error(`macros.yaml: macro "${name}" is not an object.`);
    }
    frozen[name] = cloneWithNullProto(value);
  }
  return frozen;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
