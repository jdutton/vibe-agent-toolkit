/**
 * ESLint rule: no-raw-text-decode
 *
 * **One seam turns file bytes into text; every other route is an error.**
 *
 * ## What it is for
 *
 * `bytes.toString('utf-8')` is a guess dressed as a conversion. It ignores every
 * byte-order mark, cannot express UTF-16BE at all (Node's `Buffer` has no such
 * encoding), and turns a perfectly ordinary UTF-16 document into NUL-interleaved
 * mojibake — which downstream code then classifies as *binary*. Measured in VAT:
 * a `working-tree-encoding=UTF-16` checkout of a markdown file yielding one
 * heading and one link produced **no blob row, no section and no reference**,
 * because the read decoded it wrong and the binary sniff believed the result.
 * PowerShell 5.1's `Out-File` and `>` write UTF-16LE by default, so this is a
 * Windows-authored document, not an exotic one.
 *
 * The fix is a single decoding seam that reads the encoding off the BOM and says
 * so. This rule is what keeps a second, private decoder from growing beside it.
 *
 * ## The three shapes it catches
 *
 * | shape | example |
 * |---|---|
 * | `toString(<encoding>)` on any value | `buf.toString('utf-8')` |
 * | constructing a decoder | `new TextDecoder('utf-16le')` |
 * | letting `fs` decode | `readFile(p, 'utf-8')`, `readFileSync(p, { encoding: 'latin1' })` |
 *
 * ## The line this rule is drawing: whose choice was the encoding?
 *
 * **Not every `'utf-8'` read is a content read**, and the distinction is the
 * whole difference between a rule that survives and one that gets widened until
 * it means nothing. Three categories, and every call site is in exactly one:
 *
 * 1. **A document from the corpus** — an adopter's markdown, HTML, `SKILL.md`,
 *    config file, JSON schema or `package.json`. Nobody in this codebase chose
 *    the encoding; it has to be **discovered** from the bytes. *This is the
 *    rule's target*, and the seam is the only correct reader.
 * 2. **An artifact this project wrote** — its own cache entry, its own emitted
 *    manifest, an asset it publishes beside its own code. The encoding was
 *    **chosen at the write**, so reading it back the same way is a closed loop,
 *    not a decode.
 * 3. **Bytes that were never a file** — a subprocess's stdout, an HTTP response
 *    body, a Buffer this process built. There is no file encoding to discover;
 *    the **producer's contract** decides.
 *
 * Static analysis cannot tell the three apart — `buf.toString('utf8')` looks
 * identical whether the Buffer came from `readFile` or from `spawn`. So the rule
 * reports all three, and 2 and 3 are settled at the call site with a one-line
 * `eslint-disable-next-line` that **names the writer or the producer**.
 *
 * That gives a reviewer a falsifiable test, which is the point: *a justification
 * that cannot name who wrote the bytes is a category-1 call wearing a disable
 * comment.* "It's always UTF-8 in practice" names nobody and does not qualify.
 * Do not settle these by adding paths to `exemptFiles` until lint goes quiet —
 * `exemptFiles` is for the seam's own implementation file, nothing else.
 *
 * ## Why the encoding test is an EXCLUSION and not an inclusion list
 *
 * An inclusion list of character encodings would have to enumerate every legal
 * spelling — `utf8`, `utf-8`, `utf16le`, `ucs2`, `ucs-2`, `latin1`, `binary`,
 * `ascii`, the `iso-8859-*` family, the `windows-125*` family, and every
 * `TextDecoder` label alias beyond those — and a spelling it missed would pass
 * silently. That is a rule that fails OPEN, in the one direction that matters.
 *
 * Node's `Buffer` encodings are a CLOSED set, and exactly three of them are
 * binary-to-text codecs rather than character encodings: `base64`, `base64url`
 * and `hex`. So "a string argument that is not one of those three" is both
 * exhaustive over `Buffer` and correct for `TextDecoder` (whose labels are all
 * character encodings). Excluding three known-safe values fails CLOSED: an
 * encoding nobody anticipated still fires.
 *
 * ## What it does NOT catch, stated so the coverage is not overclaimed
 *
 * - **A computed encoding** — `buf.toString(enc)`, `readFile(p, enc)`. Firing on
 *   a non-literal second argument is untenable without type information:
 *   `n.toString(radix)` with a variable radix is ordinary code, and
 *   `readFile(p, callback)` in callback style has the same shape as
 *   `readFile(p, encoding)`. A rule that fires on both teaches people to disable
 *   it, which costs its true positives too — this repo has already demoted one
 *   rule (`no-unsafe-root-join`) for precisely that. So the trigger is a string
 *   LITERAL, and a variable holding `'utf-8'` is a bypass a reviewer can see and
 *   a linter cannot.
 * - `createReadStream(path, 'utf-8')` and other streaming decodes. No VAT code
 *   does this; it is a real hole, not a decision that it is safe.
 * - A subprocess's stdout decoded with `.toString('utf8')` IS caught, and that
 *   is usually a false positive — process output is not file content and its
 *   encoding is the child's business. Nothing here can tell the two apart
 *   statically, which is why the rule is registered against the directories that
 *   read corpus documents rather than repo-wide. See the consuming config.
 * - `require()`/`import()` of a JSON or data file, which decode below the public
 *   `fs` surface entirely.
 *
 * @example
 * ```javascript
 * // ❌ BAD
 * const text = (await readFile(p)).toString('utf-8');
 * const text = await readFile(p, 'utf-8');
 * const text = new TextDecoder().decode(bytes);
 *
 * // ✅ GOOD — category 1, the corpus document
 * const { text } = await readTextContent(p);
 * const { text } = decodeTextContent(bytes);
 *
 * // ✅ GOOD — category 3, and the justification names the producer
 * // eslint-disable-next-line local/no-raw-text-decode -- subprocess stdout; producer is the credential helper spawned above
 * const out = result.stdout.toString('utf8');
 * ```
 */

