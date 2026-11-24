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
  packumentPath,
  SCOPE_LISTING_PATH,
  type RegistryFinding,
  type RegistryGet,
} from '../src/npm-registry-guard.js';

const RC = '1.0.0-rc.2';
const STABLE = '1.0.0';
const SCHEMA = '@vibe-agent-toolkit/schema';
const CLI = '@vibe-agent-toolkit/cli';
const REMOVED = '@vibe-agent-toolkit/agent-runtime';
const UMBRELLA = 'vibe-agent-toolkit';
const DEPRECATION = 'Removed; no replacement.';

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

describe('checkBeforePublish: workspace packages whose latest a release would leave behind', () => {
  it('warns on an RC when a published package\'s latest is a prerelease, and does not fail', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [published(SCHEMA)],
      get: registry({ ...listing([SCHEMA]), [packumentPath(SCHEMA)]: packument('0.9.0-rc.3', { '0.9.0-rc.3': false }) }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', packageName: SCHEMA });
    expect(findings[0]?.message).toContain('0.9.0-rc.3');
    expect(findingsExitCode(findings)).toBe(ExitCode.OK);
  });

  it('warns on an RC when a package has never been published: its first publish takes latest', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [published(SCHEMA)],
      get: registry(listing([])),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', packageName: SCHEMA });
    expect(findings[0]?.message).toContain('never been published');
    expect(findings[0]?.message).toContain(`latest = ${RC}`);
  });

  it('says nothing on an RC when latest is stable', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [published(CLI)],
      get: registry({ ...listing([CLI]), [packumentPath(CLI)]: packument('0.9.0', { '0.9.0': false }) }),
    });
    expect(findings).toEqual([]);
  });

  it('says nothing before a stable publish, which moves latest itself', async () => {
    const findings = await checkBeforePublish({
      version: STABLE,
      workspacePackages: [published(SCHEMA), published(CLI)],
      get: registry({ ...listing([SCHEMA]), [packumentPath(SCHEMA)]: packument('0.9.0-rc.3', { '0.9.0-rc.3': false }) }),
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
        get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: packument('0.9.0', { '0.8.0': true, '0.9.0': false }) }),
      });
      expect(errors(findings)).toHaveLength(1);
      expect(errors(findings)[0]?.packageName).toBe(REMOVED);
      expect(errors(findings)[0]?.fix).toMatch(new RegExp(`^npm deprecate ${REMOVED} "`));
      expect(findingsExitCode(findings)).toBe(ExitCode.FINDINGS);
    }
  });

  it('passes a removed package whose every version is deprecated', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: packument('0.9.0', { '0.8.0': true, '0.9.0': true }) }),
    });
    expect(findings).toEqual([]);
  });

  it('does not call a private workspace package removed', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [{ name: REMOVED, isPrivate: true }],
      get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: packument('0.9.0', { '0.9.0': false }) }),
    });
    expect(findings).toEqual([]);
  });

  it('checks the unscoped umbrella, which no scope listing names', async () => {
    const findings = await checkBeforePublish({
      version: RC,
      workspacePackages: [],
      get: registry({ ...listing([]), [packumentPath(UMBRELLA)]: packument('0.9.0', { '0.9.0': false }) }),
    });
    expect(errors(findings).map((f) => f.packageName)).toEqual([UMBRELLA]);
  });

  it('refuses to run when the scope listing is missing, rather than reporting nothing removed', async () => {
    await expect(checkBeforePublish({ version: RC, workspacePackages: [], get: registry({}) })).rejects.toThrow(
      /scope listing/,
    );
  });

  it('refuses a packument it cannot read, rather than skipping the package', async () => {
    await expect(
      checkBeforePublish({
        version: RC,
        workspacePackages: [],
        get: registry({ ...listing([REMOVED]), [packumentPath(REMOVED)]: { versions: 'nope' } }),
      }),
    ).rejects.toThrow(REMOVED);
  });
});

describe('checkLatestAfterStablePublish', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('passes when every published package\'s latest is the version just released', async () => {
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: registry({
        [packumentPath(SCHEMA)]: packument(STABLE, { [STABLE]: false }),
        [packumentPath(CLI)]: packument(STABLE, { [STABLE]: false }),
      }),
      attempts: 3,
      sleep: noSleep,
    });
    expect(findings).toEqual([]);
  });

  it('fails with the npm dist-tag command when latest stays behind after every attempt', async () => {
    let slept = 0;
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA, CLI],
      get: registry({
        [packumentPath(SCHEMA)]: packument('0.9.0-rc.3', { '0.9.0-rc.3': false, [STABLE]: false }),
        [packumentPath(CLI)]: packument(STABLE, { [STABLE]: false }),
      }),
      attempts: 3,
      sleep: () => {
        slept++;
        return Promise.resolve();
      },
    });
    expect(slept).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      packageName: SCHEMA,
      fix: `npm dist-tag add ${SCHEMA}@${STABLE} latest`,
    });
    expect(findingsExitCode(findings)).toBe(ExitCode.FINDINGS);
  });

  it('waits out the registry\'s processing lag: a 404 that clears is not a failure', async () => {
    let reads = 0;
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA],
      get: () => {
        reads++;
        return Promise.resolve(reads < 3 ? undefined : packument(STABLE, { [STABLE]: false }));
      },
      attempts: 5,
      sleep: noSleep,
    });
    expect(findings).toEqual([]);
    expect(reads).toBe(3);
  });

  it('reports a package still missing after every attempt as an error', async () => {
    const findings = await checkLatestAfterStablePublish({
      version: STABLE,
      publishedPackages: [SCHEMA],
      get: registry({}),
      attempts: 2,
      sleep: noSleep,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'error', packageName: SCHEMA });
    expect(findings[0]?.message).toContain('not on the registry');
  });

  it('refuses a prerelease version: only a stable publish owns latest', async () => {
    await expect(
      checkLatestAfterStablePublish({ version: RC, publishedPackages: [], get: registry({}), attempts: 1, sleep: noSleep }),
    ).rejects.toThrow(/stable/);
  });
});
