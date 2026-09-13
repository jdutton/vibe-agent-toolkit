/**
 * A manifest the plugin extent cannot read says WHY on its condition row.
 *
 * `MANIFEST_UNREADABLE` used to be one message for three different facts — the
 * file is not JSON, the OS refused it, the JSON failed the schema — so the
 * reader of a projection could not tell a typo from a permission bit. The row
 * still says the extent holds only what convention supplies; it now also
 * carries the reason, and the two reasons below are distinguishable in it.
 */

import { writeFileSync } from 'node:fs';

import {
  ContributorRegistry,
  DISCARD_BLOB_POPULATION,
  FilesystemExtentContributor,
  populate,
  type Projection,
} from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { refuseSyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MANIFEST_UNREADABLE, PluginExtentContributor } from '../src/projection/plugin-extent.js';


const suite = setupSyncTempDirSuite('vat-extent-unreadable-');
const MANIFEST_REL = 'plug/.claude-plugin/plugin.json';

/** A root holding one plugin whose manifest is `manifest`, returned with the manifest's absolute path. */
function plantPlugin(root: string, manifest: string): string {
  const manifestPath = safePath.join(root, MANIFEST_REL);
  mkdirSyncReal(safePath.join(root, 'plug', '.claude-plugin'), { recursive: true });
  mkdirSyncReal(safePath.join(root, 'plug', 'skills', 'x'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(safePath.join(root, 'plug', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: fixture\n---\n# x\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
  writeFileSync(manifestPath, manifest);
  return manifestPath;
}

async function project(root: string): Promise<Projection> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new PluginExtentContributor());
  return populate({ root, registry, onBlobPopulation: DISCARD_BLOB_POPULATION });
}

/** The `MANIFEST_UNREADABLE` messages recorded against the planted manifest. */
function unreadableMessages(projection: Projection): string[] {
  return projection.realizationConditions
    .filter((row) => row.code === MANIFEST_UNREADABLE && row.path === MANIFEST_REL)
    .map((row) => row.message);
}

describe('the MANIFEST_UNREADABLE condition names its reason', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('says the manifest is not JSON when it is not', async () => {
    const root = suite.getTempDir();
    plantPlugin(root, '{ "name": ');

    const messages = unreadableMessages(await project(root));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/could not be read as a .* manifest \(not valid JSON: .*\)/s);
    expect(messages[0]).toContain('holds only what convention supplies');
  });

  it('says the OS refused the manifest when it did — not that the manifest is malformed', async () => {
    const root = suite.getTempDir();
    const manifestPath = plantPlugin(root, JSON.stringify({ name: 'plug', version: '1.0.0' }));

    const restore = refuseSyncFs('readFileSync', manifestPath, 'EACCES');
    let messages: string[];
    try {
      messages = unreadableMessages(await project(root));
    } finally {
      restore();
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/could not be read as a .* manifest \(EACCES/);
    expect(messages[0]).not.toContain('JSON');
  });

  it('records no condition for a manifest it can read (the positive case)', async () => {
    const root = suite.getTempDir();
    plantPlugin(root, JSON.stringify({ name: 'plug', version: '1.0.0' }));

    expect(unreadableMessages(await project(root))).toEqual([]);
  });
});
