/**
 * Small decisions several verbs make from values alone, each pinned where a wrong answer is
 * silent: what an install source string is, when a postinstall hook may run, what a failed
 * post-build check publishes, how a marketplace's paths move from its staged tree to where it
 * landed, and which uninstall invocations are refused before anything is looked up.
 */

import { recordSuppressedFault, VatError } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __internal as publishInternal } from '../../src/commands/claude/marketplace/publish.js';
import { __internal as buildInternal } from '../../src/commands/claude/plugin/build.js';
import { detectSource, isGlobalNpmInstall } from '../../src/commands/claude/plugin/helpers.js';
import { __internal as installInternal } from '../../src/commands/claude/plugin/install.js';
import { __internal as uninstallInternal } from '../../src/commands/claude/plugin/uninstall.js';
import { __internal as supervisorInternal } from '../../src/commands/resources/check-supervisor.js';
import { __internal as skillsInstallInternal } from '../../src/commands/skills/install.js';
import { __internal as listInternal } from '../../src/commands/skills/list.js';
import { __internal as packageInternal } from '../../src/commands/skills/package.js';
import { isNpmOrTarballSource } from '../../src/commands/skills/source-resolvers.js';
import { fakeLogger, refusalOf } from '../helpers/refusal-of.js';

const linesOf = (log: ReturnType<typeof vi.fn>): string[] => log.mock.calls.map((call) => String(call[0]));
const errno = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`${code}: refused`), { code, ...extra });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('install source strings', () => {
  it.each([
    ['--npm-postinstall', 'npm-postinstall'],
    ['npm:@scope/pkg@1.0.0', 'npm'],
    ['./dist/skill.zip', 'zip'],
    ['./pkg-1.0.0.tgz', 'tgz'],
    ['./pkg-1.0.0.tar.gz', 'tgz'],
  ])('detectSource(%s) is %s, decided by spelling before any path is examined', (input, source) => {
    expect(detectSource(input)).toBe(source);
  });

  it.each([
    ['npm:pkg', true],
    ['./a.tgz', true],
    ['./a.tar.gz', true],
    ['./a.zip', false],
    ['./a-directory', false],
  ])('isNpmOrTarballSource(%s) is %s', (source, expected) => {
    expect(isNpmOrTarballSource(source)).toBe(expected);
  });
});

describe('isGlobalNpmInstall', () => {
  const npmEnv = (global: string, event: string, command: string): void => {
    for (const name of ['npm_config_global', 'NPM_CONFIG_GLOBAL', 'npm_lifecycle_event', 'npm_command']) vi.stubEnv(name, undefined as never);
    vi.stubEnv('npm_config_global', global);
    vi.stubEnv('npm_lifecycle_event', event);
    vi.stubEnv('npm_command', command);
  };

  it('is true only for the postinstall of a global `npm install`', () => {
    npmEnv('true', 'postinstall', 'install');
    expect(isGlobalNpmInstall()).toBe(true);
  });

  it.each([
    ['a local install', 'false', 'postinstall', 'install'],
    ['another lifecycle script', 'true', 'prepare', 'install'],
    ['npm link, which must not run the hook', 'true', 'postinstall', 'link'],
  ])('is false for %s', (_label, global, event, command) => {
    npmEnv(global, event, command);
    expect(isGlobalNpmInstall()).toBe(false);
  });

  it('finds the global flag under the upper-case spelling a Windows child may receive', () => {
    for (const name of ['npm_config_global', 'npm_lifecycle_event', 'npm_command']) vi.stubEnv(name, undefined as never);
    vi.stubEnv('NPM_CONFIG_GLOBAL', 'true');
    vi.stubEnv('npm_lifecycle_event', 'postinstall');
    vi.stubEnv('npm_command', 'install');
    expect(isGlobalNpmInstall()).toBe(true);
  });
});

