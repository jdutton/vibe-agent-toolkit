/**
 * The npm registry guard inside `pre-publish-check --release-readiness`, end to
 * end: `--registry` reaches the guard, an RC's prerelease `latest` is a warning
 * that does not fail, and a removed package that is not deprecated fails with
 * the `npm deprecate` command. The decisions are unit-tested in
 * `npm-registry-guard.test.ts`; this file pins the wiring.
 *
 * Integration tier: a loopback registry stands in for npm, so nothing touches a network.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { afterEach, describe, expect, it } from 'vitest';

import { packumentPath, SCOPE_LISTING_PATH } from '../../src/npm-registry-guard.js';

import {
  fakeRegistry,
  fixtureTree,
  prePublish,
  publishedManifest,
  releaseFixtures,
  runDevTool,
} from './pre-publish-fixture.js';

const SCHEMA = '@vibe-agent-toolkit/schema';
const REMOVED = '@vibe-agent-toolkit/agent-runtime';
const RC = '1.0.0-rc.1';
const STABLE = '1.0.0';

function packument(latest: string, deprecated: boolean): unknown {
  return { 'dist-tags': { latest }, versions: { [latest]: deprecated ? { deprecated: 'Removed.' } : {} } };
}

/** A tree at `version` publishing the schema package, against a registry holding `docs`. */
async function run(version: string, docs: Record<string, unknown>): Promise<{ status: number | null; stdout: string }> {
  const root = fixtureTree(version, { 'packages/schema/package.json': publishedManifest(SCHEMA, version) });
  return prePublish(root, await fakeRegistry(docs));
}

describe('pre-publish-check --release-readiness: the npm registry guard', () => {
  afterEach(releaseFixtures);

  it('warns on an RC when a published package\'s latest is a prerelease, and passes', async () => {
    const { status, stdout } = await run(RC, {
      [SCOPE_LISTING_PATH]: { [SCHEMA]: 'write' },
      [packumentPath(SCHEMA)]: packument('0.9.0-rc.3', false),
    });
    expect(stdout).toContain(`${SCHEMA} has latest = 0.9.0-rc.3`);
    expect(status).toBe(ExitCode.OK);
  });

  it('fails a removed package that is not deprecated, printing the npm deprecate command', async () => {
    const { status, stdout } = await run(RC, {
      [SCOPE_LISTING_PATH]: { [SCHEMA]: 'write', [REMOVED]: 'write' },
      [packumentPath(SCHEMA)]: packument('0.9.0', false),
      [packumentPath(REMOVED)]: packument('0.9.0', false),
    });
    expect(stdout).toContain(`npm deprecate ${REMOVED} "`);
    expect(status).toBe(ExitCode.FINDINGS);
  });

  it('passes once the removed package is deprecated', async () => {
    const { status } = await run(RC, {
      [SCOPE_LISTING_PATH]: { [SCHEMA]: 'write', [REMOVED]: 'write' },
      [packumentPath(SCHEMA)]: packument('0.9.0', false),
      [packumentPath(REMOVED)]: packument('0.9.0', true),
    });
    expect(status).toBe(ExitCode.OK);
  });

  it('refuses with ERROR when the registry cannot be read, rather than passing', async () => {
    const { status, stdout } = await run(RC, {});
    expect(stdout).toContain('scope listing');
    expect(status).toBe(ExitCode.ERROR);
  });
});

/** The guard over a tree at `STABLE` publishing the schema package, against a registry whose schema latest is `latest`. */
async function afterPublish(latest: string): Promise<{ status: number | null; stdout: string }> {
  const root = fixtureTree(STABLE, { 'packages/schema/package.json': publishedManifest(SCHEMA, STABLE) });
  const registry = await fakeRegistry({ [packumentPath(SCHEMA)]: packument(latest, false) });
  return runDevTool('npm-registry-guard', [
    '--after-stable-publish',
    STABLE,
    '--root',
    root,
    '--registry',
    registry,
    '--attempts',
    '1',
  ]);
}

describe('npm-registry-guard --after-stable-publish', () => {
  afterEach(releaseFixtures);

  it('passes when every published package\'s latest is the version just released', async () => {
    const { status } = await afterPublish(STABLE);
    expect(status).toBe(ExitCode.OK);
  });

  it('fails with the npm dist-tag command when latest is left behind', async () => {
    const { status, stdout } = await afterPublish('0.9.0-rc.3');
    expect(stdout).toContain(`npm dist-tag add ${SCHEMA}@${STABLE} latest`);
    expect(status).toBe(ExitCode.FINDINGS);
  });
});
