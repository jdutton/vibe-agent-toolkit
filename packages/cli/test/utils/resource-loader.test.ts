import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Shape returned by `importOriginal` — spread-only, so the keys stay opaque. */
type OriginalModule = Record<string, unknown>;

/**
 * Synthetic absolute paths, resolved rather than written as literals.
 *
 * The code under test resolves its path argument with `safePath.resolve`, and on
 * Windows that prepends the cwd's drive letter — `/project` becomes `D:/project`.
 * A literal constant does not, so the literal and the resolved form disagree, and
 * `safePath.relative` between a driveless and a drive-qualified path returns a
 * drive-absolute string instead of a subtree-relative one. Resolving here puts
 * both sides of every comparison on the same footing on every platform; on POSIX
 * `resolve` is the identity for these inputs, so the values are unchanged.
 */
const PROJECT_ROOT = safePath.resolve('/project');
const SUBTREE_PATH = safePath.resolve('/project/docs/guides');
const EXPLICIT_PATH = safePath.resolve('/explicit/path');
const MISSING_PATH = safePath.resolve('/project/docs/missing');
const INCLUDE_PATTERNS = ['docs/**/*.md'];
const EXCLUDE_PATTERNS = ['**/draft.md'];

/**
 * The subtree-scoped form of {@link DEFAULT_RESOURCE_INCLUDE} for SUBTREE_PATH.
 * Written out literally so the test states the expected globs rather than
 * re-deriving them with the same code under test.
 */
const SUBTREE_INCLUDE = [
  'docs/guides/**/*.md',
  'docs/guides/**/*.html',
  'docs/guides/**/*.htm',
];

const loadConfigMock = vi.fn();
const gitTrackerInitializeMock = vi.fn();
const gitTrackerGetStatsMock = vi.fn();
const registryCrawlMock = vi.fn();
const buildResourcePopulationMock = vi.fn();
/** Absolute paths the fake fs reports as existing directories. */
const existingDirectories = new Set<string>();
let lastRegistryOptions: Record<string, unknown> | undefined;
let lastCrawlOptions: Record<string, unknown> | undefined;

/**
 * The crawl options minus the population source.
 *
 * The tests below are about which include/exclude patterns a path argument
 * produces, and the projection lane — now the DEFAULT — installs a
 * `populationSource` alongside them. Stripping exactly that one key keeps these
 * assertions on their own subject while preserving `toEqual`'s guarantee that no
 * OTHER stray key crept in, which `objectContaining` would quietly give up.
 *
 * @returns The recorded options without `populationSource`, or `undefined`
 */
function crawlPatterns(): Record<string, unknown> | undefined {
  if (lastCrawlOptions === undefined) return undefined;
  const rest = { ...lastCrawlOptions };
  delete rest.populationSource;
  return rest;
}

vi.mock('node:fs', () => {
  const directory = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fake = {
    existsSync: (p: string): boolean => existingDirectories.has(p),
    statSync: (p: string): { isDirectory: () => boolean } => ({
      isDirectory: () => existingDirectories.has(p),
    }),
    // The link-chain walk root discovery probes `.git` by: `lstat` answers from the same staged directories.
    lstatSync: (p: string): typeof directory => {
      if (existingDirectories.has(p)) return directory;
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), { code: 'ENOENT', syscall: 'lstat', path: p });
    },
  };
  // utils' link-following reaches the kernel through the DEFAULT object, so it is faked too.
  return { ...fake, default: fake };
});

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => ({
  ...(await importOriginal<OriginalModule>()),
  buildResourcePopulation: (options: unknown): unknown => buildResourcePopulationMock(options),
  ResourceRegistry: class {
    constructor(options: Record<string, unknown>) {
      lastRegistryOptions = options;
    }
    async crawl(options: Record<string, unknown>): Promise<void> {
      lastCrawlOptions = options;
      await registryCrawlMock(options);
    }
  },
}));

