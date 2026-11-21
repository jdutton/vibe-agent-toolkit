/**
 * The `mcp__<server>__<tool>` scanner the skill-text core finds Claude Code
 * qualified MCP tool names with, in place of a regex that is quadratic.
 *
 * Held to the same purity as the core (`local/skill-text-core-purity`): every
 * character class and literal comes from the declaration passed in.
 */

import type { SkillTextDeclaration } from './declaration.js';

/**
 * Every `mcp__<server>__<tool>` in `text`: exactly what
 * `/\bmcp__[\w-]+?__([a-z][A-Za-z0-9_-]*)(?![\w-])/gu` captures, in linear
 * time. That regex is quadratic on `"mcp__-".repeat(n)`: every `mcp__` start
 * rescans the rest of its name run looking for `__[a-z]`.
 *
 * The regex's match, read off: at a `\bmcp__` start, the server half runs to
 * the FIRST `__[a-z]` after its first character inside the same `[\w-]` run,
 * and the tool half (greedy, then not followed by a name character) runs to the
 * end of that run. So two right-to-left passes precompute, per position, where
 * its name run ends and where the next `__[a-z]` is; each start is then decided
 * in constant time, and a match resumes after its run as `matchAll` does.
 *
 * @returns `captures`, the tool half of each match in text order; and `steps`,
 *   the work done (one per position each pass visits), at most three per
 *   character, which is what proves the scan linear
 */
export function scanClaudeCodeQualified(
  text: string,
  declaration: SkillTextDeclaration,
): { captures: string[]; steps: number } {
  const { prefix, separator, wordChar, nameChar, toolStart } = declaration.mcp;
  const length = text.length;
  const runEnd = rightToLeft(length, (index, next) => (nameChar.test(text.charAt(index)) ? next : index));
  const nextToolSeparator = rightToLeft(length, (index, next) =>
    text.startsWith(separator, index) && toolStart.test(text.charAt(index + separator.length)) ? index : next,
  );
  let steps = runEnd.steps + nextToolSeparator.steps;

  /** The end of the match a `\bmcp__` at `start` opens, or `undefined` when it opens none. */
  const matchEndAt = (start: number): { tool: number; end: number } | undefined => {
    if (!text.startsWith(prefix, start) || (start > 0 && wordChar.test(text.charAt(start - 1)))) return undefined;
    const server = start + prefix.length;
    const end = runEnd.at(server);
    const tool = nextToolSeparator.at(server + 1) + separator.length;
    return end > server && tool < end ? { tool, end } : undefined;
  };

  const captures: string[] = [];
  let index = 0;
  while (index < length) {
    steps++;
    const match = matchEndAt(index);
    if (match === undefined) {
      index++;
    } else {
      captures.push(text.slice(match.tool, match.end));
      index = match.end;
    }
  }
  return { captures, steps };
}

/** A right-to-left pass over positions `0..length`, each value computed from its successor's. */
interface Pass {
  /** The value at `index`; `length` past the end. */
  at(index: number): number;
  steps: number;
}

/**
 * One right-to-left pass: position `length` holds `length`, and each earlier
 * position `value(index, valueAt(index + 1))`. One step per position.
 */
function rightToLeft(length: number, value: (index: number, next: number) => number): Pass {
  const values = new Int32Array(length + 1);
  values[length] = length;
  let steps = 0;
  for (let index = length - 1; index >= 0; index--) {
    steps++;
    values[index] = value(index, values[index + 1] ?? length);
  }
  return { at: (index) => (index <= length ? (values[index] ?? length) : length), steps };
}
