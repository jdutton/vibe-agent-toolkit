/**
 * The three capabilities VAT wants from a markdown parser, named as interfaces.
 *
 * VAT does not need *a parser*. It needs three separable answers, and today one
 * pipeline supplies all three and is paid for in full even when only the
 * cheapest is wanted. This module is where those three stop being a description
 * in `docs/architecture/parsers-and-load-boundaries.md` §2 and become something
 * a second implementation can be held to.
 *
 * | Capability | What it answers | What it owes `ParseFacts` |
 * |---|---|---|
 * | `spans-and-kinds` | where are the fences, the raw HTML, the frontmatter, the links? | `links`, `anchors`, `frontmatterSource` |
 * | `structure` | what is the heading outline? | `headings` |
 * | `faithful-edit` | can I splice at your offsets and leave every other byte alone? | **nothing** |
 *
 * ## ⛔ The split buys swappability, not speed
 *
 * Every capability above needs tokenizing, and tokenizing is the bulk of a
 * parse, so "skip the tree when you only wanted spans" has a ceiling low enough
 * to have already killed driving micromark directly. Nothing here is a
 * performance change and no performance claim belongs on it — run
 * `bun run bakeoff:parsers . --stage parse|facts` if you want the current
 * figures rather than a stale one copied into prose. What the split buys is
 * that a rival tokenizer can be measured against a contract instead of a diff.
 *
 * ## 🔑 `faithful-edit` contributes ZERO fields, and that is not an oversight
 *
 * It is the **write** side. `ParseFacts` is the read-side fact contract, and the
 * two never meet in one object: `html-transform.ts` and `frontmatter-editor.ts`
 * both implement faithful edit and neither mentions `ParseResult` or
 * `ParseFacts` anywhere. So this module gives it no `toParseFacts()` and no
 * method of its own — it is a **property of the offsets** the other two
 * capabilities already report, declared by {@link ParseCapability} and checked
 * by the conformance suite (`parse-conformance.ts`).
 *
 * ⚠️ How it is checked, precisely — because the obvious test is a tautology.
 * Splicing `content[a,b)` back with `content.slice(a, b)` is the identity for
 * any in-range pair, so it can never fail and proves nothing. What
 * `parse-conformance.ts` does instead is interrogate the offsets themselves: the
 * range must be in bounds and non-empty, the **first** character must be one the
 * kind can legally open with, the **last** must be one it can legally close with
 * where the kind has a fixed closer, no span may end on a line terminator, and
 * no two spans may straddle. Those are falsifiable; a round-trip is not.
 *
 * ⚠️ `parseErrors` is NOT owed by this capability, though it looks like it might
 * be: it is parse5's own well-formedness list from `html-link-parser.ts`, i.e.
 * the HTML lane's, and it reaches `ParseFacts` from there. No markdown
 * implementation produces one, so `SpanFacts` does not ask for it.
 *
 * ## What is VAT's own, and must never be asked of an implementation
 *
 * `estimatedTokenCount`, `contentMeasures`, `lexicalReferences`,
 * `unresolvedReferences` and `frontmatterError` are all derived by VAT from raw
 * source plus the spans below. In particular VAT re-derives CommonMark's
 * label normalization itself (`unresolved-references.ts`), deliberately indexing
 * both the escaped and unescaped spelling of every label because implementations
 * disagree about which they carry. An implementation therefore owes one *field*
 * — {@link SourceSpan.label} on a definition — rather than a dialect rule.
 */

import type { ResourceLink } from './schemas/resource-metadata.js';

/**
 * The capabilities an implementation may declare.
 *
 * Declared rather than inferred from which methods are present, because
 * `faithful-edit` has no method: it is a claim about the offsets the other two
 * report, and a claim has to be made before it can be falsified.
 */
export type ParseCapability = 'spans-and-kinds' | 'structure' | 'faithful-edit';

