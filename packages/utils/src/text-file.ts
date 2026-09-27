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
 * them, or report `stat().size` — must not use these: read the bytes once with
 * {@link readDecodableBytes} and call `decodeTextContent` on them, so the digest
 * and the characters come from the same read. `readContentWithKey` in
 * `@vibe-agent-toolkit/resources` is that caller and is shaped exactly that way.
 */

import { constants } from 'node:buffer';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

import { decodeTextContent, TextTooLargeError, type DecodedText } from './text-content.js';

/**
 * Read a file and decode it through {@link decodeTextContent}.
 *
 * @param filePath - Path to read
 * @returns The decoded text, the encoding used, whether that was a fact, and the replacement-character count
 * @throws Whatever `readFile` throws — callers decide whether that is fatal — and
 *   {@link TextTooLargeError} for a file too large to decode, before reading it
 *
 * @example
 * ```typescript
 * const { text, encoding } = await readTextContent(docPath);
 * // A PowerShell-written document: encoding 'utf-16le', text with no BOM
 * ```
 */
export async function readTextContent(filePath: string): Promise<DecodedText> {
  return decodeTextContent(await readDecodableBytes(filePath));
}

/**
 * {@link readTextContent}, synchronously.
 *
 * @param filePath - Path to read
 * @returns The decoded text, the encoding used, whether that was a fact, and the replacement-character count
 * @throws Whatever `readFileSync` throws, and {@link TextTooLargeError} as {@link readDecodableBytes} does
 */
export function readTextContentSync(filePath: string): DecodedText {
  const handle = openSync(filePath, 'r');
  try {
    refuseUndecodableSize(fstatSync(handle).size);
    return decodeTextContent(readFileSync(handle));
  } finally {
    closeSync(handle);
  }
}

/**
 * The most bytes that can be decoded into one JS string: the engine's own
 * string-length limit, read from `node:buffer` rather than written down.
 *
 * A bound on BYTES stated in UTF-16 code units, which is exact-or-safe for UTF-8
 * (a UTF-8 byte never yields more than one code unit) and conservative for
 * UTF-16/UTF-32, whose bytes yield half or a quarter as many.
 */
export const MAX_DECODABLE_BYTES: number = constants.MAX_STRING_LENGTH;

/**
 * Whether content of this many bytes is past what can be decoded to a string.
 *
 * @param byteLength - The content's size in bytes, as `stat` reports it
 * @returns True when decoding it would exceed {@link MAX_DECODABLE_BYTES}
 */
export function exceedsDecodableLength(byteLength: number): boolean {
  return byteLength > MAX_DECODABLE_BYTES;
}

/**
 * Throw {@link TextTooLargeError} for a size no decode can hold.
 *
 * @param byteLength - The content's size in bytes
 */
function refuseUndecodableSize(byteLength: number): void {
  if (exceedsDecodableLength(byteLength)) throw new TextTooLargeError(byteLength);
}

/**
 * Read a file's raw bytes for decoding — refusing, by `stat` and before reading
 * a byte, one too large to decode at all.
 *
 * The one read path for "bytes that are about to go through
 * {@link decodeTextContent}": {@link readTextContent} uses it, and so does
 * `readContentWithKey` in `@vibe-agent-toolkit/resources`, which needs the raw
 * bytes as well to key them. Without the stat, a 966 MB file is read whole and
 * only then refused by the decoder, and past 2 GiB `readFile` fails first with
 * its own `ERR_FS_FILE_TOO_LARGE` — two different errors for one fact.
 *
 * The size comes from `fstat` on the handle that is then read, not from a
 * separate `stat` of the path, so a rename between the two cannot substitute
 * another file. A file that GROWS past the limit after the `fstat` still reaches
 * the decoder, which raises the same {@link TextTooLargeError}.
 *
 * @param filePath - Path to read
 * @returns The file's bytes
 * @throws {@link TextTooLargeError} when the file is past {@link MAX_DECODABLE_BYTES},
 *   and whatever `open`/`readFile` throw otherwise
 */
export async function readDecodableBytes(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    refuseUndecodableSize((await handle.stat()).size);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