vi.mock('../../src/utils/config-loader.js', () => ({
  loadConfig: (projectRoot: string): unknown => loadConfigMock(projectRoot),
  // Read by `collectionsOption` when a faked crawl drives the source's `enumerate`.
  loadConfigCached: (projectRoot: string): unknown => loadConfigMock(projectRoot),
}));

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => ({
  ...(await importOriginal<OriginalModule>()),
  GitTracker: class {
    async initialize(): Promise<void> {
      await gitTrackerInitializeMock();
    }
    getStats(): { cacheSize: number } {
      return gitTrackerGetStatsMock();
    }
  },
}));

// eslint-disable-next-line import/first -- must come after vi.mock calls
import type { Logger } from '../../src/utils/logger.js';
// eslint-disable-next-line import/first -- must come after vi.mock calls
import {
  loadResourcesWithConfig,
  RESOURCES_CRAWL_ENV,
  RESOURCES_CRAWL_PROJECTION,
  RESOURCES_CRAWL_WALK,
  type PopulationObservation,
} from '../../src/utils/resource-loader.js';

/** For the cases about something other than provenance. */
const IGNORE_POPULATION = (): void => undefined;

const HIT = { population: 'store', stored: 'hit' } as const;
const WRITTEN = { population: 'derived', stored: 'written' } as const;

/** The source the loader installed on the crawl, refused when it installed none. */
interface InstalledSource {
  enumerate: (root: string, outputs: readonly string[]) => Promise<unknown>;
  decline: (offeredRoot: string) => void;
}

/**
 * Make the faked crawl drive the installed source the way the registry would.
 *
 * @param drive - What the crawl does with the source it was handed
 */
function crawlDrives(drive: (source: InstalledSource) => Promise<void> | void): void {
  registryCrawlMock.mockImplementation(async (options: { populationSource?: InstalledSource }) => {
    if (options.populationSource === undefined) throw new Error('no population source was installed');
    await drive(options.populationSource);
  });
}

function createTestLogger(): { logger: Logger; debugCalls: string[]; warnCalls: string[] } {
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (msg: string) => {
      warnCalls.push(msg);
    },
    error: () => undefined,
    debug: (msg: string) => {
      debugCalls.push(msg);
    },
  };
  return { logger, debugCalls, warnCalls };
}

/**
 * Load once with no config, recording every observation.
 *
 * @returns Every observation the load made
 */
async function observedLoad(): Promise<PopulationObservation[]> {
  loadConfigMock.mockReturnValue(undefined);
  const { logger } = createTestLogger();
  const observed: PopulationObservation[] = [];
  await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, (observation) => {
    observed.push(observation);
  });
  return observed;
}

