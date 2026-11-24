/**
 * The npm registry guard's decisions, offline: every registry read goes through
 * an injected `RegistryGet` answered from a map, so no case touches the network.
 */
import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
  checkBeforePublish,
  checkLatestAfterStablePublish,
  findingsExitCode,
  type LatestPoll,
  packumentPath,
  parseGuardArgs,
  readDistTag,
  SCOPE_LISTING_PATH,
  type RegistryFinding,
  type RegistryGet,
} from '../src/npm-registry-guard.js';

const RC = '1.0.0-rc.2';
const STABLE = '1.0.0';
const SCHEMA = '@vibe-agent-toolkit/schema';
const CLI = '@vibe-agent-toolkit/cli';
const REMOVED = '@vibe-agent-toolkit/agent-runtime';
const RENAMED = '@vibe-agent-toolkit/agent-schema';
const UMBRELLA = 'vibe-agent-toolkit';
const DEPRECATION = 'Removed; no replacement.';
const AFTER_FLAG = '--after-stable-publish';
const OLD_RC = '0.9.0-rc.3';
const OLD_STABLE = '0.9.0';

/** npm's 200 answer for a package whose every version was unpublished: no dist-tags, no versions. */
const UNPUBLISHED_RECORD = { name: SCHEMA, modified: '2026-11-24T00:00:00.000Z', time: { unpublished: { time: '2026-11-24T00:00:00.000Z' } } };
/** The same record without `time`, as the abbreviated document can carry it. */
const UNPUBLISHED_BARE = { name: SCHEMA, modified: '2026-11-24T00:00:00.000Z' };

/** A packument with `latest` and the given versions, each deprecated or not. */
function packument(latest: string, versions: Record<string, boolean>): unknown {
  return {
    'dist-tags': { latest },
    versions: Object.fromEntries(
      Object.entries(versions).map(([v, deprecated]) => [v, deprecated ? { deprecated: DEPRECATION } : {}]),
    ),
  };
}

/** A registry answering from `docs` (path to body); a path it does not hold is a 404. */
function registry(docs: Record<string, unknown>): RegistryGet {
  return (path) => Promise.resolve(docs[path]);
}

function listing(names: readonly string[]): Record<string, unknown> {
  return { [SCOPE_LISTING_PATH]: Object.fromEntries(names.map((n) => [n, 'write'])) };
}

const published = (name: string) => ({ name, isPrivate: false });

function errors(findings: readonly RegistryFinding[]): RegistryFinding[] {
  return findings.filter((f) => f.severity === 'error');
}

/** A poll that never really waits; `slept` records every interval it was asked to wait. */
function poll(overrides: Partial<LatestPoll> = {}): LatestPoll & { slept: number[] } {
  const slept: number[] = [];
  return {
    intervalMs: 1000,
    maxReads: 20,
    stallReads: 3,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...overrides,
    slept,
  };
}

/** A registry whose answer for each path is the next item of its script, the last one repeating. */
function scripted(scripts: Record<string, ReadonlyArray<unknown>>): RegistryGet {
  const reads = new Map<string, number>();
  return (path) => {
    const script = scripts[path] ?? [undefined];
    const n = reads.get(path) ?? 0;
    reads.set(path, n + 1);
    const answer = script[Math.min(n, script.length - 1)];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

/**
 * The RC check over a workspace publishing only the schema package, whose
 * registry document is `doc` (absent: a 404). Asserts the one schema warning
 * it must produce and returns that warning's message.
 */
async function rcSchemaWarning(doc: unknown): Promise<string> {
  const docs = doc === undefined ? listing([]) : { ...listing([SCHEMA]), [packumentPath(SCHEMA)]: doc };
  const findings = await checkBeforePublish({ version: RC, workspacePackages: [published(SCHEMA)], get: registry(docs) });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ severity: 'warning', packageName: SCHEMA });
  expect(findingsExitCode(findings)).toBe(ExitCode.OK);
  return findings[0]?.message ?? '';
}

