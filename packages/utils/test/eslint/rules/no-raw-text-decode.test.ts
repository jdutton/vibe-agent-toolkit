import { describe, it } from 'vitest';

import { BUFFER_UTF8_DECODE, LINTED_FILE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/** The seam this rule points at, and the file that implements it. */
const TEXT_SEAM = '@vibe-agent-toolkit/resources';
const TEXT_SEAM_IMPL = 'packages/resources/src/text-content.ts';
const TEXT_DECODE_OPTIONS = [{ safeModule: TEXT_SEAM, exemptFiles: [TEXT_SEAM_IMPL] }];


/**
 * `no-raw-text-decode`.
 *
 * The valid half is where this rule earns its keep or loses it: a decoder guard
 * that also fires on `n.toString(16)` and `buf.toString('base64')` would be
 * disabled by the first person it inconvenienced. Every one of those is pinned.
 */
const CASES: RuleCases = {
  valid: [
    // The seam itself.
    { code: "const d = new TextDecoder('utf-8');", filename: TEXT_SEAM_IMPL, options: TEXT_DECODE_OPTIONS },
    { code: BUFFER_UTF8_DECODE, filename: TEXT_SEAM_IMPL, options: TEXT_DECODE_OPTIONS },
    // Binary-to-text codecs are not character encodings.
    { code: "const b = buf.toString('base64');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const b = buf.toString('base64url');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const h = buf.toString('hex');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const h = buf.toString('HEX');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const raw = await readFile(p, 'hex');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const raw = readFileSync(p, { encoding: 'base64' });", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // Not encodings at all.
    { code: 'const s = n.toString(16);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const s = value.toString();', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const s = big.toString(radix);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // Reads that ask for bytes.
    { code: 'const bytes = await readFile(p);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const bytes = readFileSync(p, { encoding: null });', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const bytes = await fsModule.readFile(p);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // A callback-style read: the same SHAPE as an encoding argument, and the
    // reason a non-literal second argument is deliberately not reported.
    { code: 'readFile(p, done);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // The seam's own API.
    { code: 'const { text } = decodeTextContent(bytes);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // A writer, not a reader. `update(s, 'utf-8')` ENCODES a string to bytes.
    { code: "createHash('sha256').update(content, 'utf-8');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "await writeFile(p, text, 'utf-8');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
  ],
  invalid: [
    {
      code: BUFFER_UTF8_DECODE,
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: "const t = Buffer.concat(chunks).toString('utf8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    // An encoding nobody put on a list: the exclusion test fails CLOSED.
    {
      code: "const t = buf.toString('windows-1252');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: 'const t = buf.toString(`latin1`);',
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: 'const d = new TextDecoder();',
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'textDecoderConstruct' }],
    },
    {
      code: "const t = new TextDecoder('utf-16be').decode(bytes);",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'textDecoderConstruct' }],
    },
    {
      code: "const t = await readFile(p, 'utf-8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    {
      code: "const t = readFileSync(p, 'utf8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    {
      code: "const t = await fs.promises.readFile(p, { encoding: 'utf-8' });",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    // An INJECTED fs module is still an fs read — the rule keys on the method
    // name, not on whether the receiver is literally `fs`.
    {
      code: "const t = await fsModule.readFile(p, 'utf-8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    // An unanchored exemption is reported even where the code is clean, and the
    // exemption itself does NOT take effect from a bare basename.
    {
      code: BUFFER_UTF8_DECODE,
      filename: 'packages/somewhere/else/text-content.ts',
      options: [{ safeModule: TEXT_SEAM, exemptFiles: ['text-content.ts'] }],
      errors: [{ messageId: 'unanchoredExemptFile' }],
    },
  ],
};

describe('no-raw-text-decode', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-raw-text-decode', CASES); });
});
