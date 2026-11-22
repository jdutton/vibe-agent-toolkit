/**
 * The pure halves of `perf run --cpu-prof-dir` and `perf attribute`: which
 * profile files are a vat process's, how samples are timed, which bucket a
 * stack lands in, how banners become profile windows, and how repeats fold.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { parseProfileName, selectVatProfiles } from '../src/facets/perf/cpu-profiles.js';
import {
  attributeProfile,
  bannerWindows,
  type BucketRule,
  type CpuProfile,
  OTHER_BUCKET,
  sampleTimes,
  type UrlPattern,
} from '../src/facets/perf/profile-attribution.js';
import { VALIDATE_PHASE_BUCKETS, type VatModulePattern } from '../src/facets/perf/profile-buckets.js';
import { foldWindows, repeatWindows } from '../src/facets/perf/profile-report.js';
import type { PerfProcessDump } from '../src/facets/perf/types.js';

/** A frame as V8 writes one. */
function frame(functionName: string, url = '', lineNumber = 0): CpuProfile['nodes'][number]['callFrame'] {
  return { functionName, url, lineNumber };
}

/**
 * A profile whose nodes form the given stacks under one root, sampled in order.
 *
 * @param stacks - Each sample's stack, root-most frame first (the root itself is implied)
 * @param deltasUs - Each sample's time delta from the previous one
 * @param startTime - The profile's start, microseconds
 * @param endTime - The profile's end, microseconds
 * @returns The profile
 */
function profileOf(
  stacks: readonly (readonly CpuProfile['nodes'][number]['callFrame'][])[],
  deltasUs: readonly number[],
  startTime = 0,
  endTime = deltasUs.reduce((sum, delta) => sum + delta, 0) + 1000,
): CpuProfile {
  const nodes: CpuProfile['nodes'] = [{ id: 1, callFrame: frame('(root)'), children: [] }];
  const samples: number[] = [];
  for (const stack of stacks) {
    let parent = nodes[0];
    for (const callFrame of stack) {
      const node = { id: nodes.length + 1, callFrame, children: [] as number[] };
      nodes.push(node);
      parent?.children?.push(node.id);
      parent = node;
    }
    samples.push(parent?.id ?? 1);
  }
  return { nodes, startTime, endTime, samples, timeDeltas: [...deltasUs] };
}

/** A perf-probe record. */
function record(pid: number, startMs: number, endMs: number, banners: PerfProcessDump['banners'] = []): PerfProcessDump {
  return { pid, ppid: 1, startMs, endMs, userCpuUs: 0, systemCpuUs: 0, banners };
}

describe('CPU profile files', () => {
  it("reads the pid and thread out of Node's profile name, and nothing else", () => {
    expect(parseProfileName('CPU.20261121.185702.96541.0.001.cpuprofile')).toEqual({ pid: 96541, tid: 0 });
    expect(parseProfileName('CPU.20261121.185702.96541.1.002.cpuprofile')).toEqual({ pid: 96541, tid: 1 });
    expect(parseProfileName('perf-96541-uuid.json')).toBeNull();
  });

  it("keeps every thread of a vat process and drops a process vat's probe did not record", () => {
    const names = [
      'CPU.20261121.185702.10.0.001.cpuprofile',
      'CPU.20261121.185702.10.1.002.cpuprofile',
      'CPU.20261121.185702.11.0.003.cpuprofile',
      'CPU.20261121.185702.99.0.004.cpuprofile',
    ];

    expect(selectVatProfiles(names, [10, 11])).toEqual(names.slice(0, 3));
  });

  it('refuses a vat process with no main-thread profile, naming it', () => {
    expect(selectVatProfiles(['CPU.20261121.185702.10.1.002.cpuprofile'], [10])).toMatch(/vat process 10 did not leave exactly one/u);
  });
});

