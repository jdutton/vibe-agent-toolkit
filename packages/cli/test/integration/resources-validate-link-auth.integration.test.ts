/**
 * `resources.linkAuth` must apply whenever it is declared — with or without
 * `resources.collections` beside it.
 *
 * 🪤 The loader used to hand the registry its config only when `collections`
 * was declared, so a project that configured `linkAuth` and nothing else got the
 * anonymous `markdown-link-check` lane for every URL: no rewrite, no token, no
 * `LINK_AUTH_*` code, and nothing said so. A configured feature that checks
 * nothing and reports success is the green-without-running shape, so these
 * tests assert that the authenticated lane RAN — a request arrived at the
 * rewritten host carrying the token, or the lane's own code family fired —
 * never merely that the run produced no error.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);

const TOKEN_ENV = 'VAT_TEST_LINK_AUTH_TOKEN';
const TOKEN = 'ghp_test_token_for_link_auth_lane';
/** A host that resolves nowhere: the anonymous lane can only fail on it. */
const CLAIMED_HOST = 'github.example';
/**
 * The provider's `when`: every URL on the claimed host, path captured. The dot
 * is doubly escaped because the pattern lands inside a YAML double-quoted
 * string, which unescapes once.
 */
const CLAIMED_HOST_PATTERN = CLAIMED_HOST.replaceAll('.', String.raw`\\.`);
const CLAIMED_WHEN = `^https://${CLAIMED_HOST_PATTERN}/(?<path>.+)$`;

/**
 * A stand-in for the provider's API origin that records every request it sees.
 * Answers 200 so a run that reaches it has nothing left to report — the
 * evidence is the request itself, not a finding.
 */
async function startRecordingServer(): Promise<{ server: Server; origin: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    seen.push(request);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}`, seen };
}

/**
 * A project declaring `linkAuth` and NOT `collections`. The provider claims
 * `github.example` and rewrites every URL on it to `origin`, so an authenticated
 * fetch lands on the recording server and an anonymous one lands on DNS.
 */
function writeLinkAuthOnlyProject(tempDir: string, origin: string): void {
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    [
      'version: 1',
      'resources:',
      '  include:',
      '    - "docs/**/*.md"',
      '  linkAuth:',
      '    providers:',
      `      - match: { host: "${CLAIMED_HOST}" }`,
      '        rewrite:',
      `          - when: "${CLAIMED_WHEN}"`,
      `            to: "${origin}/\${path}"`,
      '        auth: { headers: { Authorization: "Bearer ${token}" } }',
      `        token: [{ env: ${TOKEN_ENV} }]`,
      '        check: { method: GET, aliveStatus: [200], notFoundMeaning: ambiguous }',
      '',
    ].join('\n'),
  );
  mkdirSyncReal(safePath.join(tempDir, 'docs'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'docs', 'a.md'),
    `# A\n\nSee [one](https://${CLAIMED_HOST}/acme/widgets/blob/main/docs/api.md).\n`,
  );
}

const VALIDATE_ARGS = ['resources', 'validate', '--no-cache', '--check-external-urls', '--format', 'json'];

describe('vat resources validate honours resources.linkAuth without resources.collections (integration)', () => {
  let tempDir: string;
  let recording: Awaited<ReturnType<typeof startRecordingServer>>;

  beforeEach(async () => {
    tempDir = createTestTempDir('vat-link-auth-no-collections-');
    recording = await startRecordingServer();
    writeLinkAuthOnlyProject(tempDir, recording.origin);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => recording.server.close(() => resolve()));
    cleanupTestTempDir(tempDir);
  });

  it('sends the authenticated request to the rewritten host when a token resolves', async () => {
    const { result, parsed } = await executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir], {
      cwd: tempDir,
      env: { [TOKEN_ENV]: TOKEN },
    });

    // The lane's own footprint: a request at the provider's origin carrying the
    // rendered header. The anonymous lane never reaches this server at all.
    expect(recording.seen.map((request) => request.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(recording.seen[0]?.url).toBe('/acme/widgets/blob/main/docs/api.md');
    // And with the server answering 200 there is nothing to report.
    expect(parsed['issueSummary'] ?? {}).toEqual({});
    expect(result.status).toBe(0);
  });

  it('reports the link as LINK_AUTH_UNVERIFIED when no token source resolves', async () => {
    const { parsed } = await executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir], {
      cwd: tempDir,
      env: { [TOKEN_ENV]: '' },
    });

    // The code family that only the authenticated lane emits. Without the
    // config the run would instead say `EXTERNAL_URL_ERROR` (DNS on the
    // original host) — a different lane answering a different question.
    expect(parsed['issueSummary']).toEqual({ LINK_AUTH_UNVERIFIED: 1 });
    expect(recording.seen).toHaveLength(0);
  });
});

/**
 * A provider that cannot compile is a config error: the run refuses by name
 * (exit 2) instead of degrading each of that host's links to a warning.
 *
 * 🪤 The degraded shape was `LINK_AUTH_UNVERIFIED` per link — and with the
 * registry-suggested `severity.LINK_AUTH_UNVERIFIED: ignore` in place (the
 * documented setting for a token-less CI lane) the run printed
 * `status: success, linksChecked: 2` having fetched nothing. The override is
 * declared here on purpose: it must not be able to reach a config defect.
 */
describe('vat resources validate refuses a linkAuth provider that cannot compile (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-link-auth-bad-provider-');
    writeTestFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      [
        'version: 1',
        'resources:',
        '  include:',
        '    - "docs/**/*.md"',
        '  validation:',
        '    severity:',
        '      LINK_AUTH_UNVERIFIED: ignore',
        '  collections:',
        '    docs:',
        '      path: docs',
        '      include: ["**/*.md"]',
        '  linkAuth:',
        '    providers:',
        `      - match: { host: "${CLAIMED_HOST}" }`,
        '        rewrite:',
        '          - when: "([unclosed"',
        '            to: "https://api.example/x"',
        '        auth: { headers: { Authorization: "Bearer ${token}" } }',
        `        token: [{ env: ${TOKEN_ENV} }]`,
        '        check: { method: GET, aliveStatus: [200], notFoundMeaning: ambiguous }',
        '',
      ].join('\n'),
    );
    mkdirSyncReal(safePath.join(tempDir, 'docs'), { recursive: true });
    writeTestFile(
      safePath.join(tempDir, 'docs', 'a.md'),
      `# A\n\n[one](https://${CLAIMED_HOST}/a/b) and [two](https://${CLAIMED_HOST}/c/d).\n`,
    );
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('exits 2 naming the provider and field, and checks no link', async () => {
    const { result, parsed } = await executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir], {
      cwd: tempDir,
      env: { [TOKEN_ENV]: TOKEN },
    });

    expect(result.status).toBe(2);
    expect(parsed['status']).toBe('error');
    expect(String(parsed['error'])).toMatch(/resources\.linkAuth providers\[0\]/);
    expect(String(parsed['error'])).toMatch(/rewrite\[0\]\.when/);
    // The tell of the old behaviour: a count of links "checked" that nothing
    // had fetched. A refused run reports no such count at all.
    expect(parsed['linksChecked']).toBeUndefined();
  });
});