describe('checkBeforePublish: workspace packages whose latest a release would leave behind', () => {
  it('warns on an RC when a published package\'s latest is a prerelease, and does not fail', async () => {
    expect(await rcSchemaWarning(packument(OLD_RC, { [OLD_RC]: false }))).toContain(OLD_RC);
  });

  it('warns on an RC when a package is not on npm: its first publish takes latest', async () => {
    const message = await rcSchemaWarning(undefined);
    expect(message).toContain('not on npm');
    expect(message).toContain(`latest = ${RC}`);
  });

  it('reads npm\'s record of a wholly unpublished package as not on npm, with or without time.unpublished', async () => {
    expect(await rcSchemaWarning(UNPUBLISHED_RECORD)).toContain('not on npm');
    expect(await rcSchemaWarning(UNPUBLISHED_BARE)).toContain('not on npm');
  });

  it('says nothing on an RC when latest is stable', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [published(CLI)],
      get: registry({ ...listing([CLI]), [packumentPath(CLI)]: packument(OLD_STABLE, { [OLD_STABLE]: false }) }),
    });
    expect(findings).toEqual([]);
  });

  it('says nothing before a stable publish, which moves latest itself', async () => {
    const findings = await checkBeforePublish({
      version: STABLE,
      workspacePackages: [published(SCHEMA), published(CLI)],
      get: registry({ ...listing([SCHEMA]), [packumentPath(SCHEMA)]: packument(OLD_RC, { [OLD_RC]: false }) }),
    });
    expect(findings).toEqual([]);
  });

  it('never reads a private workspace package\'s dist-tags', async () => {
    const read: string[] = [];
    await checkBeforePublish({
      version: RC,
      workspacePackages: [{ name: '@vibe-agent-toolkit/dev-tools', isPrivate: true }],
      get: (path) => {
        read.push(path);
        return Promise.resolve(path === SCOPE_LISTING_PATH ? {} : undefined);
      },
    });
    expect(read).not.toContain(packumentPath('@vibe-agent-toolkit/dev-tools'));
  });
});

describe('checkBeforePublish: packages on npm that are no longer workspace packages', () => {
  it('fails a removed scope package that is not deprecated, with the npm deprecate command', async () => {
    for (const version of [RC, STABLE]) {
      const findings = await checkBeforePublish({
        version,
        workspacePackages: [],
        get: registry({
          ...listing([REMOVED]),
          [packumentPath(REMOVED)]: packument(OLD_STABLE, { '0.8.0': true, [OLD_STABLE]: false }),
        }),
      });
      expect(errors(findings)).toHaveLength(1);
      expect(errors(findings)[0]?.packageName).toBe(REMOVED);
      expect(errors(findings)[0]?.fix).toMatch(new RegExp(`^npm deprecate ${REMOVED} "`));
      expect(errors(findings)[0]?.fix).toContain('no longer maintained');
      expect(findingsExitCode(findings)).toBe(ExitCode.FINDINGS);
    }
  });

  it('names the replacement in the deprecation message where one exists', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({ ...listing([RENAMED]), [packumentPath(RENAMED)]: packument(OLD_STABLE, { [OLD_STABLE]: false }) }),
    });
    expect(errors(findings)[0]?.fix).toContain(`use ${SCHEMA}`);
  });

  it('passes a removed package whose every version is deprecated', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({
        ...listing([REMOVED]),
        [packumentPath(REMOVED)]: packument(OLD_STABLE, { '0.8.0': true, [OLD_STABLE]: true }),
      }),
    });
    expect(findings).toEqual([]);
  });

  it('passes a removed package npm holds only as an unpublished record: there is nothing to deprecate', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: UNPUBLISHED_RECORD }),
    });
    expect(findings).toEqual([]);
  });

  it('does not call a private workspace package removed', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [{ name: REMOVED, isPrivate: true }],
      get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: packument(OLD_STABLE, { [OLD_STABLE]: false }) }),
    });
    expect(findings).toEqual([]);
  });

  it('checks the unscoped umbrella, which no scope listing names', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({ ...listing([]), [packumentPath(UMBRELLA)]: packument(OLD_STABLE, { [OLD_STABLE]: false }) }),
    });
    expect(errors(findings).map((f) => f.packageName)).toEqual([UMBRELLA]);
  });

  it('refuses to run when the scope listing is missing, rather than reporting nothing removed', async () => {
    await expect(checkBeforePublish({ version: RC, workspacePackages: [], get: registry({}) })).rejects.toThrow(
      /scope listing/,
    );
  });

  it('refuses a document that has versions but not a packument\'s shape, rather than skipping the package', async () => {
    await expect(
      checkBeforePublish({
        version: RC,
        workspacePackages: [],
        get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: { versions: { '1.0.0': 'nope' } } }),
      }),
    ).rejects.toThrow(REMOVED);
  });
});

