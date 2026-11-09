/**
 * The test-tree scan on this repository: it finds the reaches the repository
 * is known to have — so a spelling the scan stops recognising is a red here
 * rather than a silently smaller population — and nothing it cannot resolve.
 * Integration tier: it parses every package's test tree, so the unit task
 * would need every one as an input.
 */

import { describe, expect, it } from 'vitest';

import { workingTreePackageFiles } from '../../src/built-output-edges.js';
import { scanTestTree } from '../../src/built-output-scan.js';
import { PROJECT_ROOT } from '../../src/common.js';
import { readWorkspaceGraph } from '../../src/workspace-graph.js';

describe('scanTestTree on the real tree (integration)', () => {
  const result = scanTestTree(PROJECT_ROOT, readWorkspaceGraph(PROJECT_ROOT), workingTreePackageFiles(PROJECT_ROOT));
  const reaches = result.reaches.map(({ site, dir, subpath }) => ({ site, dir, subpath }));

  it('finds the reaches this repository is known to have', () => {
    expect(reaches).toEqual(
      expect.arrayContaining([
        { site: 'packages/rag-lancedb/test/system/cli-dogfooding.system.test.ts', dir: 'cli', subpath: 'dist/bin.js' },
        { site: 'packages/resources/test/system/external-url-validation.system.test.ts', dir: 'cli', subpath: 'dist/bin/vat.js' },
        { site: 'packages/resources/test/integration/git-crawl-io-cost.integration.test.ts', dir: 'lab', subpath: 'dist/facets/io/counter.cjs' },
        { site: 'packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts', dir: 'vat-development-agents', subpath: 'dist/skills' },
        { site: 'packages/vat-development-agents/test/system/packaged-output-drift.system.test.ts', dir: 'vat-example-cat-agents', subpath: 'dist/skills' },
        { site: 'packages/cli/test/system/test-common.ts', dir: 'cli', subpath: 'dist/bin.js' },
        { site: 'packages/cli/test/system/test-common.ts', dir: 'utils', subpath: 'dist/testing/fault-fs-preload.js' },
      ]),
    );
  });

  it('reads no reach in plain test data, and leaves no dist path unresolved', () => {
    expect(reaches.filter((reach) => reach.site === 'packages/discovery/test/pattern-filter.test.ts')).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
