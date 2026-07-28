/**
 * `vat resources validate` honors deferred `files:` artifacts.
 *
 * Reproduces the doc's minimal repro exactly: one skill, one `files:` entry
 * (`source: build-output/generated-ref.md`, `dest: cli-reference.md`), one
 * SKILL.md link to `cli-reference.md`, source file present, dest not
 * materialized. `vat skills validate` already reports this link as an
 * info-severity `LINK_DEFERRED_ARTIFACT`. Before this fix, `vat resources
 * validate` — which knows nothing about `skills.config.<name>.files` — reported
 * the SAME link as error-severity `LINK_BROKEN_FILE` (exit 1). The two lanes
 * must now agree: zero errors, exactly one `LINK_DEFERRED_ARTIFACT`.
 *
 * The second case is the boundary of that agreement: an entry whose source sits
 * in the skill's DECLARED TEST INPUT is dropped by the packager, so its dest is
 * never written and a link to it must NOT be deferred here either — it is a real
 * broken link, exactly as the build reports it.
 */
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);

const SKILL_NAME = 'my-skill';
const SOURCE_FILE = 'build-output/generated-ref.md';
const DEST_FILE = 'cli-reference.md';

/** Flattened `{code, severity}` view of the parsed YAML output's grouped-by-file issues. */
interface FlatIssue {
  code: string;
  severity: string;
}

function flattenIssues(parsed: Record<string, unknown>): FlatIssue[] {
  const files = (parsed['errors'] ?? []) as Array<{
    errors: Array<{ code: string; severity: string }>;
  }>;
  return files.flatMap((f) => f.errors.map((e) => ({ code: e.code, severity: e.severity })));
}

interface FixtureOptions {
  /** `files:` source path, project-root relative. Written to disk (the dest never is). */
  source: string;
  /** Extra per-skill config lines, indented to sit under `skills.config.<name>`. */
  extraSkillConfig?: string;
}

/**
 * One skill that links `DEST_FILE` (never materialized) and declares a `files:`
 * entry producing it from `options.source` (which IS materialized).
 */
function writeFixture(tempDir: string, options: FixtureOptions): void {
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1
skills:
  include:
    - "skills/*/SKILL.md"
  config:
    ${SKILL_NAME}:
${options.extraSkillConfig ?? ''}      files:
        - source: ${options.source}
          dest: ${DEST_FILE}
`,
  );

  mkdirSyncReal(safePath.join(tempDir, 'skills', SKILL_NAME), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'skills', SKILL_NAME, 'SKILL.md'),
    `---
name: ${SKILL_NAME}
description: Synthetic skill for the deferred-artifact minimal repro.
---

# ${SKILL_NAME}

See the [CLI reference](./${DEST_FILE}) for details.
`,
  );

  mkdirSyncReal(safePath.join(tempDir, dirname(options.source)), { recursive: true });
  writeTestFile(safePath.join(tempDir, options.source), '# Generated CLI reference\n');

  // Deliberately do NOT create skills/<name>/cli-reference.md — the dest is
  // not yet materialized, simulating pre-build state.
}

describe('vat resources validate + deferred files: artifacts (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('reports zero errors and one LINK_DEFERRED_ARTIFACT for a files:-declared link whose dest is not yet materialized', async () => {
    tempDir = createTestTempDir('vat-resources-validate-deferred-');
    writeFixture(tempDir, { source: SOURCE_FILE });

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources', 'validate', tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.errorsFound).toBe(0);

    const issues = flattenIssues(parsed);
    const deferred = issues.filter((i) => i.code === 'LINK_DEFERRED_ARTIFACT');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.severity).toBe('info');
    expect(issues.some((i) => i.code === 'LINK_BROKEN_FILE')).toBe(false);
  });

  it('does NOT defer a dest whose source is declared test input — the packager drops that entry, so the link is broken', async () => {
    tempDir = createTestTempDir('vat-resources-validate-testinput-');
    writeFixture(tempDir, {
      source: `skills/${SKILL_NAME}/evals/evals.json`,
      extraSkillConfig: '      test:\n        evals: evals/evals.json\n',
    });

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources', 'validate', tempDir,
    ]);

    // Same verdict the packager and `vat skills validate` reach for this input:
    // nothing will write the dest, so linking it is an author error.
    expect(result.status).toBe(1);
    const issues = flattenIssues(parsed);
    expect(issues.some((i) => i.code === 'LINK_BROKEN_FILE')).toBe(true);
    expect(issues.some((i) => i.code === 'LINK_DEFERRED_ARTIFACT')).toBe(false);
  });
});