/**
 * What one span is, in VAT's vocabulary rather than any parser's.
 *
 * ⛔ Deliberately **not** mdast node names. A contract that names one
 * implementation's node types is not a contract — the mistake `LinkNodeTypeSchema`
 * already makes in the persisted link rows, at the price of a cache cold-start
 * to undo. Spans are not persisted, so this one is free to be named right the
 * first time and must stay that way.
 */
export type SpanKind =
  /** A fenced or an indented code block. Both are code; neither is prose. */
  | 'code-block'
  /** A backticked inline span. */
  | 'code-span'
  /** Raw HTML embedded in the document, block or inline. */
  | 'raw-html'
  /** The frontmatter block, delimiters included. */
  | 'frontmatter'
  /** `[text](url)` and autolinks. */
  | 'inline-link'
  /**
   * `![alt](url)`.
   *
   * ⚠️ The reference form `![alt][label]` is deliberately NOT reported: no
   * consumer masks or excludes it today, and adding it would change which
   * candidates `findLexicalReferences` and `findUnresolvedReferences` suppress.
   * It is a gap in coverage, stated rather than papered over.
   */
  | 'image'
  /** `[text][label]` and `[label][]`, once resolved against a definition. */
  | 'reference-link'
  /** `[label]: url` in its own right. */
  | 'link-definition';

/**
 * Compile-time proof that a span consumer routed every {@link SpanKind}.
 *
 * The two consumers of `spans-and-kinds` default in OPPOSITE directions for a
 * kind they do not name — `codeContextRangesFrom` excludes it from lexing,
 * `maskFactsFrom` ignores it — and both are deliberate. That makes an unrouted
 * kind the worst shape of change: it compiles, it is silent, and it moves
 * `lexicalReferences` on one side while leaving the dangling-reference mask on
 * the other. The `image-reference` gap this file states above is exactly the
 * kind somebody is expected to add.
 *
 * Passing `span.kind` here from a `default:` branch makes adding a kind a type
 * error at every call site, so the decision is made once per consumer rather
 * than inherited from whichever branch happened to be last.
 *
 * ⚠️ It deliberately does **not** throw. At runtime the only way to reach it is
 * a non-conforming implementation emitting a kind this build has never heard
 * of, and refusing an adopter's whole document over that is worse than taking
 * the fallback each caller has already stated in prose.
 */
export function assertSpanKindHandled(_kind: never): void {
  // Intentionally empty: the whole effect is in the parameter's `never` type,
  // which is checked at compile time and erased at runtime.
}

/**
 * One construct's half-open extent in the decoded source.
 *
 * ## The offsets are the contract, and they are not line numbers
 *
 * `startOffset`/`endOffset` are **UTF-16 code-unit** indices into the exact
 * string that was handed to {@link MarkdownParser.open} — the same unit
 * `ContentMeasures` counts in, so an astral character advances them by two.
 * `content.slice(startOffset, endOffset)` must be the construct, for every span,
 * with no re-decoding step in between.
 *
 * 🪤 This is the clause an implementation is most likely to fail while looking
 * like it passes. `markdown-it@14` reports **line ranges** rather than character
 * offsets, and only for block tokens — its inline children carry `map: null`.
 * A `SpanKind` set that looks complete says nothing about whether the offsets
 * under it can be spliced at.
 */
export interface SourceSpan {
  kind: SpanKind;
  /** 0-based UTF-16 code-unit offset of the construct's first character. */
  startOffset: number;
  /** 0-based UTF-16 code-unit offset one past its last character. */
  endOffset: number;
  /**
   * `link-definition` spans only: the label, in whatever spelling this
   * implementation carries it.
   *
   * ⚠️ The spelling is deliberately left to the implementation, because VAT
   * normalizes it itself: `referenceLabelKeys` indexes both the escaped and the
   * unescaped normalized form of every label, and it does so *because*
   * implementations are inconsistent here (mdast keeps backslash escapes in a
   * definition's identifier and strips them only from its label). Over-matching
   * in this direction only ever suppresses a dangling-reference finding, which
   * is the way this detector is built to err.
   *
   * Which spelling an implementation reports is therefore a legitimate
   * conformance *finding*, not a conformance *failure*.
   */
  label?: string;
}