'use strict';

const {
  EXEMPT_FILES_SCHEMA,
  UNANCHORED_EXEMPT_FILE,
  UNANCHORED_EXEMPT_MESSAGE,
  createConfigurableExemptPathMatcher,
  reportUnanchoredExemptEntries,
} = require('./exempt-path-matcher.cjs');
const { resolveSafeModule, withSafeModuleOption } = require('./safe-import.cjs');

/**
 * The default module named in the advice text.
 *
 * A placeholder, and deliberately not this package: the seam lives in the
 * consuming repo, so `safeModule` is the option every real config sets. Named
 * rather than left blank so the message is still a sentence when it is not.
 */
const DEFAULT_SEAM_MODULE = 'your content-decoding module';

/**
 * The three `Buffer` encodings that are binary-to-text codecs, not character
 * encodings. Everything else is a decode. See the module docstring for why the
 * test is shaped this way round.
 */
const BINARY_TO_TEXT_CODECS = new Set(['base64', 'base64url', 'hex']);

/** The `fs` readers that will decode for you if handed an encoding. */
const DECODING_READERS = new Set(['readFile', 'readFileSync']);

/**
 * Is this node a string literal (or a template with no substitutions)?
 *
 * @param {object} node - AST node
 * @returns {string | null} Its value, or `null` when it is not a plain string
 */
