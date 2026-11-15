/**
 * ESLint rule: no-decaying-referent
 *
 * Flags, in comments under `src/`, three kinds of referent that rot in place:
 *
 * - an issue or PR number (`#145`) — the issue closes, the PR merges, and the
 *   comment keeps pointing at a discussion nobody reopens;
 * - an ISO date (`2026-08-22`, `2026-08`) — "re-derived on" is a claim about
 *   freshness that is false the day after it is written;
 * - a named person (`Jeff`, configurable) — a ruling attributed to someone is a
 *   ruling nobody else feels entitled to revisit.
 *
 * None of these is the RULE the comment exists to state. The rule stays; the
 * history goes where history is kept — the commit message, the CHANGELOG, or
 * `docs/contributing/` — and `git log -L` holds the rest without decaying.
 *
 * Scope: files with a `/src/` segment that are not test files. Tests and
 * scripts are not linted here; Markdown never reaches ESLint. One report per
 * comment block, on the FIRST referent found, whichever kind it is — the fix is
 * to rewrite the comment, not to hunt tokens one at a time.
 *
 * Options:
 * - `names: string[]` — whole-word, case-sensitive names to treat as referents
 *   (default `['Jeff']`). Pass `[]` to disable the class.
 * - `allowDates: boolean` — leave dates alone (default `false`).
 *
 * One line shape is exempt without an option: `@vendor-claim reviewed=<date>
 * verify=<how>`. That date is READ by a freshness gate that fails the build when
 * it ages past its budget — a date with a mechanism behind it is the opposite of
 * a decaying one. The exemption covers only the line carrying the tag.
 *
 * @example
 * // BAD — the reader must open #145 to learn what the code does
 * // Fixed in #145 (Jeff, 2026-08-22): skip the second crawl.
 *
 * // GOOD — the rule, stated; the history is in `git log -L`
 * // The second crawl is skipped: the first already answered from git.
 */

'use strict';

const { isTestFile } = require('./exempt-path-matcher.cjs');

/** `#12` … `#1234`, not preceded by a word/URL/entity character and not part of a longer number. */
const ISSUE_REF = /(?<![\w/&#])#\d{2,4}(?!\d)/u;

/**
 * `20YY-MM` or `20YY-MM-DD`, standing alone. Glued to a word, a hyphen or a
 * path separator it names a thing (`sweep-2026-09-12/`, a JSON Schema dialect's
 * `draft/2020-12/schema`), not a day something was true.
 */
const ISO_DATE = /(?<![\w/-])20\d\d-\d\d(?:-\d\d)?(?![\w-])/u;

/** A character that continues a word, for the whole-word check on names. */
const WORD_CHAR = /\w/u;

/** The one annotation whose date is machine-checked rather than left to rot. */
const VENDOR_CLAIM_TAG = '@vendor-claim';

/**
 * `text` with every line carrying {@link VENDOR_CLAIM_TAG} blanked to spaces
 * of the same length, so match indices still map onto the original comment.
 */
function blankVendorClaimLines(text) {
  if (!text.includes(VENDOR_CLAIM_TAG)) {
    return text;
  }
  return text
    .split('\n')
    .map((line) => (line.includes(VENDOR_CLAIM_TAG) ? ' '.repeat(line.length) : line))
    .join('\n');
}

/**
 * The first whole-word, case-sensitive occurrence of any of `names` in `text`,
 * as a `{ index, match }` pair, or null. A hand search rather than a built
 * RegExp so a configured name needs no escaping and the rule stays free of a
 * non-literal RegExp constructor.
 */
function findWholeWordName(text, names) {
  let best = null;
  for (const name of names) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(name, from);
      if (index === -1 || (best !== null && index >= best.index)) {
        break;
      }
      const boundedBefore = index === 0 || !WORD_CHAR.test(text[index - 1]);
      const boundedAfter = !WORD_CHAR.test(text[index + name.length] ?? '');
      if (boundedBefore && boundedAfter) {
        best = { index, match: name };
        break;
      }
      from = index + 1;
    }
  }
  return best;
}

/** Whether a linted filename is a non-test file under a `src/` directory. */
function isSourceFile(filename) {
  if (!filename) {
    return false;
  }
  // eslint-disable-next-line local/no-manual-path-normalize -- the rule pack is standalone CommonJS and cannot import the ESM helper; config paths and linted filenames are matched separator-agnostically on purpose.
  const normalized = String(filename).replaceAll('\\', '/');
  return normalized.includes('/src/') && !isTestFile(normalized);
}

/**
 * The earliest referent in `text` across the enabled classes, or null.
 * Each class contributes at most its first match; the earliest of those wins.
 */
function firstReferent(text, matchers) {
  let best = null;
  for (const { kind, find } of matchers) {
    const found = find(text);
    if (found !== null && (best === null || found.index < best.index)) {
      best = { kind, referent: found.match, index: found.index };
    }
  }
  return best;
}

/** A matcher backed by a RegExp literal. */
function regexMatcher(kind, pattern) {
  return {
    kind,
    find(text) {
      const match = pattern.exec(text);
      return match === null ? null : { index: match.index, match: match[0] };
    },
  };
}

/**
 * The source location of `index` within a comment's value, accounting for the
 * two-character opener (`//`, `/*`, `#!`) and any newlines before the match.
 */
function locationInComment(comment, index) {
  const before = comment.value.slice(0, index);
  const lastNewline = before.lastIndexOf('\n');
  const newlines = before.match(/\n/gu)?.length ?? 0;
  const line = comment.loc.start.line + newlines;
  const column = lastNewline === -1 ? comment.loc.start.column + 2 + index : index - lastNewline - 1;
  return { line, column };
}

/** Build the enabled matcher table from the rule options. */
function buildMatchers(options) {
  const matchers = [regexMatcher('an issue or PR number', ISSUE_REF)];
  if (options.allowDates !== true) {
    matchers.push(regexMatcher('a date', ISO_DATE));
  }
  const names = (options.names ?? ['Jeff']).filter((name) => name.length > 0);
  if (names.length > 0) {
    matchers.push({ kind: 'a person', find: (text) => findWholeWordName(text, names) });
  }
  return matchers;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow issue/PR numbers, ISO dates and named people in src comments — they decay in ' +
        'place; the rule belongs in the comment and the history in the commit, CHANGELOG or docs',
      recommended: false,
      recommendedSeverity: 'warn',
    },
    schema: [
      {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          allowDates: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      decayingReferent:
        'This comment cites {{kind}} ({{referent}}), which decays in place: nobody rewrites the ' +
        'comment when the issue closes, the date passes, or the person moves on. Keep the rule the ' +
        'comment states and move the history to the commit message, the CHANGELOG, or ' +
        'docs/contributing/ — `git log -L` keeps the rest.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isSourceFile(filename)) {
      return {};
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const matchers = buildMatchers(context.options?.[0] ?? {});

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          const found = firstReferent(blankVendorClaimLines(comment.value), matchers);
          if (found === null) {
            continue;
          }
          const start = locationInComment(comment, found.index);
          context.report({
            loc: { start, end: { line: start.line, column: start.column + found.referent.length } },
            messageId: 'decayingReferent',
            data: { kind: found.kind, referent: found.referent },
          });
        }
      },
    };
  },
};
