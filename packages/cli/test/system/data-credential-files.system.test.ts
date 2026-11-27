/**
 * A credentials file is never stored as data rows, whatever `resources.extractors.data` glob matches
 * it, and its secret bytes reach no artifact a run writes: the projection store, the parse cache, a
 * parse-timing dump or the report.
 *
 * The reproduction is an untracked, never-committed `.yarnrc.yml` holding `npmAuthToken`, routed
 * by an `include` of every `.yml` file (the data router matches dotfiles). It is read through a key
 * allowlist: `nodeLinker` and a scope's registry answer, and every auth key, top-level or nested, is
 * dropped. A file that holds nothing but credentials (`.netrc`, `.env`, `.git-credentials` and the
 * rest) is never routed, and each one a glob would have routed is a `DATA_CREDENTIAL_FILE_NOT_ROUTED`
 * warning naming its path, so a check author learns why its rows are absent.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { cleanupTestTempDir, createTestTempDir, getBinPath } from './test-common.js';
import { executeCli } from './test-helpers/index.js';

/** Each secret distinct, so a leak names the key it came from. */
const SECRETS = {
  top: 'vatTopLevelNpmAuthTokenSecret0001',
  scope: 'vatScopeNpmAuthTokenSecret0002',
  registry: 'vatRegistryNpmAuthIdentSecret0003',
  ident: 'vatTopLevelNpmAuthIdentSecret0004',
  refused: 'vatPureCredentialFileSecret0005',
} as const;

/** The reproduction: a `.yarnrc.yml` with useful settings beside top-level and nested auth keys. */
const YARNRC = [
  'nodeLinker: node-modules',
  `npmAuthToken: ${SECRETS.top}`,
  `npmAuthIdent: ${SECRETS.ident}`,
  'npmScopes:',
  '  acme:',
  '    npmRegistryServer: https://npm.acme.example',
  `    npmAuthToken: ${SECRETS.scope}`,
  'npmRegistries:',
  '  "//npm.acme.example":',
  `    npmAuthIdent: ${SECRETS.registry}`,
  '    npmAlwaysAuth: true',
  '',
].join('\n');

/** Files that hold nothing but credentials, each routed by some glob below. */
const REFUSED_FILES: Readonly<Record<string, string>> = {
  '.env': `NPM_TOKEN=${SECRETS.refused}\n`,
  '.env.local': `NPM_TOKEN=${SECRETS.refused}\n`,
  '.netrc': `machine example.com login me password ${SECRETS.refused}\n`,
  '_netrc': `machine example.com login me password ${SECRETS.refused}\n`,
  '.git-credentials': `https://me:${SECRETS.refused}@example.com\n`,
  '.pypirc': `[pypi]\npassword = ${SECRETS.refused}\n`,
  '.yarnrc': `_authToken "${SECRETS.refused}"\n`,
  '.npmrc': `//registry.npmjs.org/:_authToken=${SECRETS.refused}\n`,
  '.docker/config.json': `{"auths": {"example.com": {"auth": "${SECRETS.refused}"}}}\n`,
  '.config/gh/hosts.yml': `github.com:\n  oauth_token: ${SECRETS.refused}\n`,
};

/** The routing: every `.yml` and `.json` file, and the extensionless credential files as JSONC. */
const CONFIG = {
  resources: {
    include: ['**/*.md'],
    extractors: {
      data: {
        include: ['**/*.yml', '**/*.json'],
        jsonc: ['**/.env', '**/.env.local', '**/.netrc', '**/_netrc', '**/.git-credentials', '**/.pypirc', '**/.yarnrc', '**/.npmrc'],
      },
    },
    checks: {
      'node-linker-is-node-modules': {
        description: 'Yarn installs into node_modules',
        sql: "SELECT path FROM data__values WHERE path = '.yarnrc.yml' AND pointer = '/nodeLinker' AND value <> 'node-modules'",
      },
    },
  },
};

useScratchTmpdir('vat-scratch-data-credentials-');

const binPath = getBinPath(import.meta.url);

let root: string;
let cacheDir: string;
let timingDir: string;

beforeAll(() => {
  root = createTestTempDir('vat-data-credentials-');
  cacheDir = createTestTempDir('vat-data-credentials-cache-');
  timingDir = createTestTempDir('vat-data-credentials-timing-');
  writeCorpus(root, {
    'README.md': '# Credentials\n',
    'package.json': '{"name": "a"}\n',
    'vibe-agent-toolkit.config.yaml': stringify(CONFIG),
  });
  commitTestFixture(root);
  // Never committed, and no ignore rule covers them: the population still realizes them.
  writeCorpus(root, { '.yarnrc.yml': YARNRC, ...REFUSED_FILES });
});

