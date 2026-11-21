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

import { safePath, toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils';

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

/** A drive-letter prefix (`C:`), whose case a Windows path may spell either way. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Every spelling a root can take in a captured value, longest first so a root
 * beneath another (the project under its scratch parent) is stripped whole.
 *
 * On Windows the project root comes from `mkdirSyncReal` with backslashes while
 * every producer joins forward slashes onto it, and a drive letter can reach a
 * producer in either case; so each root is spelled with either separator and,
 * when it has one, either drive-letter case. Lexical, so it holds on every host.
 */
function rootSpellings(roots: readonly string[]): string[] {
  const spellings = new Set<string>();
  for (const root of roots) {
    const forward = toForwardSlashAnyPlatform(root);
    for (const separated of [forward, forward.split('/').join('\\')]) {
      spellings.add(separated);
      if (DRIVE_LETTER.test(separated)) {
        spellings.add(separated.charAt(0).toUpperCase() + separated.slice(1));
        spellings.add(separated.charAt(0).toLowerCase() + separated.slice(1));
      }
    }
  }
  return [...spellings].sort((a, b) => b.length - a.length);
}

/**
 * `text` with every root spelling made relative: `<root>/x` and `<root>\x` become
 * `x`, the bare root `.`. Only the root is rewritten; a native separator after it
 * is kept, so a producer that emits one still fails the golden.
 */
function relativized(text: string, spellings: readonly string[]): string {
  let out = text;
  for (const root of spellings) out = out.replaceAll(`${root}/`, '').replaceAll(`${root}\\`, '').replaceAll(root, '.');
  return out;
}

/**
 * `value` as JSON reads it, with every root made relative in every string and
 * key, as the golden holds paths. Each string is rewritten as a value, never as
 * JSON text, so a backslash path (escaped `\\` in JSON) is matched as written.
 *
 * @param value - What a run reported
 * @param roots - Every root to make relative, in any spelling
 * @returns The value, scrubbed
 */
export function scrubbed(value: unknown, roots: readonly string[]): unknown {
  const spellings = rootSpellings(roots);
  // The replacer sees each value as JSON will write it (after `toJSON`), and then each child of what it returns.
  const text = JSON.stringify(value, (_key, node: unknown) => {
    if (typeof node === 'string') return relativized(node, spellings);
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [relativized(key, spellings), child]));
    }
    return node;
  });
  return JSON.parse(text) as unknown;
}

/**
 * The first line where `received` and `expected` differ, named with its number
 * and both sides, or `undefined` when they are the same text. A golden mismatch
 * leads with it, so a truncated CI message still shows where the capture went
 * wrong.
 *
 * @param received - The capture's text
 * @param expected - The golden's text
 * @returns The difference, or `undefined`
 */
export function firstDifferingLine(received: string, expected: string): string | undefined {
  const got = received.split('\n');
  const want = expected.split('\n');
  const spell = (line: string | undefined): string => (line === undefined ? '(no line)' : JSON.stringify(line));
  for (let index = 0; index < Math.max(got.length, want.length); index += 1) {
    if (got[index] !== want[index]) return `golden line ${index + 1} differs: expected ${spell(want[index])} but received ${spell(got[index])}`;
  }
  return undefined;
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
