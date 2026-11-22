/**
 * One skill document's bytes in every encoding a SKILL.md arrives in: what the
 * skill-text wiring suites prove the parse and the skills lane decode alike.
 */

/** Matches in two families, an H1, and a frontmatter block for the body families. */
const SKILL_LINES = ['---', 'name: probe', '---', '# Probe', '', 'Data as of March 2024.', 'Run `sed -i x` here.', '${CLAUDE_PLUGIN_ROOT}/a.sh', ''];

/** The document, LF line ends. */
export const LF_TEXT = SKILL_LINES.join('\n');

/** The document, CRLF line ends. */
export const CRLF_TEXT = SKILL_LINES.join('\r\n');

/** @returns `text` as UTF-16LE bytes behind a BOM */
function utf16le(text: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

/** @returns `text` as UTF-8 bytes behind a BOM */
function utf8Bom(text: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')]));
}

/** Every encoding case: a label, the file's bytes, and the text they decode to. */
export const ENCODINGS: ReadonlyArray<readonly [label: string, bytes: Uint8Array, decoded: string]> = [
  ['UTF-8, LF', new Uint8Array(Buffer.from(LF_TEXT, 'utf-8')), LF_TEXT],
  ['UTF-8, CRLF', new Uint8Array(Buffer.from(CRLF_TEXT, 'utf-8')), CRLF_TEXT],
  ['UTF-8 with a BOM', utf8Bom(LF_TEXT), LF_TEXT],
  ['UTF-8 with a BOM, CRLF', utf8Bom(CRLF_TEXT), CRLF_TEXT],
  ['UTF-16LE with a BOM', utf16le(LF_TEXT), LF_TEXT],
  ['UTF-16LE with a BOM, CRLF', utf16le(CRLF_TEXT), CRLF_TEXT],
];