afterAll(() => {
  for (const dir of [root, cacheDir, timingDir]) cleanupTestTempDir(dir);
});

/** A run with its cache and parse-timing dumps under this suite's directories. */
function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return executeCli(binPath, args, { cwd: root, env: { ...process.env, [VAT_CACHE_DIR_ENV]: cacheDir, VAT_PARSE_TIMING: timingDir } });
}

/** A query's rows. */
function rowsOf(stdout: string): Array<Record<string, unknown>> {
  const document = parseAllDocuments(stdout)[0]?.toJSON() as { data?: { rows?: Array<Record<string, unknown>> } };
  return document.data?.rows ?? [];
}

/** Every file under a directory, recursively. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      // A run writes no link here; one would hide what it points at from the scan, so it fails loudly.
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink ${safePath.join(entry.parentPath, entry.name)}`);
      return entry.isFile();
    })
    .map((entry) => safePath.join(entry.parentPath, entry.name));
}

/** Each secret, and where it was found: a file under the cache or timing directory, or a run's output. */
function leaksIn(outputs: readonly string[]): string[] {
  const texts = [
    ...[...filesUnder(cacheDir), ...filesUnder(timingDir)].map((file) => ({ where: file, bytes: readFileSync(file) })),
    ...outputs.map((output, index) => ({ where: `output ${String(index)}`, bytes: Buffer.from(output) })),
  ];
  return Object.values(SECRETS).flatMap((secret) => texts.filter(({ bytes }) => bytes.includes(secret)).map(({ where }) => `${secret} in ${where}`));
}

describe('an untracked credentials file a data glob matches', () => {
  const outputs: string[] = [];

  it('query: a .yarnrc.yml answers its allowlisted keys and no auth key', () => {
    const result = run(['resources', 'query', "SELECT pointer, value FROM data__values WHERE path = '.yarnrc.yml' ORDER BY pointer"]);
    outputs.push(result.stdout, result.stderr);

    expect(result.status, result.stderr).toBe(0);
    const rows = rowsOf(result.stdout);
    expect(rows).toContainEqual({ pointer: '/nodeLinker', value: 'node-modules' });
    expect(rows).toContainEqual({ pointer: '/npmScopes/acme/npmRegistryServer', value: 'https://npm.acme.example' });
    expect(rows.map(({ pointer }) => String(pointer)).filter((pointer) => pointer.includes('npmAuth'))).toEqual([]);
  });

  it('query: routes no pure credentials file, and names each one on stderr', () => {
    const result = run(['resources', 'query', 'SELECT path, variant FROM data__routes ORDER BY path']);
    outputs.push(result.stdout, result.stderr);

    expect(result.status, result.stderr).toBe(0);
    expect(rowsOf(result.stdout)).toEqual([
      { path: '.yarnrc.yml', variant: 'yarnrc' },
      { path: 'package.json', variant: 'json' },
    ]);
    expect(result.stderr).toContain('DATA_CREDENTIAL_FILE_NOT_ROUTED');
    for (const path of Object.keys(REFUSED_FILES)) expect(result.stderr).toContain(`"${path}"`);
  });

  it('check: runs the check over the allowlisted rows and warns once per refused file', () => {
    const result = run(['resources', 'check']);
    outputs.push(result.stdout, result.stderr);
    const document = parseAllDocuments(result.stdout)[0]?.toJSON() as { findings?: Array<{ code: string; severity: string; message: string }> };
    const refused = (document.findings ?? []).filter((finding) => finding.code === 'DATA_CREDENTIAL_FILE_NOT_ROUTED');

    expect(refused.map((finding) => finding.severity)).toEqual(Object.keys(REFUSED_FILES).map(() => 'warning'));
    for (const path of Object.keys(REFUSED_FILES)) expect(refused.some((finding) => finding.message.includes(`"${path}"`))).toBe(true);
    expect((document.findings ?? []).map((finding) => finding.code)).not.toContain('RESOURCE_CHECK_BROKEN');
  });

  it('no secret reaches the store, the parse cache, a timing dump or any output', () => {
    expect(outputs.length).toBeGreaterThan(0);
    expect(filesUnder(cacheDir).some((file) => file.endsWith('projection.db'))).toBe(true);
    expect(filesUnder(timingDir).length).toBeGreaterThan(0);
    expect(leaksIn(outputs)).toEqual([]);
  });
});
