/**
 * @vibe-agent-toolkit/utils/text
 *
 * **The one way bytes become text.** Encoding detection from a byte-order mark,
 * BOM stripping, and a stated default when there is no BOM — see
 * `text-content.ts` for what is a fact, what is an assumption, and the two
 * limitations that are deliberately not guessed around.
 *
 * Pure: this entry reaches no `node:*` builtin and no third-party package, so
 * bytes from a git blob, an HTTP response or a zip entry decode through exactly
 * the same function as bytes from disk. For the read-a-file case, import
 * `readTextContent` from `@vibe-agent-toolkit/utils/fs`, which is this plus a
 * `readFile`.
 */

export {
  decodeTextContent,
  type DecodedText,
  type EncodingBasis,
  type TextEncoding,
} from './text-content.js';
