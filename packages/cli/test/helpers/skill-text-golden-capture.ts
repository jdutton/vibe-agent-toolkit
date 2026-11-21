/**
 * The skill-text golden's capture: what the skills phase reports for every skill
 * of the corpus (`packages/agent-skills/test/fixtures/skill-text-golden`), as the
 * document `golden.json` holds.
 *
 * One capture, two callers. `capture-skill-text-golden.ts` runs it on a checkout
 * of the commit the golden pins and is the only writer of `golden.json`; the
 * golden test runs it on this tree and compares. Each hands it the calls in its
 * own tree's signatures (a {@link SkillsLane}), so the two cannot capture
 * different things.
 *
 * In order, each in a run of its own: discovery the way `vat skills validate`
 * runs it, the shared context and `validateSkillForPackaging` for every skill
 * directory; then each skill's name as `readPluginLocalSkillName` reads it with
 * no run; then `validateSkill` (the config-free lane `vat audit` runs for a
 * skill no config governs) for every skill directory, as the run's first and
 * only work.
 */

import { existsSync, readdirSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** Work counters by name: a tree's own `readWorkCounters()`, or none for a tree whose counters the caller cannot read. */
export type Counters = Readonly<Record<string, number>>;

/** A skill discovery found. */
interface DiscoveredSkill {
  readonly sourcePath: string;
  readonly name: string;
}

/** A skill as the capture validates it for packaging. */
interface ListedSkill {
  readonly dir: string;
  readonly sourcePath: string;
  readonly discoveredName: string | undefined;
  readonly packagingConfig: unknown;
}

/** One run's calls, in a tree's own signatures. */
export interface SkillsLaneRun {
  discover(): Promise<{ readonly skills: readonly DiscoveredSkill[]; readonly parseRefused: unknown }>;
  sharedContext(listed: readonly ListedSkill[], discovered: readonly DiscoveredSkill[]): Promise<unknown>;
  validateForPackaging(skill: ListedSkill, context: unknown): Promise<unknown>;
  validateConfigFree(skillPath: string): Promise<unknown>;
}

/** A tree's skills lane over one project root. */
export interface SkillsLane {
  readonly root: string;
  withRun<T>(work: (run: SkillsLaneRun) => Promise<T>): Promise<T>;
  packagingConfigOf(name: string | undefined): unknown;
  readSkillName(skillDir: string): Promise<unknown>;
  readCounters(): Counters;
}

/** A capture: the golden document's text, and what each counter moved in each of its two measured runs. */
export interface GoldenCapture {
  readonly text: string;
  readonly packagingMoved: Counters;
  readonly configFreeMoved: Counters;
}

/**
 * Every top-level name of a corpus holding a SKILL.md, sorted.
 *
 * @param root - The corpus
 * @returns The skill directories
 */
export function skillDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => existsSync(safePath.join(root, name, 'SKILL.md')))
    .sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** Each counter's movement from `before` to `after`. */
function movedBetween(before: Counters, after: Counters): Counters {
  return Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - (before[name] ?? 0)]));
}

/** `value`, serialized, with every root made relative, as the golden holds paths. */
function scrubbed(value: unknown, roots: readonly string[]): unknown {
  let text = JSON.stringify(value);
  for (const root of new Set(roots)) text = text.replaceAll(`${root}/`, '').replaceAll(root, '.');
  return JSON.parse(text) as unknown;
}

/**
 * Capture the golden document over `lane.root`.
 *
 * @param lane - The tree's calls
 * @param roots - Every spelling of the project root to make relative (the root, its scratch parent)
 * @param capturedFrom - The commit the document records it was captured from
 * @returns The capture
 */
export async function captureSkillTextGolden(lane: SkillsLane, roots: readonly string[], capturedFrom: string): Promise<GoldenCapture> {
  const { root } = lane;
  const dirs = skillDirs(root);

  const before = lane.readCounters();
  const packaged = await lane.withRun(async (run) => {
    const discovery = await run.discover();
    const byPath = new Map(discovery.skills.map((skill) => [skill.sourcePath, skill.name]));
    const listed = dirs.map((dir): ListedSkill => {
      const sourcePath = safePath.join(root, dir, 'SKILL.md');
      const discoveredName = byPath.get(sourcePath);
      return { dir, sourcePath, discoveredName, packagingConfig: lane.packagingConfigOf(discoveredName) };
    });
    const context = await run.sharedContext(listed, discovery.skills);
    const results: unknown[] = [];
    // One skill at a time, as the verb does: the run's counters and caches are shared.
    // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
    for (const skill of listed) results.push(await run.validateForPackaging(skill, context));
    return { discovery, listed, results };
  });
  const packagingMoved = movedBetween(before, lane.readCounters());

  const skills = [];
  for (const [index, skill] of packaged.listed.entries()) {
    skills.push({
      dir: skill.dir,
      discoveredName: skill.discoveredName ?? null,
      // eslint-disable-next-line no-await-in-loop -- one name read at a time, after the packaging run, in golden order
      readSkillName: await lane.readSkillName(safePath.join(root, skill.dir)),
      packagingConfig: skill.packagingConfig,
      result: packaged.results[index],
    });
  }

  const configFreeBefore = lane.readCounters();
  const configFree = await lane.withRun(async (run) => {
    const results = [];
    // eslint-disable-next-line no-await-in-loop -- one skill at a time in one run, as the packaging run above
    for (const dir of dirs) results.push({ dir, result: await run.validateConfigFree(safePath.join(root, dir, 'SKILL.md')) });
    return results;
  });
  const configFreeMoved = movedBetween(configFreeBefore, lane.readCounters());

  const doc = {
    capturedFrom,
    skills: scrubbed(skills, roots),
    discoveryParseRefused: scrubbed(packaged.discovery.parseRefused, roots),
    configFree: scrubbed(configFree, roots),
  };
  return { text: `${JSON.stringify(doc, null, 2)}\n`, packagingMoved, configFreeMoved };
}
