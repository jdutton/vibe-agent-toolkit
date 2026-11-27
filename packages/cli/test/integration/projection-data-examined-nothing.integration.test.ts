/**
 * A project that declares the `data` instance and routes nothing in the run's extent: the query
 * lane refuses `CONFIG_INVALID` before any statement, and only when a statement names a `data`
 * relation. The config is read from disk, so this is the integration tier.
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

/** A root whose config declares the instance with no route of its own. */
function declaringRoot(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-data-examined-nothing-'));
  made.push(root);
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), 'version: 1\nresources:\n  extractors:\n    data: {}\n', 'utf8');
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