describe('attributeProfile', () => {
  const rules: readonly BucketRule[] = [
    { bucket: 'narrow', functionName: /^freeze$/u },
    { bucket: 'broad', url: /reader\.js$/u },
  ];

  it('times a sample from its delta to the next one, the last to the end', () => {
    expect(sampleTimes(profileOf([[frame('a')], [frame('b')]], [100, 300], 0, 1000)).map((s) => [s.atUs, s.durationUs])).toEqual([
      [100, 300],
      [400, 600],
    ]);
  });

  it('gives a sample to the first rule in order with a frame anywhere on its stack, not the innermost frame', () => {
    const profile = profileOf(
      [
        [frame('freeze'), frame('read', 'file:///x/reader.js')],
        [frame('read', 'file:///x/reader.js'), frame('leaf')],
        [frame('elsewhere')],
      ],
      [0, 1000, 1000],
      0,
      3000,
    );
    const [window] = attributeProfile(profile, [{ name: 'w', startUs: 0, endUs: 3000 }], rules);

    expect(window?.buckets).toEqual({ narrow: 1, broad: 1, [OTHER_BUCKET]: 1 });
    expect(Object.keys(window?.frames[OTHER_BUCKET] ?? {})).toEqual(['elsewhere :1']);
  });

  it('lists idle time by the bucket of the sample before it', () => {
    const profile = profileOf([[frame('freeze')], [frame('(idle)')], [frame('(idle)')]], [0, 1000, 1000], 0, 3000);
    const [window] = attributeProfile(profile, [{ name: 'w', startUs: 0, endUs: 3000 }], [...rules, { bucket: 'idle', functionName: /^\(idle\)$/u }]);

    expect(window?.frames['idle']).toEqual({ 'after narrow': 2 });
  });

  it('counts a sample only in the window that holds its instant', () => {
    const profile = profileOf([[frame('a')], [frame('b')]], [500, 1000], 0, 2500);
    const windows = attributeProfile(profile, [{ name: 'first', startUs: 0, endUs: 1000 }, { name: 'second', startUs: 1000, endUs: 2500 }], []);

    expect(windows.map((window) => window.buckets)).toEqual([{ [OTHER_BUCKET]: 1 }, { [OTHER_BUCKET]: 1 }]);
  });
});

describe('bannerWindows', () => {
  it("aligns the probe's epoch banners to the profile's clock at the process's end", () => {
    // Profile clock 5_000_000..7_000_000 us; the probe saw the process end at 12_000 ms epoch.
    const profile = profileOf([], [], 5_000_000, 7_000_000);
    const { windows, startSkewMs } = bannerWindows(
      record(1, 9_990, 12_000, [{ name: 'resources', atMs: 10_500 }, { name: 'skills', atMs: 11_000 }]),
      profile,
    );

    expect(windows).toEqual([
      { name: '(startup)', startUs: 5_000_000, endUs: 5_500_000 },
      { name: 'resources', startUs: 5_500_000, endUs: 6_000_000 },
      { name: 'skills', startUs: 6_000_000, endUs: 7_000_000 },
    ]);
    expect(startSkewMs).toBeCloseTo(10, 6);
  });

  it('is one window for a process that wrote no banner', () => {
    expect(bannerWindows(record(1, 0, 2000), profileOf([], [], 0, 2_000_000)).windows).toEqual([
      { name: '(process)', startUs: 0, endUs: 2_000_000 },
    ]);
  });
});

describe('perf attribute folding', () => {
  it('names a bannerless process by its start order and refuses a process with no profile', () => {
    const profile = profileOf([], [], 0, 1_000_000);
    const windows = repeatWindows([record(7, 5, 1000), record(3, 0, 1000, [{ name: 'resources', atMs: 10 }])], new Map([[3, profile], [7, profile]]));

    expect(typeof windows === 'string' ? windows : windows.flatMap((p) => p.windows.map((w) => w.name))).toEqual([
      '(startup)',
      'resources',
      '(process 2)',
    ]);
    expect(repeatWindows([record(3, 0, 1000)], new Map())).toBe('no main-thread profile for vat process 3');
  });

  it('keeps every window of two banner-bearing processes and of a repeated banner apart', () => {
    const profile = profileOf([], [], 0, 1_000_000);
    const windows = repeatWindows(
      [
        record(3, 0, 1000, [{ name: 'resources', atMs: 10 }, { name: 'resources', atMs: 20 }]),
        record(7, 5, 1000, [{ name: 'resources', atMs: 30 }]),
      ],
      new Map([[3, profile], [7, profile]]),
    );
    const names = typeof windows === 'string' ? [windows] : windows.flatMap((p) => p.windows.map((w) => w.name));

    expect(names).toEqual(['(startup)', 'resources', 'resources #2', '(startup) (process 2)', 'resources (process 2)']);
    expect(new Set(names).size).toBe(names.length);
  });

  it("takes each bucket's median over repeats, as a share of the window's median span", () => {
    const repeat = (spanMs: number, ms: number) => [{ name: 'resources', spanMs, buckets: { blob: ms }, frames: { blob: { 'read x:1': ms } } }];
    const [figure] = foldWindows([repeat(100, 10), repeat(200, 30), repeat(300, 20)]);

    expect(figure?.spanMedianMs).toBe(200);
    expect(figure?.buckets).toEqual([{ bucket: 'blob', medianMs: 20, share: 0.1, frames: [{ frame: 'read x:1', meanMs: 20 }] }]);
  });
});

