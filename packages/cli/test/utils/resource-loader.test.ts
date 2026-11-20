import type { CrawlPopulation } from '@vibe-agent-toolkit/resources';
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
/** Absolute paths the fake fs reports as existing directories. */
const existingDirectories = new Set<string>();
let lastRegistryOptions: Record<string, unknown> | undefined;
let lastCrawlOptions: Record<string, unknown> | undefined;

/**
 * The crawl options minus the population source.
 *
 * The tests below are about which include/exclude patterns a path argument
 * produces, and the run installs its one `populationSource` alongside them. Stripping exactly that one key keeps these
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

vi.mock('node:fs', async (importOriginal) => {
  // Everything not faked below is the real module: the run opens a parse cache,
  // which resolves its scratch root and reads VAT's own version off disk.
  const actual = await importOriginal<OriginalModule>();
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
  return { ...actual, ...fake, default: { ...actual, ...fake } };
});

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => ({
  ...(await importOriginal<OriginalModule>()),
  ResourceRegistry: class FakeRegistry {
    // The run's registry: the loader never crawls it, only a view of it.
    static forRun(): FakeRegistry {
      return new FakeRegistry();
    }
    // The loader's view: its options are what the loader handed the registry.
    view(options: Record<string, unknown>): FakeRegistry {
      lastRegistryOptions = options;
      return new FakeRegistry();
    }
    // Returns what the real crawl returns: the mock's answer when a test gave
    // one, otherwise a derived population on the filesystem enumerator.
    async crawl(options: Record<string, unknown>): Promise<unknown> {
      lastCrawlOptions = options;
      const returned: unknown = await registryCrawlMock(options);
      return returned ?? {
        resources: [],
        population: { outcome: { population: 'derived', stored: 'written' }, extentSource: 'filesystem' },
      };
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
import { PROJECTION_STORE_ENV, PROJECTION_STORE_OFF } from '../../src/utils/projection-store.js';
// eslint-disable-next-line import/first -- must come after vi.mock calls
import { loadResourcesWithConfig, withRunContext } from '../../src/utils/resource-loader.js';
// eslint-disable-next-line import/first -- must come after vi.mock calls
import { loadResourcesInRun as load } from '../helpers/in-run.js';

const HIT = { population: 'store', stored: 'hit' } as const;

/** The source the loader installed on the crawl, refused when it installed none. */
interface InstalledSource {
  enumerate: (root: string, outputs: readonly string[]) => Promise<unknown>;
}

/**
 * Make the faked crawl return `population` beside no resources, after checking
 * the loader handed it a source.
 *
 * @param population - What the crawl says about where its population came from
 */
