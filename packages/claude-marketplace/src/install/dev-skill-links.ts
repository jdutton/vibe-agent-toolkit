/**
 * The one place a `--dev` plugin install (`vat claude plugin install --dev`) makes links: each
 * built skill linked into the plugin tree being staged, so a rebuild is picked up live.
 */

import fs from 'node:fs/promises';

import { forEachInOrder, safePath } from '@vibe-agent-toolkit/utils';

/** One `--dev` skill link: its name under the plugin's `skills/`, and the build it points at. */
export interface DevSkillLink {
  readonly name: string;
  readonly target: string;
}

/**
 * Make `<into>/skills/` and, in it, a directory link per built skill, in order (the first refusal
 * stops the fill). The `--dev` lane is refused on win32 before anything is planned, so these are
 * POSIX directory links; a refused one is a raw errno — `into` is inside a staged tree, so the
 * tree-change applier classifies it `destination` with every other write there.
 *
 * @param into - The plugin directory being filled, inside a staged tree
 * @param links - The links to make
 */
export async function linkDevSkills(into: string, links: readonly DevSkillLink[]): Promise<void> {
  const skillsDir = safePath.join(into, 'skills');
  // Plain, not recursive: `into` is the copy just made, and nothing may stand at `skills` in it — the
  // copy leaves that name out. A recursive `mkdir` would adopt a link there and link through it.
  await fs.mkdir(skillsDir);
  await forEachInOrder(links, ({ name, target }) => fs.symlink(target, safePath.join(skillsDir, name), 'dir'));
}
