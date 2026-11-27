/**
 * A project that declares the `data` instance and routes nothing in the run's extent: the query
 * lane refuses `CONFIG_INVALID` before any statement, and only when a statement names a `data`
 * relation. An `include` glob that matches nothing while other files route is not that refusal: it
 * is the `DATA_INCLUDE_GLOB_INERT` finding `vat resources check` reports. The config is read from
 * disk, so this is the integration tier.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandRefusalError } from '../../src/utils/command-refusal.js';
import { askOverRealized } from '../helpers/data-stage-ask.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A root whose config declares the instance as `data` (YAML flow), with no route of its own by default. */
function declaringRoot(data = '{}'): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-data-examined-nothing-'));
  made.push(root);
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), `version: 1\nresources:\n  extractors:\n    data: ${data}\n`, 'utf8');
  return root;
}

describe('a declared data instance that routes nothing', () => {
  it('refuses CONFIG_INVALID before any statement when a data relation is named', async () => {
    let worked = false;
    const refusal = await askOverRealized({ root: declaringRoot(), realized: [], statements: ['SELECT path FROM data__routes'] }, () => {
      worked = true;
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandRefusalError);
    expect((refusal as CommandRefusalError).refusal).toBe('CONFIG_INVALID');
    expect(worked).toBe(false);
  });

  it('answers a run that names no data relation', async () => {
    const answered = await askOverRealized({ root: declaringRoot(), realized: [], statements: ['SELECT 1 AS x'] }, (ask) => ask('SELECT 1 AS x'));

    expect(answered).toEqual([{ x: 1 }]);
  });
});

describe('a declared include glob that matches nothing, beside files the routing does route', () => {
  it('answers the routed files rather than refusing every data statement', async () => {
    const root = declaringRoot("{ include: ['tools/no-such-waiver.json'] }");
    writeFileSync(safePath.join(root, 'package.json'), '{"name":"a"}', 'utf8');
    const sql = "SELECT path, value FROM data__values WHERE pointer = '/name'";

    const answered = await askOverRealized({ root, realized: [['package.json', 'deferred']], statements: [sql] }, (ask) => ask(sql));

    expect(answered).toEqual([{ path: 'package.json', value: 'a' }]);
  });
});
