/**
 * Shared fixture for the integration suites that spawn `pre-publish-check`:
 * a git tree with a bare local `origin` (so the remote-tag check never touches
 * a network) and a loopback stand-in for the npm registry (so the registry
 * guard never does either).
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';

import { cleanupTestTempDir, createTestTempDir } from '../test-helpers.js';

const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '..', '..');
const SCRIPT = safePath.join(PACKAGE_DIR, 'src', 'pre-publish-check.ts');

function write(root: string, relative: string, content: string): void {
  const absolute = safePath.join(root, relative);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/** A published (non-private) package every earlier pre-publish check passes over. */
export function publishedManifest(name: string, version: string): string {
  return JSON.stringify({
    name,
    version,
    files: ['README.md'],
    repository: { type: 'git', url: 'https://example.invalid/repo.git' },
    author: 'Test',
    license: 'MIT',
  });
}

/** Every temp directory and server a case made, released by {@link releaseFixtures}. */
const dirs: string[] = [];
const servers: Server[] = [];

/**
 * A tree every earlier check passes over: a private umbrella package carrying
 * `version`, a CHANGELOG whose section for it has content, an empty known-defects
 * register, and `extra` files (which may replace any of those)
 * (repo-relative path to text), committed, with a bare `origin`.
 */
export function fixtureTree(version: string, extra: Record<string, string>): string {
  const root = createTestTempDir({ prefix: 'pre-publish-' });
  const remote = createTestTempDir({ prefix: 'pre-publish-origin-' });
  dirs.push(root, remote);
  write(root, 'package.json', JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }));
  write(
    root,
    'packages/vibe-agent-toolkit/package.json',
    JSON.stringify({ name: 'vibe-agent-toolkit', version, private: true }),
  );
  write(root, 'CHANGELOG.md', `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-01-01\n\n- A change.\n`);
  write(root, 'docs/contributing/known-defects.md', '# Known defects\n');
  for (const [relative, content] of Object.entries(extra)) write(root, relative, content);

  const git = (...args: string[]): void => {
    runGitOrThrow(args, { cwd: root });
  };
  git('init', '-b', 'main', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test User');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  runGitOrThrow(['init', '--bare', '--quiet', remote], { cwd: root });
  git('remote', 'add', 'origin', remote);
  return root;
}

/** A loopback registry's base URL, and every request URL it has served (query included). */
interface FakeRegistry {
  readonly url: string;
  readonly requests: string[];
}

/**
 * A loopback registry answering GETs from `docs` (request path, query ignored,
 * to JSON body); any other path is a 404.
 */
export async function fakeRegistry(docs: Record<string, unknown>): Promise<FakeRegistry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    const body = docs[url.split('?')[0] ?? ''];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    response.end(body === undefined ? '{}' : JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A script's exit status and its stdout and stderr, interleaved. */
interface ScriptRun {
  status: number | null;
  stdout: string;
}

/**
 * Run `pre-publish-check --release-readiness` over `root` against `registry`.
 */
export function prePublish(root: string, registry: string): Promise<ScriptRun> {
  return runDevTool('pre-publish-check', [
    '--root',
    root,
    '--skip-git-checks',
    '--release-readiness',
    '--registry',
    registry,
  ]);
}

/**
 * Run `src/<tool>.ts` with `args`. Asynchronous on purpose: a blocking spawn
 * would starve the loopback registry served from this same process.
 */
export function runDevTool(tool: string, args: readonly string[]): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const script = safePath.join(PACKAGE_DIR, 'src', `${tool}.ts`);
    const child = spawn(NODE_EXECUTABLE, ['--import', 'tsx', script, ...args], { cwd: PACKAGE_DIR });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: output }));
  });
}

/** The script's path and package dir, for a case that spawns it with other arguments. */
export const PRE_PUBLISH = { script: SCRIPT, packageDir: PACKAGE_DIR };

/** Close every server and remove every temp directory the cases made. */
export async function releaseFixtures(): Promise<void> {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
}
