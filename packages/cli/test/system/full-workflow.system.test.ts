import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { it, beforeAll, afterAll } from 'vitest';

import { RESOURCES_SCAN_REPORT_SCHEMA } from '../../src/commands/resources/scan-schema.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../src/commands/resources/validate-schema.js';

import { describe, executeCliAndParseYaml, expect, fs, getBinPath, safePath, spawnSync } from './test-common.js';
import {
  createTestTempDir,
  executeCli,
  executeScanAndParse,
  executeValidateAndParse,
  setupTestProject,
} from './test-helpers/index.js';

/**
 * Start a hermetic loopback HTTP server that answers every request with 404.
 *
 * Used to produce a deterministic DEAD external URL (HTTP 4xx → EXTERNAL_URL_DEAD)
 * without depending on the real network. Returns the server and its base URL.
 */
async function startDeadUrlServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Write a project with one markdown doc that links to a dead loopback URL.
 * `validationConfig` is spliced into resources.validation when provided so a
 * single helper covers both the default-warning and promoted-error cases.
 */
function setupDeadUrlProject(
  tempDir: string,
  baseUrl: string,
  name: string,
  validationConfig: string
): string {
  const config = `version: 1
resources:
  include:
    - "docs/**/*.md"
${validationConfig}`;
  const projectDir = setupTestProject(tempDir, { name, config, withDocs: true });
  fs.writeFileSync(
    safePath.join(projectDir, 'docs', 'dead.md'),
    `# Dead link\n\n[gone](${baseUrl}/dead)\n`
  );
  return projectDir;
}

/**
 * The first EXTERNAL_URL_DEAD finding of a `resources validate` report (or
 * undefined), read through the published schema. Shared by the default-warning
 * and promoted-error severity cases so the find logic lives in exactly one
 * place — the thing under test is which severity a given CODE resolved to.
 */
function findExternalUrlDeadFinding(
  parsed: Record<string, unknown>
): { code: string; severity: string } | undefined {
  return RESOURCES_VALIDATE_REPORT_SCHEMA.parse(parsed).findings.find(e => e.code === 'EXTERNAL_URL_DEAD');
}

const binPath = getBinPath(import.meta.url);

