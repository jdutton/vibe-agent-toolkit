/**
 * The skills phase against the skill-text golden, in the four ways a run can
 * reach a skill's text: store off, store on and cold, store on and warm, and
 * warm with half the stored skill-text records deleted.
 *
 * `packages/agent-skills/test/fixtures/skill-text-golden/golden.json` is what
 * the skills phase reported for every skill of that corpus before its
 * detectors moved onto skill-text records: each skill's discovered name, its
 * name as `readPluginLocalSkillName` reads it, its merged packaging config,
 * `validateSkillForPackaging`'s whole result, and `validateSkill`'s (the
 * config-free lane). It is written only by `capture-skill-text-golden.ts`, on a
 * checkout of the commit it records, and this file runs the same capture
 * (`skill-text-golden-capture.ts`) on this tree. Every run here must reproduce
 * it byte for byte. The warm run must also scan no text: every SKILL.md and
 * bundled markdown file is served from the store, so `skillText.storeMiss` and
 * `content.read` do not move outside the name reads (which run with no run, so
 * they read every time). With the store off every scan is a `skillText.noStore`
 * and none a miss; with it on, none is a `skillText.noStore`. The cold runs
 * scan each markdown file of the corpus
 * exactly once: every skill's SKILL.md and every other markdown file, each
 * bundled by a skill. With half the skill-text records deleted (their keys'
 * other facts kept), each lane scans exactly the files whose record is gone,
 * plus its declared fallback, and still reproduces the golden.
 *
 * The config-free lane (`validateSkill`, which `vat audit` runs for a skill no
 * config governs) runs first and alone in a run of its own, so the run's store
 * is opened for it by the run itself, not by a phase before it. With no store it
 * scans each SKILL.md and each markdown file its links reach, once. Warm it
 * scans only its declared fallback and reads only these (a SKILL.md whose
 * frontmatter does not decode reads nothing: every refusal's wording, no block,
 * an unclosed one, an empty one, invalid YAML, not a mapping, comes from its
 * stored facts):
 *
 * - a SKILL.md whose skill directory bundles a file no link reaches: the
 *   bundled-resource check searches its text for the file's path;
 * - a linked file that is not plain UTF-8 (a BOM, UTF-16): the lane has always
 *   scanned a linked file's raw UTF-8 reading, which for such a file is not the
 *   decoded text the store's record was built from, so it reads and scans it,
 *   a counted miss.
 *
 * The scratch project lives under this package's `.test-output`, never under
 * the OS tmpdir: the skill-name check that compares a skill's name with its
 * directory is skipped under the tmpdir, and the golden pins its findings.
 */

import { readFileSync, rmSync } from 'node:fs';