/** The bucket the shipped rules give one stack, root-most frame first. */
function bucketFor(stack: readonly CpuProfile['nodes'][number]['callFrame'][]): string {
  const [window] = attributeProfile(profileOf([stack], [0], 0, 1000), [{ name: 'w', startUs: 0, endUs: 1000 }], VALIDATE_PHASE_BUCKETS);
  return Object.keys(window?.buckets ?? {})[0] ?? 'none';
}

/** A module of a vat package built in the monorepo, as V8 writes its url. */
function dist(pkg: string, module: string): string {
  return pathToFileURL(`/repo/packages/${pkg}/dist/${module}.js`).href;
}

/** The same module installed from npm. */
function installed(pkg: string, module: string): string {
  return pathToFileURL(`/app/node_modules/@vibe-agent-toolkit/${pkg}/dist/${module}.js`).href;
}

/** The monorepo's `packages/` directory: a vat module rule names `<package>/src/<module>.ts` under it. */
const PACKAGES_DIR = resolveFromImportMeta(import.meta.url, '../..');

/**
 * @param url - A rule's url pattern
 * @returns Whether it is a pattern over named vat modules
 */
function isVatModulePattern(url: UrlPattern | undefined): url is VatModulePattern {
  return url !== undefined && 'modules' in url;
}

describe('VALIDATE_PHASE_BUCKETS', () => {
  it.each([
    ['a sync git spawn', [frame('takeSnapshot', dist('utils', 'git-snapshot')), frame('spawnSync', 'node:child_process')], 'git spawns'],
    ['git output parsing', [frame('initializeNow', dist('utils', 'git-tracker'))], 'git output handling'],
    ['the extent read, through the shared decode', [frame('readExtentRows', dist('projection-sqlite', 'store')), frame('decodeRows', dist('projection-sqlite', 'store'))], 'extent read'],
    ['the blob read, through the shared decode', [frame('readBlobRows', installed('projection-sqlite', 'store')), frame('decodeRows', installed('projection-sqlite', 'store'))], 'blob read and decode'],
    ['a freeze inside the reader', [frame('factsOf', dist('resources', 'projection/blob-resource-facts')), frame('deepFreeze', dist('utils', 'deep-freeze'))], 'deep-freeze and copies'],
    ['the reader itself', [frame('linksOf', dist('resources', 'projection/blob-resource-facts'))], 'reader rebuild'],
    ['an lstat under the chain walk', [frame('followedRealpathSync', dist('utils', 'link-following')), frame('lstatSync', 'node:fs')], 'chain-walk lstats'],
    ['a bare stat', [frame('stat', 'node:internal/fs/promises')], 'probes and stats'],
    ['a skills detector', [frame('detect', installed('agent-skills', 'validators/kebab-case-detection'))], 'skills detectors'],
    ['rendering the report', [frame('renderYamlDocument', dist('cli', 'utils/output'))], 'report'],
    ['waiting', [frame('(idle)')], 'idle'],
    ['a module named by a Windows path', [frame('linksOf', String.raw`C:\repo\packages\resources\dist\projection\blob-resource-facts.js`)], 'reader rebuild'],
    ['a dependency', [frame('validate', pathToFileURL('/app/node_modules/ajv/dist/core.js').href)], 'frontmatter schema validation'],
    ['a module whose name only starts like a listed one', [frame('helper', dist('utils', 'git-snapshot-extra'))], 'other'],
  ] as const)('puts %s in its bucket', (_label, stack, bucket) => {
    expect(bucketFor(stack)).toBe(bucket);
  });

  it('names only vat modules that exist, so no rule is one that can never match', () => {
    const named = VALIDATE_PHASE_BUCKETS.map(({ url }) => url)
      .filter((url) => isVatModulePattern(url))
      .flatMap(({ pkg, modules }) => modules.map((module) => `${pkg}/src/${module}.ts`));
    expect(named.length, 'the rules name vat modules').toBeGreaterThan(0);
    expect(named.filter((path) => !existsSync(safePath.join(PACKAGES_DIR, path)))).toEqual([]);
  });
});