/**
 * One heading, before VAT slugs it and nests it.
 *
 * Flat, unslugged and untreed on purpose: `github-slugger`'s `-1`/`-2`
 * suffixing and the parent/child nesting are GitHub's conventions and VAT's
 * code, not facts about the markdown dialect. Asking an implementation for them
 * would be asking it to reproduce a convention it has no reason to know.
 *
 * ⚠️ Order is load-bearing. The slugger is stateful and reproduces GitHub's
 * duplicate suffixing only when fed headings in **document order**.
 */
export interface FlatHeading {
  /** 1–6. */
  level: number;
  /** Text with inline markup flattened away, image `alt` excluded. */
  text: string;
  /**
   * 1-based source line, when the implementation reports one.
   *
   * ⚠️ Optional in the type, load-bearing in practice: the projection splits
   * `blob_sections` rows on this line, and `blob-population.ts` counts what it
   * had to drop as `headingsSkippedForMissingLine`. An implementation that
   * omits it is conformant and still silently shrinks the projection, so omit
   * it only if the sections lane is not in your path.
   */
  line?: number;
}

/** Everything the `spans-and-kinds` capability yields for one document. */
export interface SpanFacts {
  /**
   * ⚠️ Ordered **by kind, not by document position** — all inline links, then
   * all reference links, then all definitions. Within a kind, document order.
   *
   * 🚩 The parse-fact goldens pin this by ordinal, so an implementation that
   * emits links in document order passes every schema check in this repo and
   * fails every golden. `parse-conformance.ts` asserts the bucketing directly
   * rather than leaving the goldens to discover it.
   */
  links: ResourceLink[];
  /** Fragment targets declared as `id`/`name`, lowercased. Possibly empty. */
  anchors: string[];
  /** Every construct of every {@link SpanKind}, in document order. */
  spans: SourceSpan[];
  /** The frontmatter block's source, delimiters excluded. */
  frontmatterSource?: string;
}

/** Everything the `structure` capability yields for one document. */
export interface StructureFacts {
  headings: FlatHeading[];
}

/**
 * One document's parse, held open so both capabilities can be served from it.
 *
 * ## Why a session rather than two standalone functions
 *
 * Every capability needs tokenizing, so two independent calls would tokenize
 * twice. A session lets an implementation do its expensive work once in
 * {@link MarkdownParser.open} and answer both questions from it, which is what
 * keeps naming the capabilities from costing anything — and it keeps the
 * *asking* separable, so a caller that only wants spans never pays for the
 * heading walk.
 *
 * Both methods are optional: an implementation that serves only spans is
 * legitimate, it simply cannot feed chunking or navigation.
 */
export interface ParseSession {
  spansAndKinds?(): SpanFacts;
  structure?(): StructureFacts;
}

/** A markdown parser, as VAT is willing to depend on one. */
export interface MarkdownParser {
  /** Stable identifier, used to label conformance output. */
  readonly name: string;
  /** What this implementation claims. Claims are what conformance falsifies. */
  readonly capabilities: readonly ParseCapability[];
  /** Begin a parse of `content`. */
  open(content: string): ParseSession;
}

/**
 * Thrown when a composer needs a capability the session does not serve.
 *
 * A named error rather than a bare `Error` because the conformance suite has to
 * tell "this implementation cannot produce `ParseFacts` at all" apart from "it
 * produced different ones" — the first is a capability finding and the second is
 * a fidelity finding, and matching on a message string to separate them is how
 * that distinction gets lost.
 */
export class MissingCapabilityError extends Error {
  constructor(
    readonly parserName: string,
    readonly capability: ParseCapability,
  ) {
    super(`Parser "${parserName}" does not serve the ${capability} capability`);
    this.name = 'MissingCapabilityError';
  }
}
