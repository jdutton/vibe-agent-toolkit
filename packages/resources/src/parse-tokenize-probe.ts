/**
 * Divide `remark-parse` into micromark TOKENIZING and mdast TREE BUILDING.
 *
 * `remark-parse` is the single largest row the parse-timing seam reports — 83%
 * of attributed parse time on a large adopter tree — and it is opaque. Two very
 * different follow-ons depend on which half of it is expensive, and neither is
 * worth starting on a guess: if tree building dominates, driving micromark
 * directly and skipping mdast is worth sizing; if tokenizing dominates, that
 * option is dead and the only remaining lever is a different parser.
 *
 * ## Why this measures the tokenize half and derives the other
 *
 * `remark-parse`'s parser is exactly
 * `fromMarkdown(doc, {extensions, mdastExtensions})`, whose body is
 * `compiler(options)(postprocess(parse(options).document().write(preprocess()(value))))`.
 * The tokenizing half — `preprocess`, `parse`, `postprocess` — is micromark's
 * published API and can be called directly. `compiler` is NOT exported by
 * `mdast-util-from-markdown`, so tree building cannot be timed on its own.
 *
 * So the seam charges ONE measured row, `micromark-tokenize`, and tree building
 * is `remark-parse` minus that row — a subtraction a reader performs, never a
 * row this module publishes. A derived remainder presented as a measurement is
 * the defect class this codebase already pays a rule for.
 *
 * ## Why the probe re-tokenizes, and why that is gated OFF
 *
 * There is no way to observe the tokenize inside `processor.parse` without
 * replacing it, so the probe runs the tokenizer a SECOND time over the same
 * content. That is real, duplicated work: with the probe on, a markdown
 * document is tokenized twice and `markdown-total` grows by exactly the
 * `micromark-tokenize` row.
 *
 * An instrument that changed its own headline number every time it ran would
 * make every stored report incomparable, so the probe is off unless
 * `VAT_PARSE_TIMING_SPLIT` names an ORDER. The row is still always present, at
 * zero — a reader never has to distinguish an absent pass from an unmeasured
 * one.
 *
 * ## Why the ORDER is the gate's value rather than a boolean
 *
 * The redundant run is biased by whichever tokenize goes second: it reads a
 * string and a code path the first one has already pulled into cache. Running
 * the probe BEFORE the measured parse makes the derived tree-build figure a
 * LOWER bound; running it AFTER makes it an UPPER bound. Taking both readings
 * brackets the answer and, when they agree, retires the caveat with a number
 * instead of a hedge. A boolean gate would have hidden the choice and shipped
 * one of the two bounds as if it were the value.
 */

import { parse, postprocess, preprocess } from 'micromark';

import { createMarkdownProcessor } from './markdown-processor.js';
import { ParsePass, parseTimingStart, recordParsePass } from './parse-timing.js';

/** Where the probe's redundant tokenize sits relative to the measured parse. */
export type TokenizeProbeOrder = 'before' | 'after';

/** The environment variable that turns the probe on and picks its order. */
const PROBE_ENV = 'VAT_PARSE_TIMING_SPLIT';

/** Micromark's tokenizer options — just the extension list, as `parse` takes it. */
type MicromarkParseOptions = NonNullable<Parameters<typeof parse>[0]>;

/** The event stream `postprocess` yields, which the mdast compiler consumes. */
export type TokenizeEvents = ReturnType<typeof postprocess>;

/**
 * Read the probe's order out of an environment value.
 *
 * Exported because it is the part worth testing directly: the gate has to
 * REFUSE a value it does not recognise. A typo that read as "off" would produce
 * a well-formed run with an empty split row in it, and an empty split row is
 * indistinguishable from a run in which tokenizing was free.
 *
 * @param raw - The environment variable's value, if it has one
 * @returns The order, or `null` when the probe is off
 * @throws When the value is neither empty nor a recognised order
 */
export function parseTokenizeProbeOrder(raw: string | undefined): TokenizeProbeOrder | null {
  if (raw === undefined || raw === '') return null;
  if (raw === 'before' || raw === 'after') return raw;
  throw new Error(`${PROBE_ENV} must be 'before' or 'after', not ${JSON.stringify(raw)}`);
}

/**
 * The order in force, read ONCE at module load for the same reason
 * `parse-timing.ts` reads its own gate there: this sits on a path taken 1,364+
 * times per command, and `process.env` access in Node is a native call.
 */
let probeOrder: TokenizeProbeOrder | null = parseTokenizeProbeOrder(process.env[PROBE_ENV]);

/**
 * The extension list the measured parse tokenizes with.
 *
 * Built ONCE from the same three plugins `parseMarkdownContent` composes, and
 * read off the composed processor rather than assembled by hand: a probe
 * tokenizing bare CommonMark would do measurably less work than the parse it is
 * subtracted from, and would report tree building as larger than it is with
 * every number still looking plausible. Reading it from a processor is what
 * makes that impossible to get wrong when a plugin is added or dropped.
 *
 * 🪤 `freeze()` is what runs the attachers, and it is not optional here. A
 * unified processor's `data` is EMPTY until it is frozen — `remark-parse` gets
 * away with reading it inside its parser because a parse freezes the processor
 * first. Read a beat earlier, the list is `undefined`, `parse()` accepts that
 * silently, and the probe tokenizes bare CommonMark: 22 events where the real
 * parser sees 34, and a confident split with no GFM in it.
 */
const micromarkExtensions = createMarkdownProcessor()
  .freeze()
  .data('micromarkExtensions') as MicromarkParseOptions['extensions'];

/**
 * Tokenize markdown exactly as the measured parse's first half does.
 *
 * Exported so a test can assert what came out — the events are discarded on the
 * hot path, so the extension list is otherwise unobservable.
 *
 * @param content - Decoded markdown source
 * @returns The post-processed event stream the mdast compiler would consume
 */
export function markdownTokenizeEvents(content: string): TokenizeEvents {
  return postprocess(
    parse({ extensions: micromarkExtensions })
      .document()
      .write(preprocess()(content, undefined, true)),
  );
}

/**
 * Charge one tokenize to `micromark-tokenize`, if the probe is on and this is
 * its turn.
 *
 * A no-op on both counts when off, so the ordinary timing run pays one
 * comparison per document and nothing else.
 *
 * @param content - Decoded markdown source
 * @param at - Which side of the measured parse this call site sits on
 */
export function probeTokenize(content: string, at: TokenizeProbeOrder): void {
  if (probeOrder !== at) return;
  const startedAt = parseTimingStart();
  markdownTokenizeEvents(content);
  recordParsePass(ParsePass.MicromarkTokenize, startedAt);
}

/** The order in force, or `null` when the probe is off. */
export function tokenizeProbeOrder(): TokenizeProbeOrder | null {
  return probeOrder;
}

/**
 * TEST ONLY. Set the probe's order without mutating the real environment —
 * which a test could not usefully do anyway, since the gate is read once at
 * module load and `vitest.setup.js` deletes every `VAT_*` variable first.
 *
 * @param order - The order to run in, or `null` to turn the probe off
 */
export function __setTokenizeProbeForTest(order: TokenizeProbeOrder | null): void {
  probeOrder = order;
}
