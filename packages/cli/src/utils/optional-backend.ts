/**
 * Lazy loading for **optional heavy backends** — the seam that keeps a
 * multi-hundred-megabyte dependency out of every other command's cost.
 *
 * ## Why this exists rather than four `await import()` calls
 *
 * `@vibe-agent-toolkit/rag-lancedb` pulls a platform-native LanceDB binary
 * (97.8 MB unpacked on `darwin-arm64`, and larger still on `win32-x64`, where
 * it measured 119.6 MiB) plus `onnxruntime-web` (137.5 MB) and `gpt-tokenizer`
 * (42.2 MB). Summed over the RAG lane's third-party closure against this
 * release's pins, on `darwin-arm64`: **~287 MB unpacked**, and a static import
 * chain from `bin.ts` meant
 * `import('@lancedb/lancedb')` — **1,350 ms cold** — ran before `vat --version`
 * could print a string. It is a named seam rather than a one-off fix because
 * "optional backend" is a shape VAT keeps growing — a projection store is
 * loaded through it too — not because any one dependency is special.
 *
 * ## What it does NOT do
 *
 * It does not fall back, retry, or degrade. An absent backend is a legible
 * error naming the package to install, and nothing more — the point is that
 * the failure is readable, not that it is survivable.
 */

// Deliberately NOT `commands/rag/command-helpers.js`, which is where the rest
// of the rag lane's shared helpers live: that module statically imports
// `@vibe-agent-toolkit/rag-lancedb`, so reaching for it here would load the very
// backend this file exists to defer. The writer and the refusal type load no
// backend — the registry's schemas are backend-free by rule.
import type { ReportVerb } from '../report-schemas.js';

import { CommandRefusalError } from './command-refusal.js';
import { endWithRefusal, NOTHING_FINISHED } from './document-writer.js';

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
 * Exported because every optional backend asks it, and a second copy would be
 * free to drift onto the message.
 *
 * @param error - The thrown value
 * @returns True when the module could not be resolved at all
 */
export function isModuleMissing(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === MODULE_NOT_FOUND
  );
}

/**
 * The refusal for an uninstalled backend: `BACKEND_UNAVAILABLE`, exit **2** — a
 * fact about the installation, not about the user's corpus, and a caller
 * scripting `vat` must be able to tell those apart from the exit code alone.
 *
 * Returned, not thrown and not written, so the verb that needed the backend
 * publishes it in its own shape: {@link lazyAction} ends through the writer, and
 * a store chosen from inside a command (the projection store) throws it into
 * that command's catch.
 *
 * @param backend - What to name and how to install it
 * @returns The coded refusal; its message names the package and the install command
 */
export function missingBackendError(backend: OptionalBackend): CommandRefusalError {
  return new CommandRefusalError(
    'BACKEND_UNAVAILABLE',
    `${backend.feature} is an optional feature and its backend is not installed. `
    + `Install it with: npm install ${backend.packageName} — it ships separately because it carries `
    + 'a platform-native binary that every other vat command would otherwise download and load.',
  );
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
 * An absent backend ends the run through the writer as `verb`'s
 * `BACKEND_UNAVAILABLE` refusal — every leaf behind this seam is a report verb
 * with no `--format` and no `--strict`, so the document is YAML and the gate fixed.
 *
 * @param verb - The report verb the action is, for the refusal document
 * @param backend - What to name in the error when the import fails to resolve
 * @param load - Imports the module and returns the handler out of it
 * @returns A Commander action that loads, then delegates
 *
 * @example
 * ```typescript
 * .action(lazyAction('rag index', RAG_BACKEND, async () => (await import('./index-command.js')).indexCommand))
 * ```
 */
export function lazyAction<Args extends readonly unknown[]>(
  verb: ReportVerb,
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
      endWithRefusal(verb, 'BACKEND_UNAVAILABLE', missingBackendError(backend), 'yaml', { strict: false }, NOTHING_FINISHED);
    }
    await handler(...args);
  };
}
