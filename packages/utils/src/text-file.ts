/**
 * Read a file and decode it through the one content-decoding seam.
 *
 * The replacement for `readFile(path, 'utf-8')`, which decodes inside `fs` with
 * no byte-order-mark handling and no way to express UTF-16BE at all. The
 * *decision* about what the bytes say lives in `text-content.ts`, which is pure
 * and reaches no `node:*` module; this file is only the two lines that get the
 * bytes off disk, and it lives on the `./fs` entry with everything else here
 * that touches the filesystem.
 *
 * Two functions rather than one, because the callers genuinely differ: an
 * enumeration or parse lane is asynchronous throughout, while a manifest or
 * config probe on a startup path is not, and handing the latter a Promise makes
 * it worse rather than more consistent.
 *
 * A caller that needs the RAW bytes as well as the text — to hash them, key
 * them, or report `stat().size` — must not use these: read the bytes once itself
 * and call `decodeTextContent` on them, so the digest and the characters come
 * from the same read. `readContentWithKey` in `@vibe-agent-toolkit/resources` is
 * that caller and is shaped exactly that way.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { decodeTextContent, type DecodedText } from './text-content.js';

/**
 * Read a file and decode it through {@link decodeTextContent}.
 *
 * @param filePath - Path to read
 * @returns The decoded text, the encoding used, and whether it was a fact
 * @throws Whatever `readFile` throws — callers decide whether that is fatal
 *
 * @example
 * ```typescript
 * const { text, encoding } = await readTextContent(docPath);
 * // A PowerShell-written document: encoding 'utf-16le', text with no BOM
 * ```
 */
export async function readTextContent(filePath: string): Promise<DecodedText> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the parsers this feeds
  return decodeTextContent(await readFile(filePath));
}

/**
 * {@link readTextContent}, synchronously.
 *
 * @param filePath - Path to read
 * @returns The decoded text, the encoding used, and whether it was a fact
 * @throws Whatever `readFileSync` throws
 */
export function readTextContentSync(filePath: string): DecodedText {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the parsers this feeds
  return decodeTextContent(readFileSync(filePath));
}
