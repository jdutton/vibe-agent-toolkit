/**
 * The statements that stage the `data` instance are stated in several docs ("a statement naming a
 * `data__*` or `workspace_*` relation ..."). `rowSetDemandOf` and `instanceDemanded` decide it; this ties the docs to it, so
 * a new relation family that stages data cannot leave a doc listing the old families.
 */

import fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { instanceDemanded, rowSetDemandOf } from '../src/projection/data-stage.js';
import { allDerivedSpecs } from '../src/projection/derived-table-registry.js';

const REPOSITORY = safePath.resolve(import.meta.dirname, '..', '..', '..');
const DOCS = [
  'docs/validation-codes.md',
  'docs/architecture/fact-extractors.md',
  'docs/architecture/fact-extractors-hazard-register.md',
  'docs/architecture/fact-extractors-limits.md',
  'packages/cli/docs/resources.md',
];
/** The derived families whose statements stage the instance, by the producer that fills them. */
const STAGING_PRODUCERS = new Set(['data', 'workspace', 'tsconfig', 'tsResolve']);

describe('which statements stage the data instance', () => {
  it('stages the data instance exactly for the data, workspace, tsconfig and tsResolve producers', () => {
    for (const spec of allDerivedSpecs()) {
      const demand = rowSetDemandOf(new Set([spec.name]));
      expect(demand !== undefined && instanceDemanded(demand, 'data'), `${spec.name} (${spec.producer})`).toBe(STAGING_PRODUCERS.has(spec.producer));
    }
  });

  it.each(DOCS)('%s names the tsconfig family wherever it names the workspace family as staging', (doc) => {
    const text = fs.readFileSync(safePath.join(REPOSITORY, doc), 'utf-8');
    for (const match of text.matchAll(/`workspace_\*`/gu)) {
      const around = text.slice(Math.max(0, match.index - 200), match.index + 200);
      expect(around, `${doc}: ${around}`).toContain('`tsconfig_*`');
    }
  });
});
