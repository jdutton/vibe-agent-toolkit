/**
 * The `data` instance's static routes: a pure function of (root-relative path, config).
 *
 * Order (one variant per path): `exclude` removes the path; else an `.npmrc` (matched case-insensitively, by
 * the credentials rule that owns it) is `ini`, its one route;
 * else a `jsonc` glob makes it `jsonc`;
 * else a default names its variant (`**\/package.json` json; `**\/tsconfig*.json`, `**\/jsconfig*.json`
 * jsonc; `**\/pnpm-workspace.yaml` yaml); else an `include` glob routes by extension (`.json` json,
 * `.jsonc` jsonc, `.yaml` and `.yml` yaml). Every rule is minus `**\/node_modules/**`. Each rule is shown here both winning and losing.
 */

import { resolveFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { dataCredentialFileFindings, dataIncludeGlobInertFindings, dataRouteFor, dataRoutingEmptiness, dataRoutingFor } from '../src/projection/router.js';
import { ProjectConfigSchema, type ProjectConfig } from '../src/schemas/project-config.js';

/** A config whose `resources.extractors.data` is exactly `data`. */
function configWith(data: Record<string, unknown>): ProjectConfig {
  return ProjectConfigSchema.parse({ resources: { extractors: { data } } });
}

/** The variant `path` routes to under `data` (or under no config at all when `data` is undefined). */
function routeOf(path: string, data?: Record<string, unknown>): string | undefined {
  return dataRouteFor(path, dataRoutingFor(data === undefined ? undefined : configWith(data)));
}

describe('dataRouteFor: the defaults, with no config', () => {
  it.each([
    ['package.json', 'json'],
    ['packages/a/package.json', 'json'],
    ['tsconfig.json', 'jsonc'],
    ['packages/a/tsconfig.build.json', 'jsonc'],
    ['jsconfig.json', 'jsonc'],
    ['web/jsconfig.app.json', 'jsonc'],
    ['.config/tsconfig.json', 'jsonc'],
    ['pnpm-workspace.yaml', 'yaml'],
    ['packages/a/pnpm-workspace.yaml', 'yaml'],
    ['.npmrc', 'ini'],
    ['packages/x/.npmrc', 'ini'],
  ] as const)('%s -> %s', (path, expected) => {
    expect(routeOf(path)).toBe(expected);
  });

  it.each([
    'turbo.json',
    'a/data.json',
    'package.jsonc',
    'tsconfig.jsonc',
    'my-package.json',
    'README.md',
    'a/data.yaml',
    '.github/workflows/ci.yml',
    'pnpm-workspace.yml',
    'pnpm-lock.yaml',
  ])('%s is not routed', (path) => {
    expect(routeOf(path)).toBeUndefined();
  });

  it.each([
    'node_modules/x/package.json',
    'packages/a/node_modules/x/tsconfig.json',
    'node_modules/.pnpm/y/package.json',
    'node_modules/x/pnpm-workspace.yaml',
    'node_modules/x/.npmrc',
  ])('%s is under node_modules, so not routed', (path) => {
    expect(routeOf(path)).toBeUndefined();
  });
});

describe('dataRouteFor: the order, each rule winning and losing', () => {
  it('exclude beats a jsonc glob, a default and an include', () => {
    const data = { include: ['**/*.json'], jsonc: ['**/*.json'], exclude: ['**/test/fixtures/**'] };
    expect(routeOf('test/fixtures/package.json', data)).toBeUndefined();
    expect(routeOf('test/fixtures/tsconfig.json', data)).toBeUndefined();
    expect(routeOf('test/fixtures/x.json', data)).toBeUndefined();
    // Losing: a path exclude does not match takes the next rule.
    expect(routeOf('src/x.json', data)).toBe('jsonc');
  });

  it('a jsonc glob beats a default and an include', () => {
    const data = { include: ['**/*.json'], jsonc: ['**/package.json', '**/turbo.json'] };
    expect(routeOf('package.json', data)).toBe('jsonc');
    expect(routeOf('a/turbo.json', data)).toBe('jsonc');
    // Losing: a path no jsonc glob matches takes the default, then include.
    expect(routeOf('tsconfig.json', data)).toBe('jsonc');
    expect(routeOf('a/data.json', data)).toBe('json');
  });

  it('a jsonc glob routes whatever the extension', () => {
    expect(routeOf('.vscode/settings', { jsonc: ['.vscode/*'] })).toBe('jsonc');
  });

  it('a jsonc glob beats the yaml default and a yaml include', () => {
    const data = { include: ['**/*.yml'], jsonc: ['**/pnpm-workspace.yaml', 'odd/*.yml'] };
    expect(routeOf('pnpm-workspace.yaml', data)).toBe('jsonc');
    expect(routeOf('odd/x.yml', data)).toBe('jsonc');
    // Losing: a yaml path no jsonc glob matches takes include.
    expect(routeOf('ci/x.yml', data)).toBe('yaml');
  });

  it('an .npmrc is ini or nothing: a jsonc glob or an include never routes it otherwise, exclude removes it', () => {
    expect(routeOf('.npmrc', { jsonc: ['**/.npmrc', '**/*'] })).toBe('ini');
    expect(routeOf('a/.npmrc', { include: ['**/*'] })).toBe('ini');
    expect(routeOf('.npmrc', { exclude: ['.npmrc'] })).toBeUndefined();
    expect(routeOf('packages/x/.npmrc', { exclude: ['packages/**'] })).toBeUndefined();
    // Losing: the jsonc glob still decides a path that is not an .npmrc.
    expect(routeOf('a/x.json', { jsonc: ['**/*'] })).toBe('jsonc');
  });

  it('no path but an .npmrc is ever ini, whatever include names', () => {
    const data = { include: ['**/*.ini', '**/*.npmrc', '.npmrc.bak', '**/npmrc'], jsonc: [] };
    for (const path of ['config.ini', 'a/b.INI', 'x.npmrc', '.npmrc.bak', 'npmrc', 'a/.npmrc/x', '.npmrc.json']) {
      expect(routeOf(path, data), path).not.toBe('ini');
    }
    expect(routeOf('.npmrc.json', { include: ['**/*'] })).toBe('json');
  });

  it('an .npmrc is matched under the one case rule of the credentials rule: case-insensitive, still ini', () => {
    expect(routeOf('a/.NPMRC')).toBe('ini');
    expect(routeOf('.NpmRc', { jsonc: ['**/*'] })).toBe('ini');
  });

  it('the credentials rule does not cancel the ini route: an .npmrc a credentials glob names is still ini, with no warning', () => {
    expect(routeOf('.npmrc', EVERY_ROUTE)).toBe('ini');
    expect(routeOf('.npmrc')).toBe('ini');
    expect(dataCredentialFileFindings([{ path: '.npmrc', contentState: 'keyed' }], dataRoutingFor(configWith(EVERY_ROUTE)))).toEqual([]);
  });

  it('exclude beats the yaml default', () => {
    expect(routeOf('pnpm-workspace.yaml', { exclude: ['pnpm-workspace.yaml'] })).toBeUndefined();
  });

  it('a default beats an include', () => {
    const data = { include: ['**/*.json'] };
    // Include by extension would say json; the tsconfig default says jsonc.
    expect(routeOf('tsconfig.json', data)).toBe('jsonc');
    expect(routeOf('package.json', data)).toBe('json');
  });

  it('include routes only what no earlier rule decided, by extension', () => {
    const data = { include: ['tools/**'] };
    expect(routeOf('tools/waiver.json', data)).toBe('json');
    expect(routeOf('tools/settings.jsonc', data)).toBe('jsonc');
    expect(routeOf('tools/NOTES.JSON', data)).toBe('json');
    expect(routeOf('tools/notes.yaml', data)).toBe('yaml');
    expect(routeOf('tools/ci.yml', data)).toBe('yaml');
    expect(routeOf('tools/CI.YML', data)).toBe('yaml');
    expect(routeOf('tools/notes.toml', data)).toBeUndefined();
    expect(routeOf('tools/README.md', data)).toBeUndefined();
    expect(routeOf('other/waiver.json', data)).toBeUndefined();
  });

  it('node_modules is excluded from every rule, an explicit include and jsonc glob included', () => {
    const data = { include: ['node_modules/**'], jsonc: ['**/node_modules/**/*.json'] };
    expect(routeOf('node_modules/x/data.json', data)).toBeUndefined();
    expect(routeOf('node_modules/x/data.yaml', data)).toBeUndefined();
    expect(routeOf('a/node_modules/x/settings.json', data)).toBeUndefined();
  });
});

describe('dataRouteFor: patterns are anchored at the project root and see dot directories', () => {
  it('a root-level pattern matches only at the root', () => {
    const data = { jsonc: ['*.json'] };
    expect(routeOf('turbo.json', data)).toBe('jsonc');
    expect(routeOf('a/turbo.json', data)).toBeUndefined();
  });

  it('a directory pattern does not match the same name deeper down', () => {
    const data = { include: ['tools/*.json'] };
    expect(routeOf('tools/a.json', data)).toBe('json');
    expect(routeOf('x/tools/a.json', data)).toBeUndefined();
  });

  it('globs descend into and match dot directories and dot files', () => {
    expect(routeOf('.vscode/settings.json', { jsonc: ['.vscode/*.json'] })).toBe('jsonc');
    expect(routeOf('.github/x/data.json', { include: ['**/*.json'] })).toBe('json');
    expect(routeOf('a/.eslintrc.json', { jsonc: ['**/.eslintrc.json'] })).toBe('jsonc');
  });

  it('is pure: the same input gives the same answer, asked again or through a second routing', () => {
    const data = { include: ['**/*.json'], exclude: ['b/**'] };
    const routing = dataRoutingFor(configWith(data));
    const paths = ['a/x.json', 'b/x.json', 'tsconfig.json', 'README.md'];
    const first = paths.map((path) => dataRouteFor(path, routing));
    expect(paths.map((path) => dataRouteFor(path, routing))).toEqual(first);
    expect(paths.map((path) => dataRouteFor(path, dataRoutingFor(configWith(data))))).toEqual(first);
    expect(first).toEqual(['json', undefined, 'jsonc', undefined]);
  });
});

describe('dataRoutingFor: declared and allowEmpty', () => {
  it('no config, or a config without extractors, is undeclared and not allowed empty', () => {
    expect(dataRoutingFor(undefined)).toMatchObject({ declared: false, allowEmpty: false });
    expect(dataRoutingFor(ProjectConfigSchema.parse({}))).toMatchObject({ declared: false, allowEmpty: false });
    expect(dataRoutingFor(ProjectConfigSchema.parse({ resources: {} }))).toMatchObject({ declared: false, allowEmpty: false });
  });

  it('a data block, even an empty one, is declared', () => {
    expect(dataRoutingFor(configWith({}))).toMatchObject({ declared: true, allowEmpty: false });
    expect(dataRoutingFor(configWith({ include: ['x.json'] }))).toMatchObject({ declared: true, allowEmpty: false });
  });

  it('allowEmpty: true is carried', () => {
    expect(dataRoutingFor(configWith({ allowEmpty: true }))).toMatchObject({ declared: true, allowEmpty: true });
  });
});

describe('dataRoutingEmptiness: a declared instance that routes nothing refuses', () => {
  const emptinessOf = (data: Record<string, unknown> | undefined, routed: number): string | undefined =>
    dataRoutingEmptiness(routed, dataRoutingFor(data === undefined ? undefined : configWith(data)));

  it('is undefined with no data block, whatever routed', () => {
    expect(emptinessOf(undefined, 0)).toBeUndefined();
  });

  it('names the instance when a declared block routed nothing', () => {
    expect(emptinessOf({}, 0)).toMatch(/^resources\.extractors\.data is declared, but it routed no file/);
  });

  it('names the credentials rule when credentials files its globs matched are why nothing routed', () => {
    const routing = dataRoutingFor(configWith({ jsonc: ['**/.env'] }));
    const message = dataRoutingEmptiness(0, routing, 2);
    expect(message).toContain('credentials rule refused 2 file(s)');
    expect(message).toContain('DATA_CREDENTIAL_FILE_NOT_ROUTED');
    expect(dataRoutingEmptiness(0, routing)).not.toContain('credentials');
  });

  it('does not refuse over an include glob that matches nothing while the block routes other files', () => {
    expect(emptinessOf({ include: ['config/*.json', 'configs/*.json'] }, 2)).toBeUndefined();
  });

  it('is excused by allowEmpty', () => {
    expect(emptinessOf({ allowEmpty: true }, 0)).toBeUndefined();
  });
});

describe('dataIncludeGlobInertFindings: an include glob that routes nothing is a named warning', () => {
  const REALIZATIONS = [
    ...['package.json', 'config/app.json', 'notes/a.yaml', 'ci/b.yml', 'notes/c.toml', 'node_modules/x/settings.json'].map((path) => ({ path, contentState: 'keyed' as const })),
    // No content: never routed, so it matches no glob.
    { path: 'linked/dangling.json', contentState: 'none' as const },
  ];
  const findingsOf = (data: Record<string, unknown> | undefined): readonly ValidationIssue[] =>
    dataIncludeGlobInertFindings(REALIZATIONS, dataRoutingFor(data === undefined ? undefined : configWith(data)));

  it('is empty with no data block', () => {
    expect(findingsOf(undefined)).toEqual([]);
  });

  it('is empty when every include glob matches a path of a routed extension', () => {
    expect(findingsOf({ include: ['config/*.json', '**/package.json', 'notes/*.yaml', 'ci/*.yml'] })).toEqual([]);
  });

  it('names every extension include routes, in the message', () => {
    expect(findingsOf({ include: ['configs/*.json'] })[0]?.message).toContain('matches no .json, .jsonc, .yaml or .yml file');
  });

  it.each([
    ['a glob matching nothing', 'configs/*.json'],
    ['a glob matching only another extension', 'notes/*.toml'],
    ['a glob matching only under node_modules', '**/settings.json'],
    ['a glob matching only a realization with no content', 'linked/*.json'],
  ])('names %s, once, at warning, under DATA_INCLUDE_GLOB_INERT', (_case, glob) => {
    const findings = findingsOf({ include: ['config/*.json', glob] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'DATA_INCLUDE_GLOB_INERT', severity: 'warning', field: 'resources.extractors.data.include' });
    expect(findings[0]?.message).toContain(`resources.extractors.data.include glob "${glob}"`);
  });

  it('is excused by allowEmpty', () => {
    expect(findingsOf({ include: ['configs/*.json'], allowEmpty: true })).toEqual([]);
  });
});

/** Every glob that could route a credentials file: by extension, by `jsonc`, and by a default's own name. */
const EVERY_ROUTE = { include: ['**/*.yml', '**/*.yaml', '**/*.json'], jsonc: ['**/*'] };

describe('dataRouteFor: a credentials file is never stored whole, whatever glob matches it', () => {
  it.each([
    '.netrc', '_netrc', 'home/_NETRC', '.git-credentials', '.pypirc', '.yarnrc',
    '.env', '.env.local', 'apps/web/.env.production', '.docker/config.json', '.config/gh/hosts.yml', '.config/gh/hosts.yaml',
    '.aws/credentials', '.kube/config', '.pgpass', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials',
    '.terraformrc', 'terraform.rc', 'infra/terraform.rc', '.ssh/id_ed25519', '.ssh/config',
    'auth.json', 'php/auth.json', 'local.settings.json', 'func/Local.Settings.json', 'credentials.json',
    'client_secret.json', 'client_secret_123-abc.apps.googleusercontent.com.json', 'sa/prod-service-account.json', 'service-account-key.json',
  ])('%s is not routed', (path) => {
    expect(routeOf(path, EVERY_ROUTE)).toBeUndefined();
  });

  it.each(['.yarnrc.yml', 'packages/a/.yarnrc.yml', '.yarnrc.yaml', 'x/.YARNRC.YML'])('%s is routed as yarnrc, by include or by jsonc alike', (path) => {
    expect(routeOf(path, { include: ['**/*.yml', '**/*.yaml', '**/*.YML'] })).toBe('yarnrc');
    expect(routeOf(path, { jsonc: ['**/*'] })).toBe('yarnrc');
  });

  it('routes a .yarnrc.yml no glob matches nowhere', () => {
    expect(routeOf('.yarnrc.yml')).toBeUndefined();
  });

  // The list names kinds by whole file name; a lookalike is an ordinary file and is routed.
  it.each([
    'environment.yml', 'docs/env.json', '.envrc.example.md', 'docker/config.json', 'ssh/config.json', 'config/hosts.yml',
    'author.json', 'authors.json', 'auth.json.md', 'credentials.json5', 'my-credentials.json', 'client.json', 'clients_secret.json',
    'service.json', 'accounts.json', 'local.settings.example.json', 'terraform.rc.json', 'cargo/credentials.json.txt',
  ])('%s is an ordinary file', (path) => {
    expect(routeOf(path, EVERY_ROUTE)).toBeDefined();
  });
});

describe('dataCredentialFileFindings: a credentials file a glob would route is a named warning', () => {
  const REALIZATIONS = ['package.json', '.yarnrc.yml', '.env', '.npmrc', '.docker/config.json', 'notes/a.yml']
    .map((path) => ({ path, contentState: 'keyed' as const }));
  const findingsOf = (data: Record<string, unknown> | undefined): readonly ValidationIssue[] =>
    dataCredentialFileFindings(REALIZATIONS, dataRoutingFor(data === undefined ? undefined : configWith(data)));

  it('names each refused file a glob matches, once, at warning, with the exclude remedy', () => {
    const findings = findingsOf({ include: ['**/*.json'], jsonc: ['**/.env'] });
    expect(findings.map((finding) => finding.code)).toEqual(['DATA_CREDENTIAL_FILE_NOT_ROUTED', 'DATA_CREDENTIAL_FILE_NOT_ROUTED']);
    expect(findings.map((finding) => finding.severity)).toEqual(['warning', 'warning']);
    expect(findings[0]?.message).toContain('".env"');
    expect(findings[1]?.message).toContain('".docker/config.json"');
    expect(findings[0]?.message).toContain('resources.extractors.data.exclude');
  });

  it('names nothing that no glob would route, nor a .yarnrc.yml (read through its allowlist)', () => {
    expect(findingsOf({ include: ['**/*.yml'] })).toEqual([]);
    expect(findingsOf(undefined)).toEqual([]);
  });

  it('carries the path as its location, so a per-path allow waives exactly that one file', () => {
    const realizations = ['.env', '.env.example', '.docker/config.json'].map((path) => ({ path, contentState: 'keyed' as const }));
    const routing = dataRoutingFor(configWith({ jsonc: ['**/*'] }));
    const raw = dataCredentialFileFindings(realizations, routing);
    expect(raw.map((finding) => finding.location)).toEqual(['.env', '.env.example', '.docker/config.json']);
    const resolved = resolveFindings(raw, { allow: { DATA_CREDENTIAL_FILE_NOT_ROUTED: [{ paths: ['.env.example'], reason: 'a template, no secret' }] } });
    expect(resolved.map((finding) => finding.location)).toEqual(['.env', '.docker/config.json']);
  });

  it('names one path once, however many roots realize it', () => {
    const twice = ['.env', '.env'].map((path) => ({ path, contentState: 'keyed' as const }));
    expect(dataCredentialFileFindings(twice, dataRoutingFor(configWith({ jsonc: ['**/.env'] })))).toHaveLength(1);
  });

  it('steers to exclude or a per-path allow, never the project-wide severity override', () => {
    const [finding] = dataCredentialFileFindings([{ path: '.env', contentState: 'keyed' }], dataRoutingFor(configWith({ jsonc: ['**/.env'] })));
    expect(finding?.message).toContain('resources.validation.allow.DATA_CREDENTIAL_FILE_NOT_ROUTED');
    expect(finding?.message).not.toContain('severity');
  });

  it('names nothing the project excludes itself', () => {
    expect(findingsOf({ include: ['**/*.json'], jsonc: ['**/.env'], exclude: ['**/.env', '**/.docker/**'] })).toEqual([]);
  });
});

/** The parse result of a config holding `extractors`. */
function parse(extractors: unknown): ReturnType<typeof ProjectConfigSchema.safeParse> {
  return ProjectConfigSchema.safeParse({ resources: { extractors } });
}

describe('resources.extractors config schema', () => {
  it('accepts the full data block', () => {
    const result = parse({ data: { include: ['a.json'], jsonc: ['**/turbo.json'], exclude: ['**/fixtures/**'], allowEmpty: true } });
    expect(result.success).toBe(true);
  });

  it('accepts extractors with no data block (defaults only, undeclared)', () => {
    expect(parse({}).success).toBe(true);
  });

  it('refuses allowEmpty: false (omit the key instead)', () => {
    const result = parse({ data: { allowEmpty: false } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['resources', 'extractors', 'data', 'allowEmpty']);
  });

  it('refuses an unknown key inside data', () => {
    const result = parse({ data: { includes: ['a.json'] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', path: ['resources', 'extractors', 'data'] });
  });

  it('refuses an unknown extractor', () => {
    const result = parse({ yaml: { include: ['a.yaml'] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', path: ['resources', 'extractors'] });
  });

  it('refuses a non-string glob', () => {
    expect(parse({ data: { jsonc: [42] } }).success).toBe(false);
  });
});
