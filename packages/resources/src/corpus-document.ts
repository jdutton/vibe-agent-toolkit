/**
 * Reading one corpus document — its own module so a parser that only needs the read (`html-link-parser.ts`)
 * does not load the markdown parser `link-parser.ts` imports (`module-load-budget`).
 */

import { readDecodableBytes } from '@vibe-agent-toolkit/utils/fs';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';

/**
 * Read one corpus document: its decoded text and its RAW byte size, from ONE read.
 *
 * `decodeTextContent`, never `readFile(path, 'utf-8')`: a CORPUS document's
 * encoding is not VAT's to choose (see text-content.ts). The size is the length of
 * the very bytes decoded — no second, path-following `stat` (`link-following.ts`) —
 * and it stays raw: see the `sizeBytes` note on `parseMarkdownContent` for why
 * it cannot be derived from the decoded string.
 *
 * @param filePath - Absolute path to the document
 * @returns The decoded text and the byte count it was decoded from
 */
export async function readCorpusDocument(filePath: string): Promise<{ text: string; sizeBytes: number }> {
  const bytes = await readDecodableBytes(filePath);
  return { text: decodeTextContent(bytes).text, sizeBytes: bytes.byteLength };
}