describe('checkLatestAfterStablePublish', () => {
  const current = packument(STABLE, { [OLD_RC]: false, [STABLE]: false });
  const behind = packument(OLD_RC, { [OLD_RC]: false, [STABLE]: false });

  it('passes on the first read when every published package\'s latest is the release, without waiting', async () => {
    const p = poll();
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: registry({ [packumentPath(SCHEMA)]: current, [packumentPath(CLI)]: current }),
      poll: p,
    });
    expect(findings).toEqual([]);
    expect(p.slept).toEqual([]);
  });

  it('fails with the npm dist-tag command once the mismatch stops shrinking', async () => {
    const p = poll({ stallReads: 3 });
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: registry({ [packumentPath(SCHEMA)]: behind, [packumentPath(CLI)]: current }),
      poll: p,
    });
    // One read sets the mark; three more without progress end the poll.
    expect(p.slept).toEqual([1000, 1000, 1000]);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        packageName: SCHEMA,
        fix: `npm dist-tag add ${SCHEMA}@${STABLE} latest`,
      }),
    ]);
    expect(findingsExitCode(findings)).toBe(ExitCode.FINDINGS);
  });

  it('keeps polling past the stall limit while the mismatch keeps shrinking', async () => {
    const p = poll({ stallReads: 2 });
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: scripted({
        [packumentPath(SCHEMA)]: [undefined, undefined, undefined, current],
        [packumentPath(CLI)]: [undefined, current],
      }),
      poll: p,
    });
    expect(findings).toEqual([]);
    expect(p.slept.length).toBeGreaterThan(2);
  });

  it('stops at the overall read cap even while the mismatch is still shrinking', async () => {
    const p = poll({ maxReads: 2, stallReads: 10 });
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: scripted({ [packumentPath(SCHEMA)]: [behind], [packumentPath(CLI)]: [behind, current] }),
      poll: p,
    });
    expect(p.slept).toHaveLength(1);
    expect(findings.map((f) => f.packageName)).toEqual([SCHEMA]);
  });

  it('waits out the processing lag: a 404 that clears is not a failure', async () => {
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA],
      get: scripted({ [packumentPath(SCHEMA)]: [undefined, undefined, current] }),
      poll: poll(),
    });
    expect(findings).toEqual([]);
  });

  it('reports a release missing from npm with a publish hint, never a dist-tag command that would E404', async () => {
    for (const body of [undefined, UNPUBLISHED_RECORD, UNPUBLISHED_BARE, packument(OLD_RC, { [OLD_RC]: false })]) {
      const findings = await checkLatestAfterStablePublish({
        version: STABLE,
        publishedPackages: [SCHEMA],
        get: registry({ [packumentPath(SCHEMA)]: body }),
        poll: poll({ stallReads: 1 }),
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'error', packageName: SCHEMA });
      expect(findings[0]?.fix).toBeUndefined();
      expect(findings[0]?.message).toContain(`${SCHEMA}@${STABLE} is not on npm`);
      expect(findings[0]?.message).toContain('npm publish');
    }
  });

  it('retries a registry error inside the poll instead of failing at once', async () => {
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA],
      get: scripted({ [packumentPath(SCHEMA)]: [new Error('503 Service Unavailable'), current] }),
      poll: poll(),
    });
    expect(findings).toEqual([]);
  });

  it('refuses when the registry still cannot be read at the end of the poll', async () => {
    await expect(
      checkLatestAfterStablePublish({
        version: STABLE,
        publishedPackages: [SCHEMA],
        get: scripted({ [packumentPath(SCHEMA)]: [new Error('503 Service Unavailable')] }),
        poll: poll({ stallReads: 2 }),
      }),
    ).rejects.toThrow(/503/);
  });

  it('refuses a prerelease version: only a stable publish owns latest', async () => {
    await expect(
      checkLatestAfterStablePublish({ version: RC, publishedPackages: [], get: registry({}), poll: poll() }),
    ).rejects.toThrow(/stable/);
  });
});