import { validateSkill, validateSkillForPackaging } from '@vibe-agent-toolkit/agent-skills';
import { readWorkCounters, resolveFromImportMeta, safePath, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { discoverSkillsFromConfig, readPluginLocalSkillName } from '../../src/commands/skills/skill-discovery.js';
import { buildSharedValidationContext } from '../../src/commands/skills/validate.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { createLogger } from '../../src/utils/logger.js';
import { withRunContext } from '../../src/utils/resource-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../src/utils/skill-packaging-config.js';
import { evictHalfTheSkillText, storedContentKeys } from '../helpers/cache-differential.js';
import { captureSkillTextGolden, type Counters, type GoldenCapture, type SkillsLane, type SkillsLaneRun } from '../helpers/skill-text-golden-capture.js';
import { skillLaneScannedFiles, SKILL_TEXT_GOLDEN_DIR, writeSkillTextGoldenProject } from '../helpers/skill-text-golden.js';

const PACKAGE_DIR = resolveFromImportMeta(import.meta.url, '..', '..');
const GOLDEN = readFileSync(safePath.join(SKILL_TEXT_GOLDEN_DIR, 'golden.json'), 'utf8');

/** The golden's config-free results, as the capture recorded them. */
interface ConfigFreeEntry {
  readonly dir: string;
  readonly result: { readonly issues: ReadonlyArray<{ readonly code: string }>; readonly linkedFiles?: ReadonlyArray<{ readonly path: string }> };
}

const PARSED = JSON.parse(GOLDEN) as { capturedFrom: string; configFree: ConfigFreeEntry[] };
/** The commit the golden was captured from, as the capture recorded it. */
const CAPTURED_FROM = PARSED.capturedFrom;

/** The corpus skills whose frontmatter does not decode, as the golden records them: each one's refusal is worded warm without a read. */
const UNDECODED_FRONTMATTER = PARSED.configFree.filter(({ result }) => result.issues.some((issue) => issue.code === 'SKILL_MISSING_FRONTMATTER')).length;

/**
 * The corpus skills whose directory bundles a file no link reaches, each of whose
 * SKILL.md the warm config-free lane reads once for the bundled-resource check.
 * Declared by the corpus: these are its skills with a `references/`, `scripts/` or
 * `assets/` file outside every link.
 */
const BUNDLED_UNLINKED = ['bundled-mention', 'bundled-mention-utf16'] as const;

/**
 * The corpus's linked files that are not plain UTF-8, each of which the config-free
 * lane reads raw and scans whether or not the store holds it. Declared by the corpus.
 */
const NOT_PLAIN_UTF8_LINKED = ['linked-bom/references/guide.md', 'linked-utf16/references/guide.md'] as const;

/** Counters a run's text work moves. */
const TEXT_COUNTERS = ['skillText.storeMiss', 'skillText.noStore', 'content.read', 'parse.dispatched'] as const satisfies readonly WorkCounter[];

/** The text counters a capture's run moved. */
function textWork(moved: Counters): Record<(typeof TEXT_COUNTERS)[number], number | undefined> {
  return Object.fromEntries(TEXT_COUNTERS.map((name) => [name, moved[name]])) as Record<(typeof TEXT_COUNTERS)[number], number | undefined>;
}

/**
 * The files the config-free lane scans with no store, from the golden: each
 * SKILL.md, and each distinct markdown file a skill's links reach.
 */
function configFreeScanned(): Set<string> {
  const files = new Set<string>();
  for (const { dir, result } of PARSED.configFree) {
    files.add(`${dir}/SKILL.md`);
    for (const linked of result.linkedFiles ?? []) files.add(linked.path);
  }
  return files;
}

/** The capture's listed skills, as the shared validation context takes them. */
function validatedSkillsOf(listed: Parameters<SkillsLaneRun['sharedContext']>[0]): Parameters<typeof buildSharedValidationContext>[0] {
  return listed.map((skill) => ({ name: skill.discoveredName ?? '', sourcePath: skill.sourcePath, packagingConfig: skill.packagingConfig as never }));
}

/** This tree's skills lane over `root`. */
function thisTree(root: string): SkillsLane {
  const config = loadConfig(root, 'source');
  const skillsConfig = config?.skills;
  if (config === undefined || skillsConfig === undefined) throw new Error('the capture config has no skills block');
  const logger = createLogger();
  const { defaults, config: perSkill } = skillsConfig;
  return {
    root,
    withRun: (work) => withRunContext({ projectionStore: 'on-demand', root, outputs: [] }, (run) => work({
      discover: () => discoverSkillsFromConfig(skillsConfig, root, 'refuse', run.population),
      sharedContext: (listed, discovered) => buildSharedValidationContext(
        validatedSkillsOf(listed),
        collectDeclaredEvalSuites(skillsConfig, discovered as never),
        config,
        logger,
        run,
      ),
      validateForPackaging: (skill, context) =>
        validateSkillForPackaging(skill.sourcePath, config.resources?.validation ?? {}, skill.packagingConfig as never, 'source', context as never),
      validateConfigFree: (skillPath) => validateSkill({
        skillPath, locationRoot: root, validation: {}, resourcesValidation: {}, side: 'source', run: run.population,
      }),
    })),
    packagingConfigOf: (name) => mergeSkillPackagingConfig(defaults, name === undefined ? undefined : perSkill?.[name]),
    readSkillName: (skillDir) => readPluginLocalSkillName(skillDir, undefined),
    readCounters: readWorkCounters,
  };
}

describe('the skills phase reproduces the skill-text golden', () => {
  const scratch = safePath.join(PACKAGE_DIR, '.test-output', 'integration', `skill-text-golden-${process.pid}-${Date.now()}`);
  const cacheDir = safePath.join(scratch, 'cache');
  let root = '';

  beforeAll(() => {
    root = writeSkillTextGoldenProject(safePath.join(scratch, 'project'));
    vi.stubEnv('VAT_CACHE_DIR', cacheDir);
  });

  /** One capture of this tree, over the scratch project. */
  const capture = (): Promise<GoldenCapture> => captureSkillTextGolden(thisTree(root), [root, scratch], CAPTURED_FROM);

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('with the projection store off: every file each lane reads is scanned from its text once, with no store to miss', async () => {
    vi.stubEnv('VAT_PROJECTION_STORE', 'off');
    const { text, packagingMoved, configFreeMoved } = await capture();
    expect(text).toBe(GOLDEN);
    expect([packagingMoved['skillText.noStore'], packagingMoved['skillText.storeMiss']]).toEqual([skillLaneScannedFiles(root).length, 0]);
    expect([configFreeMoved['skillText.noStore'], configFreeMoved['skillText.storeMiss']]).toEqual([configFreeScanned().size, 0]);
  });

  it('with the store on, cold: every file the packaging lane reads scanned from its text once', async () => {
    vi.stubEnv('VAT_PROJECTION_STORE', 'sqlite');
    const { text, packagingMoved } = await capture();
    expect(text).toBe(GOLDEN);
    expect([packagingMoved['skillText.storeMiss'], packagingMoved['skillText.noStore']]).toEqual([skillLaneScannedFiles(root).length, 0]);
  });

  it('with the store on, warm: served from the store but the declared fallback', async () => {
    vi.stubEnv('VAT_PROJECTION_STORE', 'sqlite');
    const { text, packagingMoved, configFreeMoved } = await capture();
    expect(text).toBe(GOLDEN);
    expect(textWork(packagingMoved)).toEqual({ 'skillText.storeMiss': 0, 'skillText.noStore': 0, 'content.read': 0, 'parse.dispatched': 0 });
    expect(UNDECODED_FRONTMATTER).toBeGreaterThan(0);
    expect(textWork(configFreeMoved)).toEqual({
      'skillText.storeMiss': NOT_PLAIN_UTF8_LINKED.length,
      'skillText.noStore': 0,
      'content.read': BUNDLED_UNLINKED.length + NOT_PLAIN_UTF8_LINKED.length,
      'parse.dispatched': 0,
    });
  });

  it('with half the skill-text records deleted: scans exactly the files whose record is gone, and the declared fallback', async () => {
    // A store of its own, warmed here, so the case stands alone: it never leans on the runs above.
    const store = safePath.join(scratch, 'evicted-cache');
    vi.stubEnv('VAT_CACHE_DIR', store);
    vi.stubEnv('VAT_PROJECTION_STORE', 'sqlite');
    expect((await capture()).text).toBe(GOLDEN);
    const keyOf = storedContentKeys({ store });
    const evicted = new Set(evictHalfTheSkillText({ store }, []));
    const recordGone = (path: string): boolean => {
      const key = keyOf.get(path);
      if (key === undefined) throw new Error(`the store keyed no ${path}`);
      return evicted.has(key);
    };
    const packagingScans = skillLaneScannedFiles(root).filter((path) => recordGone(path));
    const configFreeEvicted = [...configFreeScanned()].filter((path) => recordGone(path));
    const configFreeScans = new Set([...configFreeEvicted, ...NOT_PLAIN_UTF8_LINKED]);
    // Non-vacuous both ways, in each lane: some scanned file lost its record, and some kept it.
    expect(packagingScans.length).toBeGreaterThan(0);
    expect(packagingScans.length).toBeLessThan(skillLaneScannedFiles(root).length);
    expect(configFreeEvicted.length).toBeGreaterThan(0);
    expect(configFreeEvicted.length).toBeLessThan(configFreeScanned().size);

    const { text, packagingMoved, configFreeMoved } = await capture();
    expect(text).toBe(GOLDEN);
    expect(packagingMoved['skillText.storeMiss']).toBe(packagingScans.length);
    expect(configFreeMoved['skillText.storeMiss']).toBe(configFreeScans.size);
  });
});