function stringValueOf(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

/**
 * Does this argument spell out a character encoding?
 *
 * Only a string LITERAL counts — see the module docstring for why a computed
 * encoding is deliberately out of reach. A numeric radix (`n.toString(16)`) is
 * not a string and so is never a decode.
 *
 * @param {object} node - The argument node
 * @returns {boolean} True when the argument names a character encoding
 */
function isCharacterEncodingArgument(node) {
  const literal = stringValueOf(node);
  if (literal === null) return false;
  return !BINARY_TO_TEXT_CODECS.has(literal.toLowerCase());
}

/**
 * The `{ encoding: '...' }` option object's encoding argument, if it selects a
 * character encoding.
 *
 * @param {object} node - The argument node
 * @returns {boolean} True when the options object asks `fs` to decode
 */
function optionsObjectDecodes(node) {
  if (node?.type !== 'ObjectExpression') return false;
  for (const property of node.properties) {
    if (property.type !== 'Property') continue;
    const key = property.key?.type === 'Identifier'
      ? property.key.name
      : stringValueOf(property.key);
    if (key !== 'encoding') continue;
    // An explicit `encoding: null` / `encoding: undefined` asks for a Buffer.
    if (property.value?.type === 'Literal' && property.value.value === null) return false;
    return isCharacterEncodingArgument(property.value);
  }
  return false;
}

/** The called function's name, whether it is bare or a member call. */
function calleeName(node) {
  if (node.callee?.type === 'Identifier') return node.callee.name;
  if (node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier') {
    return node.callee.property.name;
  }
  return null;
}

const exemptMatcherFor = createConfigurableExemptPathMatcher([]);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow decoding bytes to text outside the one content-decoding seam; '
        + 'raw `toString(encoding)` / `TextDecoder` / `readFile(path, encoding)` '
        + 'ignore byte-order marks and cannot express UTF-16BE at all.',
      category: 'Correctness',
      recommended: false,
    },
    schema: [withSafeModuleOption(EXEMPT_FILES_SCHEMA)],
    messages: {
      bufferTextDecode:
        'Do not decode bytes with `.toString({{encoding}})` — it ignores any byte-order mark and '
        + 'cannot express UTF-16BE. Use `decodeTextContent()` from {{safeModule}}.',
      textDecoderConstruct:
        'Do not construct a `TextDecoder` here — the encoding has to be decided from the bytes, '
        + 'in one place. Use `decodeTextContent()` from {{safeModule}}.',
      fsReadTextEncoding:
        'Do not let `{{reader}}` decode — it applies the encoding you name with no BOM handling. '
        + 'Read bytes and use `readTextContent()` / `decodeTextContent()` from {{safeModule}}.',
      [UNANCHORED_EXEMPT_FILE]: UNANCHORED_EXEMPT_MESSAGE,
    },
  },

  create(context) {
    const seamModule = resolveSafeModule(context, DEFAULT_SEAM_MODULE);

    // The seam itself must be able to call the primitives it wraps.
    if (exemptMatcherFor(context)(context.getFilename())) {
      // Still surface a malformed exemption list: the file we are standing in
      // may be exempt only BECAUSE the entry is unanchored.
      return {
        Program(node) {
          reportUnanchoredExemptEntries(context, node);
        },
      };
    }

    return {
      Program(node) {
        reportUnanchoredExemptEntries(context, node);
      },

      NewExpression(node) {
        if (node.callee?.type !== 'Identifier' || node.callee.name !== 'TextDecoder') return;
        context.report({
          node,
          messageId: 'textDecoderConstruct',
          data: { safeModule: seamModule },
        });
      },

      CallExpression(node) {
        const name = calleeName(node);
        if (name === null) return;

        if (
          name === 'toString'
          && node.callee.type === 'MemberExpression'
          && node.arguments.length > 0
          && isCharacterEncodingArgument(node.arguments[0])
        ) {
          context.report({
            node,
            messageId: 'bufferTextDecode',
            data: {
              safeModule: seamModule,
              encoding: context.getSourceCode().getText(node.arguments[0]),
            },
          });
          return;
        }

        if (!DECODING_READERS.has(name) || node.arguments.length < 2) return;
        const second = node.arguments[1];
        // Object form first: `{ encoding: 'hex' }` is an ObjectExpression, and
        // asking the positional test about it would answer the wrong question.
        const decodes = second?.type === 'ObjectExpression'
          ? optionsObjectDecodes(second)
          : isCharacterEncodingArgument(second);
        if (decodes) {
          context.report({
            node,
            messageId: 'fsReadTextEncoding',
            data: { reader: name, safeModule: seamModule },
          });
        }
      },
    };
  },
};