describe('Full CLI workflow (system test)', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-system-test-');

    const configContent = `version: 1
resources:
  include:
    - "docs/**/*.md"
  exclude:
    - "node_modules/**"
`;
    projectDir = setupTestProject(tempDir, {
      name: 'test-project',
      config: configContent,
      withDocs: true,
    });

    const docsDir = safePath.join(projectDir, 'docs');
    fs.writeFileSync(
      safePath.join(docsDir, 'README.md'),
      '# Documentation\n\n[Guide](./guide.md)\n[API](#api)\n\n## API\n\nAPI docs here.'
    );

    fs.writeFileSync(
      safePath.join(docsDir, 'guide.md'),
      '# Guide\n\n[Back to README](./README.md)'
    );

    fs.writeFileSync(
      safePath.join(docsDir, 'broken.md'),
      '# Broken\n\n[Missing](./missing.md)\n[Bad anchor](./README.md#nonexistent)'
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should scan project and find all resources', () => {
    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(3); // README, guide, broken
  });

  it('should validate and detect broken links', () => {
    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    expect(result.status).toBe(1); // Validation failed
    const report = RESOURCES_VALIDATE_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('findings');
    expect(report.summary.errors).toBe(2); // missing.md + #nonexistent

    // The same findings as compiler-style lines under --format text.
    const textResult = executeCli(binPath, ['resources', 'validate', '--format', 'text'], { cwd: projectDir });
    expect(textResult.stdout).toContain('broken.md');
    expect(textResult.stdout).toContain('missing.md');
    expect(textResult.stdout).toContain('#nonexistent');
  });

  it('should validate successfully after fixing links', () => {
    // Fix broken.md
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/broken.md'),
      '# Fixed\n\n[Back](./README.md#api)'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(RESOURCES_VALIDATE_REPORT_SCHEMA.parse(parsed).status).toBe('ok');
  });

  it('should show version with context in dev mode', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_CONTEXT: 'dev', VAT_CONTEXT_PATH: '/test/path' },
    });

    expect(result.status).toBe(0);
    // Bounded digit runs and an explicit empty alternative (rather than `?`) so
    // the pattern cannot backtrack super-linearly. `(?:X|)` is exactly `(?:X)?`.
    expect(result.stdout).toMatch(/\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[a-z0-9.]{1,40}|)-dev \(\/test\/path\)/);
  });

  it('should show comprehensive help with --help --verbose', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, '--help', '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# vat - Vibe Agent Toolkit CLI');
    expect(result.stdout).toContain('resources');
    // Near the END of docs/index.md: the verbose-help paths write and then
    // process.exit(0) immediately, so an ASYNC stdout write to a pipe used to be
    // truncated at the first pipe buffer (~8 KB on macOS) and lose the tail.
    // See writeHelpSync in src/utils/help-loader.ts.
    expect(result.stdout).toContain('Exit Code Summary');
  });

  it('should not truncate a section verbose-help document larger than one pipe buffer', () => {
    // docs/rag.md is ~13 KB and section help goes through a DIFFERENT writer than
    // root help, so it needs its own guard against the same truncation.
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'rag', '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# vat rag');
    expect(result.stdout).toContain('## More Information');
    expect(result.stdout).toContain('https://lancedb.com');
  });

  it('should show resources verbose help', () => {
    const result = spawnSync(NODE_EXECUTABLE, [binPath, 'resources', '--help', '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vat resources');
    expect(result.stdout).toContain('scan');
    expect(result.stdout).toContain('validate');
  });

  it('should not check external URLs by default (no --check-external-urls)', () => {
    // Create a file with only external URLs (no broken internal links).
    fs.writeFileSync(
      safePath.join(projectDir, 'docs/external.md'),
      '# External Links\n\n[GitHub](https://github.com)\n[NPM](https://npmjs.com)\n[Docs](https://example.com/docs)'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Without the flag, external URLs are never fetched → nothing found.
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('ok');
    expect(parsed.findings).toEqual([]);
  });
});

/**
 * Dead external URL → EXTERNAL_URL_DEAD. By default it is warning-severity and
 * therefore NON-FATAL (exit 0); promoting it to error via config flips exit to 1.
 *
 * Hermetic: a loopback HTTP server returns 404 so no real network is touched.
 */
describe('Dead external URL severity → exit code (system test)', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tempDir = createTestTempDir('vat-external-url-severity-test-');
    ({ server, baseUrl } = await startDeadUrlServer());
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports EXTERNAL_URL_DEAD as a warning and exits 0 (non-fatal by default)', async () => {
    const projectDir = setupDeadUrlProject(tempDir, baseUrl, 'default-warning', '');

    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['resources', 'validate', '--check-external-urls', '--no-cache'],
      { cwd: projectDir }
    );

    // Default severity is warning → does NOT flip the exit code.
    expect(result.status).toBe(0);

    // But the finding is still surfaced as a warning-severity EXTERNAL_URL_DEAD.
    const dead = findExternalUrlDeadFinding(parsed);
    expect(dead).toBeDefined();
    expect(dead?.severity).toBe('warning');
  });

  it('exits 1 when EXTERNAL_URL_DEAD is promoted to error via config', async () => {
    const projectDir = setupDeadUrlProject(
      tempDir,
      baseUrl,
      'promoted-error',
      `  validation:
    severity:
      EXTERNAL_URL_DEAD: error
`
    );

    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['resources', 'validate', '--check-external-urls', '--no-cache'],
      { cwd: projectDir }
    );

    // Promoted to error → fatal exit.
    expect(result.status).toBe(1);
    expect(parsed.status).toBe('findings');

    const dead = findExternalUrlDeadFinding(parsed);
    expect(dead).toBeDefined();
    expect(dead?.severity).toBe('error');
  });
});
