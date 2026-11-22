/**
 * A markdown document whose skill-text record is one match past the bound the
 * caches hold (`SKILL_TEXT_HELD_LIMITS.matches`), and nothing else near any
 * parse cap: frontmatter (the imperative family scans the body after it), one
 * heading, one link and one second-person opener per body line.
 */

import { SKILL_TEXT_HELD_LIMITS } from '../../src/parse-limits.js';

/** Body lines, each one imperative-family match. */
export const PAST_BOUND_MATCHES = SKILL_TEXT_HELD_LIMITS.matches + 1;

/** The document: its record has {@link PAST_BOUND_MATCHES} matches. */
export const PAST_BOUND_TEXT = `---\nname: big\n---\n# Big\n\nSee [a](./a.md).\n\n${'You should x.\n'.repeat(PAST_BOUND_MATCHES)}`;