describe('vat skills package', () => {
  it('resolveTarget hands back a known target and refuses any other, listing the valid ones', () => {
    expect(packageInternal.resolveTarget('claude-web')).toBe('claude-web');
    const refusal = refusalOf(() => packageInternal.resolveTarget('claude-desktop-pro'));
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toMatch(/^Invalid --target value: "claude-desktop-pro"\. Valid targets are: .*claude-web/);
  });

  it('a package its post-build checks failed publishes those findings, no output path, and what the discard left', () => {
    const broken = { severity: 'error', code: 'LINK_INTEGRITY_BROKEN', message: 'guide.md links to missing.md', location: 'out/s/guide.md' };
    const error = Object.assign(new VatError('SKILL_PACKAGE_CHECKS_FAILED', 'checks failed'), {
      result: { outputPath: '/proj/out/s', skill: { name: 's', version: '1.2.0' }, postBuildIssues: [broken, broken] },
    });
    recordSuppressedFault(error, errno('EBUSY', { path: '/proj/out/.s.vat-staged-ab' }));
    const logger = fakeLogger();

    const report = packageInternal.failedChecksReport(error as never, { issues: [] } as never, logger as never);

    expect(report.status).toBe('findings');
    expect(report.data).toEqual({ skill: 's', version: '1.2.0', outputPath: null, dryRun: false });
    // The same finding reported by both post-build channels is published once.
    expect(report.findings.map((finding) => finding.code)).toEqual(['LINK_INTEGRITY_BROKEN', 'TREE_CLEANUP_INCOMPLETE']);
    expect(linesOf(logger.error)[0]).toBe('Package failed its post-build checks: nothing was written to /proj/out/s');
  });

  it('a skill declaring no version publishes null', () => {
    const error = Object.assign(new VatError('SKILL_PACKAGE_CHECKS_FAILED', 'checks failed'), { result: { outputPath: '/o', skill: { name: 's' }, postBuildIssues: [] } });
    expect(packageInternal.failedChecksReport(error as never, { issues: [] } as never, fakeLogger() as never).data).toMatchObject({ version: null });
  });
});

describe('landedMarketplace', () => {
  const landed = (value: string): string => value.replace('/proj/dist/.mp.vat-staged-1a2b', '/proj/dist/mp');
  const at = (location: string | undefined) => ({ severity: 'warning', code: 'W', message: 'm', ...(location === undefined ? {} : { location }) });

  it('re-anchors every path the staged build named onto where the marketplace landed, and carries the residue', () => {
    const built = {
      name: 'mp',
      plugins: [{ pluginName: 'p', pluginDir: '/proj/dist/.mp.vat-staged-1a2b/plugins/p', issues: [at('/proj/dist/.mp.vat-staged-1a2b/plugins/p/skills/s'), at(undefined)] }],
      externalPlugins: [],
      gate: undefined,
      residue: [],
    };
    const residue = [at('/proj/dist/.mp.vat-staged-9f.previous')];

    const result = buildInternal.landedMarketplace(built as never, landed, residue as never);

    expect(result.plugins[0]?.pluginDir).toBe('/proj/dist/mp/plugins/p');
    expect(result.plugins[0]?.issues.map((issue) => issue.location)).toEqual(['/proj/dist/mp/plugins/p/skills/s', undefined]);
    expect(result.residue).toBe(residue);
    expect(result.gate).toBeUndefined();
  });

  it('re-anchors a gated plugin\'s findings too, keeping its reason', () => {
    const built = { name: 'mp', plugins: [], externalPlugins: [], residue: [], gate: { reason: 'p failed', issues: [at('/proj/dist/.mp.vat-staged-1a2b/plugins/p')] } };
    const result = buildInternal.landedMarketplace(built as never, landed, []);
    expect(result.gate).toEqual({ reason: 'p failed', issues: [at('/proj/dist/mp/plugins/p')] });
  });
});

describe('vat claude plugin uninstall: which invocation is refused before any lookup', () => {
  const { resolvePluginKeys } = uninstallInternal;

  it('a key beside --all is refused, since --all would ignore it', () => {
    const refusal = refusalOf(() => resolvePluginKeys('p@mp', { all: true }, fakeLogger() as never));
    expect(refusal.refusal).toBe('USAGE_INVALID');
    expect(refusal.message).toContain('"p@mp" would be ignored by --all');
  });

  it('no key and no --all is refused with the two usages', () => {
    expect(refusalOf(() => resolvePluginKeys(undefined, {}, fakeLogger() as never)).message).toContain('vat claude plugin uninstall --all');
  });

  it('a well-formed key is the one key to uninstall', () => {
    expect(resolvePluginKeys('p@mp', {}, fakeLogger() as never)).toEqual(['p@mp']);
  });

  it('a key with no marketplace half is refused by the library\'s one rule', () => {
    expect(() => resolvePluginKeys('p@', {}, fakeLogger() as never)).toThrow(expect.objectContaining({ code: 'PLUGIN_KEY_INVALID' }));
  });
});

