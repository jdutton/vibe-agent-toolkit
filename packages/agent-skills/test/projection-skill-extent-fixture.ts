/**
 * The skill-extent fixture's coordinates, shared by the pure translation tests
 * (`projection-skill-extent.test.ts`) and the on-disk experiment
 * (`integration/projection-skill-extent.integration.test.ts`).
 */

import type { SkillPackagingConfig } from '@vibe-agent-toolkit/resources';

/** The skill under test, as `resource_realizations.path` spells it. */
export const SKILL_REL = 'skills/tool-a/SKILL.md';

/** The skill's name — the extent's within-root discriminator. */
export const SKILL_NAME = 'tool-a';

export const GUIDE_REL = 'docs/guide.md';
export const HELPER_REL = 'skills/shared/helper.mjs';
export const CHAIN_REL = 'docs/chain.md';
/** Parses as markdown, is not a `**\/*.md` registry member — cargo to the build. */
export const TXT_REL = 'skills/tool-a/notes.txt';
/** Reachable only through {@link TXT_REL}. */
export const BEHIND_TXT_REL = 'skills/tool-a/behind-txt.md';
export const README_REL = 'docs/README.md';
export const CLAUDE_REL = 'CLAUDE.md';
export const SIBLING_SKILL_REL = 'skills/tool-b/SKILL.md';

/** An explicit, non-glob `files:` source naming an agent-instruction file. */
export const DECLARED_CLAUDE_SOURCE = 'notes/CLAUDE.md';
export const DOCS_DIR_REL = 'docs';
export const CONFIG_ASSET_REL = 'templates/config.json';

/** The packager's own default when `linkFollowDepth` is absent (skill-packager.ts:580). */
export const DEFAULT_DEPTH = 2;

/** A config declaring nothing: the defaults path, and the packager's own. */
export const DEFAULT_CONFIG: SkillPackagingConfig = {};
