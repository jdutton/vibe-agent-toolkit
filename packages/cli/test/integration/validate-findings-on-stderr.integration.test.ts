/**
 * A resources finding is reported on stderr as well as in the document.
 *
 * `vat validate`'s help has said "Progress and validation errors → stderr"
 * since the orchestrator shipped, yet a broken link printed nothing there: the
 * resources lane wrote no human report at all, so its error row existed only
 * in the stdout YAML — on an adopter, inside a 68k-line document. These pin the
 * promise for both verbs that run the resources lane, and pin that stdout stays
 * a parseable document beside it.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { ORCHESTRATOR_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import { CHECK_REPORT_SCHEMA } from '../../src/commands/resources/check-schema.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../src/commands/resources/validate-schema.js';
import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-validate-findings-stderr-', import.meta.url);

/**
 * Whether stderr carries the one finding this corpus produces — `docs/a.md`
 * line 3 links a file that does not exist — as one `location:line: error: … [CODE]` line.
 */
function namesBrokenLink(stderr: string): boolean {
  return stderr.split('\n').some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('docs/a.md:3') && trimmed.includes(': error: ') && trimmed.endsWith('[LINK_BROKEN_FILE]');
  });
}

let corpus: string;

beforeAll(() => {
  context.setup();
  corpus = join(context.createTempDir(), 'corpus');
  mkdirSyncReal(join(corpus, 'docs'), { recursive: true });
  writeTestFile(
    join(corpus, 'vibe-agent-toolkit.config.yaml'),
    'resources:\n  include:\n    - "docs/**/*.md"\n  checks:\n    no-b:\n      description: b.md must not exist\n'
      + "      sql: SELECT path FROM resource_realizations WHERE path = 'docs/b.md'\n",
  );
  writeTestFile(join(corpus, 'docs', 'a.md'), '# A\n\nSee [missing](./nope.md).\n');
  writeTestFile(join(corpus, 'docs', 'b.md'), '# B\n\nFine.\n');
  commitTestFixture(corpus);
});

afterAll(context.cleanup);

/** Run a verb in the corpus with a private projection store. */
function run(args: string[]): ReturnType<typeof executeCli> {
  return executeCli(context.binPath, args, {
    cwd: corpus,
    env: { [PROJECTION_STORE_DIR_ENV]: context.createTempDir() },
  });
}

describe('resources findings on stderr', () => {
  it('vat validate names the broken link on stderr and still publishes it in the document', async () => {
    const result = await run(['validate']);

    expect(result.status, result.stderr).toBe(1);
    expect(namesBrokenLink(result.stderr), result.stderr).toBe(true);
    const report = ORCHESTRATOR_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
    expect(report.findings.map((finding) => finding.code)).toContain('LINK_BROKEN_FILE');
  });

  it('vat resources validate names the broken link on stderr and still publishes it in the document', async () => {
    const result = await run(['resources', 'validate']);

    expect(result.status, result.stderr).toBe(1);
    expect(namesBrokenLink(result.stderr), result.stderr).toBe(true);
    const report = RESOURCES_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
    expect(report.findings.map((finding) => finding.code)).toEqual(['LINK_BROKEN_FILE']);
  });

  it('vat resources check names the violated check on stderr and still publishes it in the document', async () => {
    const result = await run(['resources', 'check']);

    expect(result.status, result.stderr).toBe(1);
    const named = result.stderr.split('\n').some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('docs/b.md') && trimmed.includes(': error: ') && trimmed.endsWith('[CUSTOM:no-b]');
    });
    expect(named, result.stderr).toBe(true);
    const report = CHECK_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
    expect(report.findings.map((finding) => finding.code)).toContain('CUSTOM:no-b');
  });
});
