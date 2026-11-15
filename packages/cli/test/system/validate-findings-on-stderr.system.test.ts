/**
 * A resources finding is reported on stderr as well as in the document.
 *
 * `vat validate`'s help has said "Progress and validation errors → stderr"
 * since the orchestrator shipped, yet a broken link printed nothing there: the
 * resources lane wrote no human report at all, so its error row existed only
 * in the stdout YAML — on an adopter, inside a 68k-line document. These pin the
 * promise for both verbs that run the resources lane, and pin that stdout stays
 * a parseable document beside it — the same document, whatever stderr says.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { ORCHESTRATOR_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import { CHECK_REPORT_SCHEMA } from '../../src/commands/resources/check-schema.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../src/commands/resources/validate-schema.js';
import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

import { createSuiteContext, executeCli, join, writeTestFile } from './test-common.js';

const context = createSuiteContext('vat-validate-findings-stderr-', import.meta.url);

/**
 * Whether stderr carries the one finding this corpus produces — `docs/a.md`
 * line 3 links a file that does not exist — as EXACTLY one `location:line: error: … [CODE]` line:
 * a lane that printed it twice would read as two broken links.
 */
function namesBrokenLink(stderr: string): boolean {
  return stderr.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('docs/a.md:3') && trimmed.includes(': error: ') && trimmed.endsWith('[LINK_BROKEN_FILE]');
  }).length === 1;
}

/** Whether stderr carries `check`'s finding on `path` as EXACTLY one finding line of `severity`. */
function namesCheck(stderr: string, path: string, severity: string, check: string): boolean {
  return stderr.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(path) && trimmed.includes(`: ${severity}: `) && trimmed.endsWith(`[CUSTOM:${check}]`);
  }).length === 1;
}

/** The document with its timings blanked: the only fields two runs of one tree may differ in. */
function untimed(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      const colon = line.indexOf(': ');
      const key = line.slice(0, colon).trim();
      const timed = colon > 0 && /^\w+$/u.test(key) && (key.endsWith('Ms') || key.endsWith('Secs'));
      return timed ? `${line.slice(0, colon)}: 0` : line;
    })
    .join('\n');
}

let corpus: string;

beforeAll(() => {
  context.setup();
  corpus = join(context.createTempDir(), 'corpus');
  mkdirSyncReal(join(corpus, 'docs'), { recursive: true });
  writeTestFile(
    join(corpus, 'vibe-agent-toolkit.config.yaml'),
    'resources:\n  include:\n    - "docs/**/*.md"\n  checks:\n    no-b:\n      description: b.md must not exist\n'
      + "      sql: SELECT path FROM resource_realizations WHERE path = 'docs/b.md'\n"
      + '    warn-a:\n      description: a.md is flagged\n      severity: warning\n'
      + "      sql: SELECT path FROM resource_realizations WHERE path = 'docs/a.md'\n",
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
    expect(namesCheck(result.stderr, 'docs/b.md', 'error', 'no-b'), result.stderr).toBe(true);
    const report = CHECK_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
    expect(report.findings.map((finding) => finding.code)).toContain('CUSTOM:no-b');
  });

  it('vat validate names the violated check on stderr too — the checks surface reports inside the orchestrator', async () => {
    const result = await run(['validate']);

    expect(namesCheck(result.stderr, 'docs/b.md', 'error', 'no-b'), result.stderr).toBe(true);
  });
});

describe('a warning finding on stderr', () => {
  it('is collapsed by default, and the hint counts it and points at the report', async () => {
    const result = await run(['resources', 'check']);

    expect(namesCheck(result.stderr, 'docs/a.md', 'warning', 'warn-a'), result.stderr).toBe(false);
    expect(result.stderr).toContain('1 warning/info finding(s) not shown — re-run with --verbose, or read the report on stdout');
    const report = CHECK_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
    expect(report.findings.map((finding) => finding.code)).toContain('CUSTOM:warn-a');
  });

  it('is printed by vat validate -v, through its checks phase', async () => {
    const result = await run(['validate', '-v']);

    expect(namesCheck(result.stderr, 'docs/a.md', 'warning', 'warn-a'), result.stderr).toBe(true);
  });

  it('is printed under -v, and then no hint is', async () => {
    const result = await run(['resources', 'check', '-v']);

    expect(namesCheck(result.stderr, 'docs/a.md', 'warning', 'warn-a'), result.stderr).toBe(true);
    expect(result.stderr).not.toContain('not shown');
  });
});

describe('stdout is the document, whatever stderr reports', () => {
  it('is the same document with -v (every finding on stderr) as without (errors only)', async () => {
    const quiet = await run(['resources', 'check']);
    const verbose = await run(['resources', 'check', '-v']);

    expect(verbose.stderr).not.toBe(quiet.stderr);
    expect(untimed(verbose.stdout)).toBe(untimed(quiet.stdout));
  });

  it('--format text puts each finding on stdout and no finding line on stderr', async () => {
    const result = await run(['resources', 'validate', '--format', 'text']);

    expect(result.status, result.stderr).toBe(1);
    expect(namesBrokenLink(result.stdout), result.stdout).toBe(true);
    expect(result.stderr).not.toContain('[LINK_BROKEN_FILE]');
  });
});