describe('loadResourcesWithConfig', () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    gitTrackerInitializeMock.mockReset();
    gitTrackerGetStatsMock.mockReset();
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 0 });
    registryCrawlMock.mockReset();
    existingDirectories.clear();
    existingDirectories.add(PROJECT_ROOT);
    existingDirectories.add(SUBTREE_PATH);
    lastRegistryOptions = undefined;
    lastCrawlOptions = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses projectRoot as baseDir and applies config patterns when no pathArg', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse',
      outputs: [],
      include: INCLUDE_PATTERNS,
      exclude: EXCLUDE_PATTERNS,
    });
    expect(result.scanPath).toBe(PROJECT_ROOT);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('keeps config exclude patterns and scopes include to the subtree when pathArg is inside the project', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(SUBTREE_PATH, PROJECT_ROOT, logger, IGNORE_POPULATION);

    // baseDir stays at projectRoot so the config's root-relative globs evaluate
    // on the basis they were declared against; the path arg becomes an include
    // prefix instead of a new base.
    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse',
      outputs: [],
      include: SUBTREE_INCLUDE,
      exclude: EXCLUDE_PATTERNS,
    });
    expect(result.scanPath).toBe(SUBTREE_PATH);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
  });

  it('still applies config exclude patterns when the pathArg IS the project root', async () => {
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(PROJECT_ROOT, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse',
      outputs: [],
      include: ['**/*.md', '**/*.html', '**/*.htm'],
      exclude: EXCLUDE_PATTERNS,
    });
  });

  it('scopes a relative pathArg against the project root', async () => {
    existingDirectories.add(safePath.resolve('docs'));
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await loadResourcesWithConfig('docs', safePath.resolve('.'), logger, IGNORE_POPULATION);

    expect(crawlPatterns()).toEqual({
      baseDir: safePath.resolve('.'),
      unreadable: 'refuse',
      outputs: [],
      include: ['docs/**/*.md', 'docs/**/*.html', 'docs/**/*.htm'],
      exclude: EXCLUDE_PATTERNS,
    });
  });

  it('warns and drops config patterns only when pathArg escapes the project root', async () => {
    existingDirectories.add(EXPLICIT_PATH);
    loadConfigMock.mockReturnValue({
      resources: { include: INCLUDE_PATTERNS, exclude: EXCLUDE_PATTERNS },
    });
    const { logger, warnCalls } = createTestLogger();

    const result = await loadResourcesWithConfig(EXPLICIT_PATH, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(crawlPatterns()).toEqual({ baseDir: EXPLICIT_PATH, unreadable: 'refuse', outputs: [] });
    expect(warnCalls.join('\n')).toContain(EXPLICIT_PATH);
    expect(result.scanPath).toBe(EXPLICIT_PATH);
  });

  it('fails loudly when pathArg is not an existing directory', async () => {
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await expect(
      loadResourcesWithConfig(MISSING_PATH, PROJECT_ROOT, logger, IGNORE_POPULATION),
    ).rejects.toThrow(MISSING_PATH);
    expect(lastCrawlOptions).toBeUndefined();
  });

  it('passes config to registry options even when no collections are declared', async () => {
    // 🪤 This used to assert the OPPOSITE — that the config was withheld unless
    // `collections` was present — and that pin was the defect: the registry
    // also reads `resources.linkAuth` from its config, so a project declaring
    // `linkAuth` without `collections` got the anonymous URL lane for every
    // link, with no `LINK_AUTH_*` code and nothing said. The registry guards
    // every read with `?.`, so a key it does not find costs nothing.
    const config = { resources: { include: ['**/*.md'], linkAuth: { providers: [] } } };
    loadConfigMock.mockReturnValue(config);
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(lastRegistryOptions?.config).toBe(config);
    expect(lastRegistryOptions?.baseDir).toBe(PROJECT_ROOT);
  });

  it('refuses a linkAuth provider that cannot compile at config load, before any crawl', async () => {
    // The validation-code registry promises this refusal "at config load", on
    // every command that loads `resources.linkAuth`. It used to live only in
    // the registry's external-URL lane, so without `--check-external-urls`
    // the same config crawled, reported success, and exited 0.
    const config = {
      resources: {
        linkAuth: {
          providers: [
            {
              match: { host: 'github.example' },
              rewrite: [{ when: '([unclosed', to: 'https://api.example/x' }],
              auth: { headers: { Authorization: 'Bearer ${token}' } },
              token: [{ env: 'T' }],
              check: { method: 'GET', aliveStatus: [200], notFoundMeaning: 'ambiguous' },
            },
          ],
        },
      },
    };
    loadConfigMock.mockReturnValue(config);
    const { logger } = createTestLogger();

    await expect(loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION)).rejects.toThrow(
      /resources\.linkAuth providers\[0\] \(host "github\.example"\): rewrite\[0\]\.when/,
    );
    expect(lastRegistryOptions).toBeUndefined();
    expect(lastCrawlOptions).toBeUndefined();
  });

  it('omits config from registry options only when no config file was loaded', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(lastRegistryOptions).not.toHaveProperty('config');
  });

  it('passes config to registry options when collections present', async () => {
    const config = {
      resources: {
        collections: {
          systems: { include: ['docs/systems/**/*.md'] },
        },
      },
    };
    loadConfigMock.mockReturnValue(config);
    const { logger } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(lastRegistryOptions?.config).toBe(config);
  });

  it('proceeds without config (no crash, no patterns applied)', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(crawlPatterns()).toEqual({ baseDir: PROJECT_ROOT, unreadable: 'refuse', outputs: [] });
    expect(result.config).toBeUndefined();
  });

  it('reports the lane it actually took, and takes the PROJECTION by default', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(result.lane).toBe('projection');
    // The lane is a claim about what ran, so it has to agree with whether a
    // population source was actually installed on the crawl.
    expect(lastCrawlOptions?.populationSource).toBeDefined();
  });

  it('takes the walk when opted out, and says so', async () => {
    // A lane that came back `projection` here — or `walk` in the case above —
    // would make every arm-identity claim built on this field worthless, which
    // is precisely what it exists to prevent.
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_WALK;

    try {
      const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

      expect(result.lane).toBe('walk');
      expect(lastCrawlOptions?.populationSource).toBeUndefined();
    } finally {
      delete process.env[RESOURCES_CRAWL_ENV];
    }
  });

  it('keeps honouring the historical explicit `projection` value', async () => {
    // The opt-in spelling predates the flip and is all over scripts and lab
    // arms. It must still select the projection lane rather than becoming an
    // unrecognised value that silently means something else.
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();
    process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_PROJECTION;

    try {
      const result = await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

      expect(result.lane).toBe('projection');
    } finally {
      delete process.env[RESOURCES_CRAWL_ENV];
    }
  });

  it('logs debug messages for config load and gitTracker init', async () => {
    loadConfigMock.mockReturnValue({ resources: {} });
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 42 });
    const { logger, debugCalls } = createTestLogger();

    await loadResourcesWithConfig(undefined, PROJECT_ROOT, logger, IGNORE_POPULATION);

    expect(debugCalls).toContain(`Loaded config from ${PROJECT_ROOT}`);
    expect(debugCalls).toContain('GitTracker initialized with 42 tracked files');
  });

  describe('observes the population exactly once per load', () => {
    beforeEach(() => {
      buildResourcePopulationMock.mockReset();
    });

    it('says the walk answered when the projection lane is not selected', async () => {
      process.env[RESOURCES_CRAWL_ENV] = RESOURCES_CRAWL_WALK;
      try {
        expect(await observedLoad()).toEqual([{ lane: 'walk' }]);
      } finally {
        delete process.env[RESOURCES_CRAWL_ENV];
      }
    });

    it('says the walk answered when the crawl declined the source', async () => {
      crawlDrives((source) => source.decline(SUBTREE_PATH));

      expect(await observedLoad()).toEqual([{ lane: 'walk' }]);
    });

    it('publishes a null outcome when the projection lane enumerated no root', async () => {
      crawlDrives(() => undefined);

      expect(await observedLoad()).toEqual([{ lane: 'projection', outcome: null }]);
    });

    it('publishes the one root\'s outcome', async () => {
      buildResourcePopulationMock.mockResolvedValue({ paths: [], conditions: [], outcome: HIT, extentSource: 'filesystem' });
      crawlDrives(async (source) => {
        await source.enumerate(PROJECT_ROOT, []);
      });

      expect(await observedLoad()).toEqual([{ lane: 'projection', outcome: HIT }]);
    });

    it('combines two roots into ONE observation, the first that did not hit deciding', async () => {
      buildResourcePopulationMock
        .mockResolvedValueOnce({ paths: [], conditions: [], outcome: HIT, extentSource: 'filesystem' })
        .mockResolvedValueOnce({ paths: [], conditions: [], outcome: WRITTEN, extentSource: 'filesystem' });
      crawlDrives(async (source) => {
        await source.enumerate(PROJECT_ROOT, []);
        await source.enumerate(PROJECT_ROOT, []);
      });

      expect(await observedLoad()).toEqual([{ lane: 'projection', outcome: WRITTEN }]);
    });
  });
});
