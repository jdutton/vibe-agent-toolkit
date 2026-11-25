/**
 * Where a skill document's frontmatter block is: the ONE fence rule, which both
 * the skill frontmatter parser (`parseFrontmatter` in agent-skills) and the
 * skill-text core's body families apply, so the body a record is counted in is
 * the body the parser returns. The rule's constants (BOM, line ending, fence)
 * are `SKILL_TEXT_DECLARATION.body`, so its digest moves when the rule does.
 *
 * Held to the same purity rule as the core: every constant comes from the
 * declaration.
 */

import type { SkillTextDeclaration } from './declaration.js';

/** A document split into lines, and where its frontmatter fences are. */
export interface FrontmatterFences {
  /** The text with one leading BOM dropped, split on `\r\n`, a lone `\r` or `\n`. */
  lines: string[];
  /** Whether the first line is a fence. */
  opened: boolean;
  /** The index in {@link lines} of the first fence after the opening one; -1 when there is none or no opening. */
  closing: number;
}

/**
 * Split `text` into lines and find its frontmatter fences, as the markdown
 * parser's frontmatter extension does: a leading BOM is dropped, `\r\n` and a
 * lone `\r` are each one line ending, the first line must be a fence, and the
 * block ends at the next fence line.
 *
 * @param text - The document as read
 * @param declaration - The skill-text declaration whose `body` section holds the rule's constants
 * @returns The lines, whether the first is a fence, and the closing fence's index or -1
 */
export function frontmatterFencesOf(text: string, declaration: SkillTextDeclaration): FrontmatterFences {
  const { body } = declaration;
  const unmarked = text.startsWith(body.bom) ? text.slice(body.bom.length) : text;
  const lines = unmarked.split(body.lineEnding);
  const opened = body.fence.test(lines[0] ?? '');
  const closing = opened ? lines.findIndex((line, index) => index > 0 && body.fence.test(line)) : -1;
  return { lines, opened, closing };
}