describe('vat claude marketplace publish: the report over what was published', () => {
  const { leftoverFindings, publishReport } = publishInternal;
  const published = { marketplace: 'mp', version: '1.0.0', branch: 'claude-marketplace', files: ['.claude-plugin/marketplace.json', 'plugins/'], dryRun: false };

  it('each temp directory left behind is one warning linking it; none is no finding', () => {
    expect(leftoverFindings([])).toEqual([]);
    const findings = leftoverFindings([new Error('could not remove /tmp/vat-publish-tree-mp-x')]);
    expect(findings).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning' })]);
  });

  it('examines one per marketplace published, and a leftover makes a finished publish "findings", not an error', () => {
    const clean = publishReport([published], [], 12);
    expect(clean).toMatchObject({ status: 'ok', examined: 1, data: { published: [published] } });
    const withLeftover = publishReport([published, { ...published, marketplace: 'second' }], leftoverFindings([new Error('left')]), 12);
    expect(withLeftover.status).toBe('findings');
    expect(withLeftover.examined).toBe(2);
  });
});

describe('vat skills list: the human listing', () => {
  const { outputSkillsHuman } = listInternal;
  const skill = (name: string, extra: Record<string, unknown> = {}) => ({ name, path: `/s/${name}/SKILL.md`, valid: true, ...extra });

  it('says so when there is none, after naming every directory it could not list', () => {
    const logger = fakeLogger();
    outputSkillsHuman([], [{ directory: '/s/locked', code: 'EACCES' }] as never, logger as never, {});
    expect(linesOf(logger.info)).toEqual([
      'warning: could not list /s/locked (EACCES); any skill beneath it is missing from this list.',
      '\n   No skills found',
    ]);
  });

  it('counts in the singular and the plural, and shows a warning beside the skill it is about', () => {
    const one = fakeLogger();
    outputSkillsHuman([skill('a')] as never, [], one as never, {});
    expect(linesOf(one.info)).toEqual(['\n   Found 1 skill:\n', '   ✅ a']);

    const two = fakeLogger();
    outputSkillsHuman([skill('a'), skill('b', { valid: false, warning: 'not named SKILL.md' })] as never, [], two as never, {});
    expect(linesOf(two.info)).toEqual(['\n   Found 2 skills:\n', '   ✅ a', '   ⚠️ b (not named SKILL.md)']);
  });

  it('--verbose adds each path, and the warning on its own line', () => {
    const logger = fakeLogger();
    outputSkillsHuman([skill('b', { valid: false, warning: 'not named SKILL.md' })] as never, [], logger as never, { verbose: true });
    expect(linesOf(logger.info).slice(1)).toEqual(['   ⚠️ b', '      Warning: not named SKILL.md', '      Path: /s/b/SKILL.md\n']);
  });
});

describe('vat resources check --budget: how often the supervisor looks', () => {
  const { pollIntervalMs } = supervisorInternal;

  it('is a tenth of the budget, never faster than 50 ms nor slower than 250 ms', () => {
    expect(pollIntervalMs(2000)).toBe(200);
    expect(pollIntervalMs(100)).toBe(50);
    expect(pollIntervalMs(600_000)).toBe(250);
  });
});

describe('which side a refused read is on when the error names no path', () => {
  it('vat skills install: a directory source is the operator\'s input, an extracted archive VAT\'s own scratch — and the fault says the path came from content', () => {
    const directory = skillsInstallInternal.sourceBoundary({ dir: '/src/skill', side: 'source', tempDirs: [] } as never);
    expect(directory.classify(errno('EACCES'), 'validate the skill', 'source')).toMatchObject({ side: 'source', origin: 'content' });
    const archive = skillsInstallInternal.sourceBoundary({ dir: '/tmp/x/skill', side: 'environment', tempDirs: ['/tmp/x'] } as never);
    expect(archive.classify(errno('EMFILE'), 'validate the skill', 'environment')).toMatchObject({ side: 'environment', origin: 'content' });
  });

  it('vat claude plugin install: a fault under none of the run\'s trees is the Claude state it writes', () => {
    const run = installInternal.newInstallRun({}, fakeLogger() as never);
    expect(installInternal.boundaryOf(run).classify(errno('EROFS'), 'write the registry', 'destination')).toMatchObject({ side: 'destination', origin: 'content' });
    const defect = new TypeError('not a fault');
    expect(installInternal.boundaryOf(run).classify(defect, 'write', 'destination')).toBe(defect);
  });
});
