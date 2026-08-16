/**
 * Lazy loading for **optional heavy backends** — the seam that keeps a
 * multi-hundred-megabyte dependency out of every other command's cost.
 *
 * ## Why this exists rather than four `await import()` calls
 *
 * `@vibe-agent-toolkit/rag-lancedb` pulls a platform-native LanceDB binary
 * (119.6 MiB unpacked on `win32-x64`, 40.3 MiB compressed to download) plus
 * `onnxruntime-web` (133 MB) and `gpt-tokenizer` (44 MB). Measured on the
 * published `vibe-agent-toolkit@0.1.42`: **275 MB of a 351 MB install is the
 * RAG lane**, and a static import chain from `bin.ts` meant
 * `import('@lancedb/lancedb')` — **1,350 ms cold** — ran before `vat --version`
 * could print a string. A second heavy backend (DuckDB WASM) is already
 * planned, which is what makes this a named seam rather than a one-off fix.
 *
 * ## What it does NOT do
 *
 * It does not fall back, retry, or degrade. An absent backend is a legible
 * error naming the package to install, and nothing more — the point is that
 * the failure is readable, not that it is survivable.
 */

// Deliberately NOT `commands/rag/command-helpers.js`, which is where the rest
// of the rag lane's shared helpers live: that module statically imports
// `@vibe-agent-toolkit/rag-lancedb`, so reaching for its `handleCommandError`
// here would load the very backend this file exists to defer.
import { writeYamlOutput } from './output.js';

/**
 * Node's code for "the module is genuinely not installed".
 *
 * Matched on `code`, never on the message: the message embeds the specifier and
 * the importing file and is not a stable contract, while the code is. A miss
 * here would be reported as a missing backend when the real cause was a syntax
 * error *inside* the backend, which is the worst possible diagnosis.
 */
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';

/**
 * Whether a thrown value is Node's "module not installed" error.
 *
 * @param error - The thrown value
 * @returns True when the module could not be resolved at all
 */
function isModuleMissing(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === MODULE_NOT_FOUND
  );
}

/**
 * Report an uninstalled backend and exit, in the shape every other command
 * failure takes.
 *
 * Exit code **2** — a system error, not a validation failure. An absent
 * optional package is a fact about the installation rather than about the
 * user's corpus, and a caller scripting `vat` must be able to tell those apart
 * from the exit code alone.
 *
 * @param backend - What to name and how to install it
 * @returns Never; the process exits
 */
function reportMissingBackend(backend: OptionalBackend): never {
  const install = `npm install ${backend.packageName}`;
  process.stderr.write(
    `${backend.feature} is an optional feature and its backend is not installed.\n`
    + `\nInstall it with:  ${install}\n`
    + '\nIt ships separately because it carries a platform-native binary that every\n'
    + 'other vat command would otherwise download and load.\n',
  );
  writeYamlOutput({
    status: 'error',
    error: `${backend.feature} backend not installed: ${backend.packageName}`,
    fix: install,
  });
  process.exit(2);
}

/** One optional backend, as a user is told to install it. */
export interface OptionalBackend {
  /** Human name used in the error message, e.g. `RAG`. */
  readonly feature: string;
  /** The npm package to install, e.g. `@vibe-agent-toolkit/rag-lancedb`. */
  readonly packageName: string;
}

/**
 * Bind a Commander action that loads its implementation on first invocation.
 *
 * The returned function has the same shape Commander expects, so a command
 * declaration keeps every option, description and help block it had — only the
 * *implementation* moves behind the `await`. Help text is static data and must
 * stay eagerly available, which is exactly why the split is at the action
 * rather than at the command.
 *
 * @param backend - What to name in the error when the import fails to resolve
 * @param load - Imports the module and returns the handler out of it
 * @returns A Commander action that loads, then delegates
 *
 * @example
 * ```typescript
 * .action(lazyAction(RAG_BACKEND, async () => (await import('./index-command.js')).indexCommand))
 * ```
 */
export function lazyAction<Args extends readonly unknown[]>(
  backend: OptionalBackend,
  load: () => Promise<(...args: Args) => unknown>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    let handler: (...handlerArgs: Args) => unknown;
    try {
      handler = await load();
    } catch (error) {
      if (!isModuleMissing(error)) {
        throw error;
      }
      reportMissingBackend(backend);
    }
    await handler(...args);
  };
}
