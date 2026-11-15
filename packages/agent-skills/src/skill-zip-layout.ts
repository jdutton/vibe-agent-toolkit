/**
 * The ONE rule for where a skill ZIP keeps its `SKILL.md`, for every verb that takes one
 * (`vat skills install`, `vat claude plugin install`, `vat claude org skills install`).
 *
 * A skill ZIP is one of two shapes, and nothing else:
 * - `SKILL.md` at the archive's top level (the contents of a skill folder, zipped); or
 * - exactly one top-level folder with `SKILL.md` directly inside it (the folder itself, zipped —
 *   what "Compress" in Finder and "Send to → Compressed folder" in Explorer make).
 *
 * Decided from the entry list alone, so a verb that extracts and a verb that uploads agree. Pure.
 */

import { archiveEntryPlace } from '@vibe-agent-toolkit/utils';

/** As much of an archive entry as the rule reads. */
export interface SkillZipEntry {
  /** The entry's name, as the archive spells it. */
  readonly name: string;
  /** `file`, `directory`, or anything else an archive may hold. */
  readonly kind: string;
}

/**
 * Where the skill is inside the archive — `root` is `''` for the top level, or the one top-level
 * folder's name — or why the archive is not a skill ZIP.
 */
export type SkillZipLayout = { readonly root: string } | { readonly refused: string };

const SKILL_MD = 'SKILL.md';

/** What macOS adds beside a folder it compresses: never an entry of the skill, never counted as one. */
const HOST_ADDED_AT_TOP_LEVEL: ReadonlySet<string> = new Set(['__MACOSX', '.DS_Store']);

/**
 * Whether an entry of a skill ZIP is something the host that made the archive added beside the
 * skill — the top-level `__MACOSX/` folder (and everything in it) or a top-level `.DS_Store`.
 * THE one answer: the layout rule does not count such an entry, an install does not extract it,
 * and an upload does not send it.
 *
 * @param entryName - The entry's name, as the archive spells it
 */
export function hostAddedToSkillZip(entryName: string): boolean {
  const [top] = archiveEntryPlace(entryName);
  return top !== undefined && HOST_ADDED_AT_TOP_LEVEL.has(top);
}

const THE_RULE = `A skill ZIP holds ${SKILL_MD} at its top level, or exactly one top-level folder with ${SKILL_MD} directly inside it`;

/** Why an archive that is neither shape is refused, naming the nearest `SKILL.md` it does hold. */
function refusal(tops: ReadonlySet<string>, skillFiles: ReadonlyArray<readonly string[]>): string {
  const oneDown = skillFiles.find((place) => place.length === 2);
  if (oneDown !== undefined) {
    const others = [...tops].filter((top) => top !== oneDown[0]);
    return `its \`${oneDown.join('/')}\` sits beside other top-level entries (${others.join(', ')}). ${THE_RULE}`;
  }
  const [deeper] = skillFiles;
  const nearest = deeper === undefined ? '' : ` (the nearest is \`${deeper.join('/')}\`)`;
  return `it holds no ${SKILL_MD} at its top level, nor directly inside a single top-level folder${nearest}. ${THE_RULE}`;
}

/**
 * Decide the layout of a skill ZIP from its entries.
 *
 * @param entries - Every entry of the archive, as the archive spells it
 * @returns The folder the skill is in (`''`: the top level), or the reason the archive is refused —
 *   a sentence fragment that follows "<archive> is not a skill ZIP: "
 */
export function skillZipLayout(entries: readonly SkillZipEntry[]): SkillZipLayout {
  const placed = entries
    .filter((entry) => !hostAddedToSkillZip(entry.name))
    .map((entry) => ({ place: archiveEntryPlace(entry.name), kind: entry.kind }))
    .filter(({ place }) => place.length > 0);
  const skillFiles = placed
    .filter(({ place, kind }) => kind === 'file' && place.at(-1) === SKILL_MD)
    .map(({ place }) => place)
    .sort((a, b) => a.length - b.length);
  if (skillFiles.some((place) => place.length === 1)) return { root: '' };
  const tops = new Set(placed.map(({ place }) => place[0] ?? ''));
  const [only] = tops;
  if (tops.size === 1 && only !== undefined && skillFiles.some((place) => place.length === 2)) return { root: only };
  return { refused: refusal(tops, skillFiles) };
}