function crawlReturns(population: CrawlPopulation): void {
  registryCrawlMock.mockImplementation((options: { populationSource?: InstalledSource }) => {
    if (options.populationSource === undefined) throw new Error('no population source was installed');
    return Promise.resolve({ resources: [], population });
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
 * Load once with no config.
 *
 * @returns The population the load result carries — the one channel
 */
async function loadedPopulation(): Promise<CrawlPopulation> {
  loadConfigMock.mockReturnValue(undefined);
  const { logger } = createTestLogger();
  return (await load(undefined, PROJECT_ROOT, logger)).population;
}

describe('loadResourcesWithConfig', () => {
  beforeEach(() => {
    // `node:fs` is faked here, so no store can key this tree: keying a tree in
    // no repository asks git why in a throwaway index under the real temp dir.
    vi.stubEnv(PROJECTION_STORE_ENV, PROJECTION_STORE_OFF);
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
    vi.unstubAllEnvs();
  });

  it('uses projectRoot as baseDir and applies config patterns when no pathArg', async () => {
    loadConfigMock.mockReturnValue({
      resources: {
        include: INCLUDE_PATTERNS,
        exclude: EXCLUDE_PATTERNS,
      },
    });
    const { logger } = createTestLogger();

    const result = await load(undefined, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse', ignoredRefusals: 'record',
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

    const result = await load(SUBTREE_PATH, PROJECT_ROOT, logger);

    // baseDir stays at projectRoot so the config's root-relative globs evaluate
    // on the basis they were declared against; the path arg becomes an include
    // prefix instead of a new base.
    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse', ignoredRefusals: 'record',
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

    await load(PROJECT_ROOT, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({
      baseDir: PROJECT_ROOT,
      unreadable: 'refuse', ignoredRefusals: 'record',
      outputs: [],
      include: ['**/*.md', '**/*.html', '**/*.htm'],
      exclude: EXCLUDE_PATTERNS,
    });
  });

  it('scopes a relative pathArg against the project root', async () => {
    existingDirectories.add(safePath.resolve('docs'));
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await load('docs', safePath.resolve('.'), logger);

    expect(crawlPatterns()).toEqual({
      baseDir: safePath.resolve('.'),
      unreadable: 'refuse', ignoredRefusals: 'record',
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

    const result = await load(EXPLICIT_PATH, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({ baseDir: EXPLICIT_PATH, unreadable: 'refuse', ignoredRefusals: 'record', outputs: [] });
    expect(warnCalls.join('\n')).toContain(EXPLICIT_PATH);
    expect(result.scanPath).toBe(EXPLICIT_PATH);
  });

  it('fails loudly when pathArg is not an existing directory', async () => {
    loadConfigMock.mockReturnValue({ resources: { exclude: EXCLUDE_PATTERNS } });
    const { logger } = createTestLogger();

    await expect(
      load(MISSING_PATH, PROJECT_ROOT, logger),
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

    await load(undefined, PROJECT_ROOT, logger);

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

    await expect(load(undefined, PROJECT_ROOT, logger)).rejects.toThrow(
      /resources\.linkAuth providers\[0\] \(host "github\.example"\): rewrite\[0\]\.when/,
    );
    expect(lastRegistryOptions).toBeUndefined();
    expect(lastCrawlOptions).toBeUndefined();
  });

  it('omits config from registry options only when no config file was loaded', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    await load(undefined, PROJECT_ROOT, logger);

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

    await load(undefined, PROJECT_ROOT, logger);

    expect(lastRegistryOptions?.config).toBe(config);
  });

  it('proceeds without config (no crash, no patterns applied)', async () => {
    loadConfigMock.mockReturnValue(undefined);
    const { logger } = createTestLogger();

    const result = await load(undefined, PROJECT_ROOT, logger);

    expect(crawlPatterns()).toEqual({ baseDir: PROJECT_ROOT, unreadable: 'refuse', ignoredRefusals: 'record', outputs: [] });
    expect(result.config).toBeUndefined();
  });

  it('logs debug messages for config load and gitTracker init', async () => {
    loadConfigMock.mockReturnValue({ resources: {} });
    gitTrackerGetStatsMock.mockReturnValue({ cacheSize: 42 });
    const { logger, debugCalls } = createTestLogger();

    await load(undefined, PROJECT_ROOT, logger);

    expect(debugCalls).toContain(`Loaded config from ${PROJECT_ROOT}`);
    expect(debugCalls).toContain('GitTracker initialized with 42 tracked files');
  });

  describe('carries the population the crawl returned on the load result', () => {
    it('publishes the outcome and enumerator the crawl RETURNED', async () => {
      crawlReturns({ outcome: HIT, extentSource: 'git' });

      expect(await loadedPopulation()).toEqual({ outcome: HIT, extentSource: 'git' });
    });

    it('hands the crawl the run\'s own source, the one route the outcome takes out', async () => {
      loadConfigMock.mockReturnValue(undefined);
      const { logger } = createTestLogger();

      await withRunContext({ root: PROJECT_ROOT }, async (run) => {
        await loadResourcesWithConfig(undefined, run, logger);
        // No second source beside the run's: the run enumerates its home root
        // once, and that enumeration's outcome is what the crawl returns.
        expect(lastCrawlOptions?.['populationSource']).toBe(run.population.source);
      });
    });
  });
});
