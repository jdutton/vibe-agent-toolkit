/**
 * Population-time conditions reach `validate()` as findings.
 *
 * Two producers, one seam:
 *
 * - **The registry's own MIME resolver.** Two collections typing one file
 *   differently is a config error. The projection lane wrote it as a
 *   `COLLECTION_MIME_CONFLICT` `realization_conditions` row that NO command
 *   read, and the registry lane "stayed silent about it" by its own docstring —
 *   so `vat resources validate` exited 0 and said nothing on either lane. The
 *   registry resolves the type for every admitted file itself, on both lanes,
 *   which makes its own accumulator the lane-independent witness.
 * - **The population source.** A projection-backed enumeration carries the
 *   extent's `realization_conditions` (an unlistable gitignored directory is the
 *   motivating row); the walk has none. Whatever arrives is surfaced with the
 *   row's own code and severity, once per `(code, path)`.
 *
 * Control: one collection ⇒ no finding; a source with no conditions ⇒ none.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CONDITION_WITHOUT_REFERENCE } from '../src/index.js';
import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';
import type { RealizationConditionRow } from '../src/schemas/projection-resources.js';
import type { ValidationIssue } from '../src/schemas/validation-result.js';

const DOC = 'docs/guide.md';
const LOCKED = 'build/locked';
const MIME_CONFLICT = 'COLLECTION_MIME_CONFLICT';
const UNLISTABLE = 'EXTENT_DIRECTORY_UNLISTABLE';

/** Two collections over `docs/**`, agreeing or not on the file's type. */
function configTyping(second: string | undefined): ProjectConfig {
  return {
    version: 1,
    resources: {
      collections: {
        prose: { include: ['docs/**'], mimeType: 'text/markdown' },
        ...(second === undefined ? {} : { data: { include: ['docs/**'], mimeType: second } }),
      },
    },
  };
}

/** Crawl `root` under `config` on the walk lane (no population source) and validate. */
async function validateWalk(root: string, config: ProjectConfig): Promise<ValidationIssue[]> {
  const registry = new ResourceRegistry({ baseDir: root, config });
  await registry.crawl({ baseDir: root, include: ['**/*.md'] });
  return (await registry.validate({ skipGitIgnoreCheck: true })).issues;
}

/** A source that hands back the tree's one file plus whatever conditions it is given. */
function sourceWith(root: string, conditions: readonly RealizationConditionRow[]): ResourcePopulationSource {
  return {
    root,
    enumerate: async () => ({ paths: [safePath.join(root, DOC)], conditions }),
  };
}

function unlistableRow(path: string, severity: RealizationConditionRow['severity'] = 'warning'): RealizationConditionRow {
  return {
    extentId: 'extent:filesystem:test',
    path,
    code: UNLISTABLE,
    severity,
    message: `The gitignored directory '${path}' could not be listed (EACCES)`,
    resourceId: null,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}

describe('ResourceRegistry surfaces population-time conditions', () => {
  const suite = setupAsyncTempDirSuite('resource-registry-population-conditions');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    root = suite.getTempDir();
    mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
    writeFileSync(safePath.join(root, DOC), '# guide\n');
  });

  describe('COLLECTION_MIME_CONFLICT from the registry\'s own resolver (walk lane)', () => {
    it('is an error naming the file and both collections, so the run is status: error', async () => {
      const issues = await validateWalk(root, configTyping('text/plain'));

      const conflicts = issues.filter((issue) => issue.code === MIME_CONFLICT);
      expect(conflicts).toHaveLength(1);
      const [conflict] = conflicts;
      expect(conflict?.severity).toBe('error');
      expect(conflict?.location).toBe(DOC);
      expect(conflict?.message).toContain('"prose"');
      expect(conflict?.message).toContain('"data"');
      expect(conflict?.message).toContain('text/plain');
      expect(conflict?.message).not.toContain(root);
    });

    it('is absent when a single collection types the file (control)', async () => {
      const issues = await validateWalk(root, configTyping(undefined));
      expect(issues.filter((issue) => issue.code === MIME_CONFLICT)).toEqual([]);
    });

    it('is absent when two collections AGREE on the type (control)', async () => {
      const issues = await validateWalk(root, configTyping('text/markdown'));
      expect(issues.filter((issue) => issue.code === MIME_CONFLICT)).toEqual([]);
    });
  });

  describe('conditions handed over by the population source', () => {
    /** Crawl `root` over a source carrying `rows`; the registry is returned before validation. */
    const crawledWith = async (rows: Parameters<typeof sourceWith>[1]): Promise<ResourceRegistry> => {
      const registry = new ResourceRegistry({ baseDir: root });
      await registry.crawl({ baseDir: root, include: ['**/*.md'], populationSource: sourceWith(root, rows) });
      return registry;
    };
    const unlistableIssues = async (registry: ResourceRegistry) => {
      const { issues } = await registry.validate({ skipGitIgnoreCheck: true });
      return issues.filter((issue) => issue.code === UNLISTABLE);
    };

    it('surfaces each row with its own code, severity and root-relative location', async () => {
      const surfaced = await unlistableIssues(await crawledWith([unlistableRow(LOCKED)]));
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]?.severity).toBe('warning');
      expect(surfaced[0]?.location).toBe(LOCKED);
      expect(surfaced[0]?.message).toContain('EACCES');
    });

    it('reports one (code, path) once, however many extents recorded it', async () => {
      const registry = await crawledWith([
        unlistableRow(LOCKED),
        { ...unlistableRow(LOCKED), extentId: 'extent:git:test' },
        unlistableRow('build/other'),
      ]);

      expect((await unlistableIssues(registry)).map((issue) => issue.location)).toEqual([
        LOCKED,
        'build/other',
      ]);
    });

    it('surfaces nothing when the source carries no conditions (control)', async () => {
      expect(await unlistableIssues(await crawledWith([]))).toEqual([]);
    });

    it('clears them with the rest of the registry', async () => {
      const registry = await crawledWith([unlistableRow(LOCKED)]);
      registry.clear();
      expect(await unlistableIssues(registry)).toEqual([]);
    });
  });
});