describe('readDistTag', () => {
  it('reads a dist-tag', async () => {
    const get = registry({ [packumentPath(UMBRELLA)]: packument(OLD_STABLE, { [OLD_STABLE]: false }) });
    await expect(readDistTag(get, UMBRELLA, 'latest')).resolves.toBe(OLD_STABLE);
    await expect(readDistTag(get, UMBRELLA, 'next')).resolves.toBeUndefined();
  });

  it('answers undefined for a package npm does not have, unpublished included', async () => {
    await expect(readDistTag(registry({}), UMBRELLA, 'next')).resolves.toBeUndefined();
    await expect(
      readDistTag(registry({ [packumentPath(UMBRELLA)]: UNPUBLISHED_RECORD }), UMBRELLA, 'next'),
    ).resolves.toBeUndefined();
  });

  it('fails closed: a registry error is never read as "no tag"', async () => {
    await expect(readDistTag(scripted({ [packumentPath(UMBRELLA)]: [new Error('ECONNRESET')] }), UMBRELLA, 'next')).rejects.toThrow(
      'ECONNRESET',
    );
  });
});

describe('parseGuardArgs', () => {
  const cwd = '/repo';

  it('defaults to npm, the working directory and a poll capped well past the registry cache\'s 300 s', () => {
    const args = parseGuardArgs([AFTER_FLAG, STABLE], cwd);
    expect(args).toMatchObject({ version: STABLE, root: cwd, registry: 'https://registry.npmjs.org' });
    expect(args.intervalMs * args.maxReads).toBeGreaterThan(300_000 + 300_000);
  });

  it('reads every flag', () => {
    const args = parseGuardArgs(
      [AFTER_FLAG, STABLE, '--registry', 'http://127.0.0.1:1', '--interval-ms', '0', '--max-reads', '3', '--stall-reads', '2'],
      cwd,
    );
    expect(args).toMatchObject({ registry: 'http://127.0.0.1:1', intervalMs: 0, maxReads: 3, stallReads: 2 });
  });

  it.each([
    [[AFTER_FLAG, STABLE, '--max-reads', '0'], /--max-reads/],
    [[AFTER_FLAG, STABLE, '--stall-reads', '0'], /--stall-reads/],
    [[AFTER_FLAG, STABLE, '--interval-ms', '-1'], /--interval-ms/],
    [[AFTER_FLAG, STABLE, '--interval-ms', '1.5'], /--interval-ms/],
    [[AFTER_FLAG, 'v1.0'], /not a version/],
    [[AFTER_FLAG, RC], /prerelease/],
    [[AFTER_FLAG], /needs a value/],
    [['--root', '/x'], /required/],
    [[AFTER_FLAG, STABLE, '--bogus', '1'], /Unknown option/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseGuardArgs(argv, cwd)).toThrow(message);
  });
});
