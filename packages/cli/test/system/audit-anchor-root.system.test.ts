/**
 * The `vat audit` YAML contract for path anchoring, asserted on the real CLI's
 * real stdout.
 *
 * One run states its base ONCE (`root`) and everything below is relative to it.
 * The companion integration test
 * (`test/integration/audit-anchor-root.integration.test.ts`) proves the same
 * invariant at the pipeline seam; this one proves the serialized document a
 * consumer actually pipes into `yq` honors it.
 *
 * Exhaustive by construction: it walks the parsed document and checks EVERY
 * `path`/`location` string it finds, so a producer added later cannot quietly
 * introduce a second coordinate system.
 */

import * as fs from 'node:fs';

import { isAbsoluteAnyPlatform, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anchorContractViolations, anchorsBelowRoot, pluginManifestLocations } from '../anchor-contract-helpers.js';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

/** Sibling VAT projects with identical internal layout — two governing configs. */
const PROJECTS = ['proj-one', 'proj-two'] as const;

function seedProject(scanRoot: string, project: string): void {
  const projectDir = safePath.join(scanRoot, project);
  const pluginDir = safePath.join(projectDir, 'plugins', 'plugin-x');
  const skillDir = safePath.join(pluginDir, 'skills', 'example');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are controlled in tests
  fs.mkdirSync(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are controlled in tests
  fs.mkdirSync(skillDir, { recursive: true });

  writeTestFile(safePath.join(projectDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
  // No `version` field, so the manifest itself carries findings.
  writeTestFile(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'plugin-x', description: `Plugin X of ${project}` }),
  );
  writeTestFile(
    safePath.join(skillDir, 'SKILL.md'),
    `---
name: example
description: An example skill whose only job is to emit a finding anchored at its own SKILL.md.
---

# Example

See [a missing reference](./missing.md).
`,
  );
}

describe('vat audit — YAML states one root and re-bases every path onto it (system test)', () => {
  let scanRoot: string;
  let parsed: Record<string, unknown>;
  let exitStatus: number | null;

  beforeAll(async () => {
    scanRoot = createTestTempDir('vat-audit-anchor-root-');
    for (const project of PROJECTS) {
      seedProject(scanRoot, project);
    }
    const run = await executeCliAndParseYaml(getBinPath(import.meta.url), ['audit', scanRoot]);
    parsed = run.parsed;
    exitStatus = run.result.status;
  }, 60_000);

  afterAll(() => {
    cleanupTestTempDir(scanRoot);
  });

  it('exits 0 and states the scan root as the only absolute path in the document', () => {
    expect(exitStatus).toBe(0);
    expect(parsed['root']).toBe(toForwardSlash(scanRoot));

    const anchors = anchorsBelowRoot(parsed);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((a) => isAbsoluteAnyPlatform(a.value))).toEqual([]);
  });

  it('makes every path and location joinable against that one root', () => {
    expect(anchorContractViolations(anchorsBelowRoot(parsed), parsed['root'] as string)).toEqual([]);
  });

  it('keeps the two same-named plugins distinguishable — one location per manifest', () => {
    expect(pluginManifestLocations(anchorsBelowRoot(parsed))).toEqual(
      PROJECTS.map((p) => `${p}/plugins/plugin-x/.claude-plugin/plugin.json`),
    );
  });
});
