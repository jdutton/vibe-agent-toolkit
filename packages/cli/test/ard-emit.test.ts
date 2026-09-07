/**
 * `vat ard emit` — assembling surfaces out of the project config, and refusing
 * to invent the parts the ARD specification does not define.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ArdConfigMissingError,
  ardEmitCommand,
  runArdEmit,
  type ArdEmitOptions,
} from '../src/commands/ard/emit.js';
import { createArdCommand } from '../src/commands/ard/index.js';
import { collectArdSurfaces } from '../src/commands/ard/surfaces.js';

import {
  CONFIG_YAML_ARD_DOT_NAMESPACE,
  CONFIG_YAML_ARD_SHADOWED_KEYS,
  CONFIG_YAML_ARD_WITHOUT_BASE_URL,
  CONFIG_YAML_WITHOUT_ARD,
  CONFIG_YAML_WITH_ARD,
  FIXTURE_MARKETPLACE,
  FIXTURE_PUBLISHER,
  PUBLISHED_SKILL,
  QUALIFIED_MARKETPLACE_KEY,
  SKILLS_PROJECT,
  UNPUBLISHED_SKILL,
  projectWith,
  projectWithMarketplace,
  projectWithMarketplaceOverrides,
  projectWithSkill,
  removeConfigFile,
} from './ard-test-helpers.js';

/** The author-supplied media type the marketplace cases hand in. */
const VENDOR_CATALOG_TYPE = 'application/x-vendor-catalog+json';

const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ard-cli-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run the command with stdout, stderr and `process.exit` all captured.
 *
 * One helper rather than a spy dance per case: three cases already hand-rolled
 * the same four steps, and a machine-readable report has to be asserted on the
 * STREAM it reaches — a fact nobody prints is the same silence a report exists
 * to end.
 */
async function captureEmit(
  root: string,
  options: Omit<ArdEmitOptions, 'projectRoot' | 'output'> = {}
): Promise<{ stdout: string; stderr: string; exitCalls: unknown[][] }> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  let stdout = '';
  let stderr = '';
  let exitCalls: unknown[][] = [];
  try {
    await ardEmitCommand({
      projectRoot: root,
      output: safePath.join(root, 'out', 'ard.json'),
      ...options,
    });
    // 🪤 Read the calls BEFORE restoring: `mockRestore()` resets the spy, which
    // clears `mock.calls` — asserting afterwards sees zero calls and fails for a
    // reason that has nothing to do with the code under test.
    stdout = outSpy.mock.calls.map((call) => String(call[0])).join('');
    stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    exitCalls = exitSpy.mock.calls;
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
  return { stdout, stderr, exitCalls };
}

/** The rendered `emit` help, which is where the exit-code contract is published. */
function emitHelpText(): string {
  const emit = createArdCommand().commands.find((c) => c.name() === 'emit');
  // `helpInformation()` renders only the generated body — the Exit Codes block
  // lives in an `addHelpText('after')` hook, which only `outputHelp()` runs.
  let help = '';
  emit?.configureOutput({
    writeOut: (chunk) => {
      help += chunk;
    },
  });
  emit?.outputHelp();
  return help;
}

describe('collectArdSurfaces', () => {
  it('derives one surface per published skill', () => {
    const { surfaces } = collectArdSurfaces(SKILLS_PROJECT, {});
    expect(surfaces.map((s) => s.name)).toEqual([PUBLISHED_SKILL]);
    expect(surfaces[0]?.kind).toBe('skill');
    expect(surfaces[0]?.urlPath).toBe(`skills/${PUBLISHED_SKILL}`);
  });

  it('skips a skill the project has opted out of publishing', () => {
    const { skipped } = collectArdSurfaces(SKILLS_PROJECT, {});
    expect(skipped).toEqual([expect.objectContaining({ name: UNPUBLISHED_SKILL, kind: 'skill' })]);
    expect(skipped[0]?.reason).toMatch(/publish/i);
  });

  it('threads a derived version onto every surface', () => {
    const { surfaces } = collectArdSurfaces(SKILLS_PROJECT, { version: '0.2.0' });
    expect(surfaces[0]?.version).toBe('0.2.0');
  });

  it('skips a marketplace unless the author supplied an explicit type', () => {
    const { surfaces, skipped } = collectArdSurfaces(projectWithMarketplace(), {});
    expect(surfaces.map((s) => s.name)).toEqual([PUBLISHED_SKILL]);
    expect(skipped.find((s) => s.kind === 'marketplace')?.reason).toMatch(/ard\.entries/);
  });

  it('emits a marketplace once an explicit type is configured', () => {
    const { surfaces } = collectArdSurfaces(
      projectWithMarketplace(VENDOR_CATALOG_TYPE),
      {}
    );
    expect(surfaces.map((s) => s.kind).sort((a, b) => a.localeCompare(b))).toEqual([
      'marketplace',
      'skill',
    ]);
  });

  it('skips an OKF bundle unless the author supplied an explicit type', () => {
    const { skipped } = collectArdSurfaces(
      { ...SKILLS_PROJECT, okf: { bundles: { handbook: { root: 'docs/handbook' } } } },
      {}
    );
    expect(skipped.find((s) => s.kind === 'okf-bundle')?.reason).toMatch(/ard\.entries/);
  });
});

/**
 * Emit and read back, in one place. Both callers ran the verb, then re-derived
 * the same output path and re-parsed the file with the same eslint-disabled
 * read — a jscpd clone, and two copies of a path convention that must agree
 * with the one `runArdEmit` was given.
 */
async function emitAndRead(root: string): Promise<{
  result: Awaited<ReturnType<typeof runArdEmit>>;
  manifest: { '@context'?: string; entries: Array<Record<string, unknown>> };
}> {
  const outputPath = safePath.join(root, 'out', 'ard.json');
  const result = await runArdEmit({ projectRoot: root, output: outputPath });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
  const manifest = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
    '@context'?: string;
    entries: Array<Record<string, unknown>>;
  };
  return { result, manifest };
}

describe('runArdEmit', () => {
  it('writes a manifest carrying every derived entry', async () => {
    const root = projectWithSkill(workDir, 'emits', CONFIG_YAML_WITH_ARD);

    const { result, manifest } = await emitAndRead(root);

    expect(result.entryCount).toBe(1);
    expect(manifest['@context']).toContain('agenticresourcediscovery.org');
    expect(manifest.entries[0]?.identifier).toBe(`urn:air:example.com:skills:${PUBLISHED_SKILL}`);
    expect(manifest.entries[0]?.type).toBe('application/ai-skill+md');
    expect(manifest.entries[0]?.url).toBe(`https://example.com/catalog/skills/${PUBLISHED_SKILL}`);
  });

  it('refuses when the project declares no `ard` block at all', async () => {
    const root = projectWith(workDir, 'no-ard', CONFIG_YAML_WITHOUT_ARD);
    await expect(
      runArdEmit({ projectRoot: root, output: safePath.join(root, 'ard.json') })
    ).rejects.toBeInstanceOf(ArdConfigMissingError);
  });

  it('refuses when no config file is found at all', async () => {
    const root = projectWith(workDir, 'bare', CONFIG_YAML_WITHOUT_ARD);
    removeConfigFile(root);
    await expect(
      runArdEmit({ projectRoot: root, output: safePath.join(root, 'ard.json') })
    ).rejects.toBeInstanceOf(ArdConfigMissingError);
  });
});

describe('ardEmitCommand exit behaviour', () => {
  // 🚨 This case was named "when derivation fails" and handed a config with no
  // `ard:` block at all — the OTHER arm of exit 1, and one three cases below
  // already cover. The derivation arm, which is the half a CI author is most
  // likely to hit, was never executed: `ard.baseUrl` absent means no surface can
  // satisfy ARD's `url` XOR `data`, and that is a refusal, not a system error.
  it('exits 1 when a surface cannot be derived into a conformant entry', async () => {
    const root = projectWithSkill(workDir, 'exit-one-derivation', CONFIG_YAML_ARD_WITHOUT_BASE_URL);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCalls: unknown[][] = [];
    let stderr = '';
    try {
      await ardEmitCommand({ projectRoot: root, output: safePath.join(root, 'ard.json') });
      // 🪤 Read the calls BEFORE restoring: `mockRestore()` resets the spy,
      // which clears `mock.calls` — asserting afterwards sees zero calls and
      // fails for a reason that has nothing to do with the code under test.
      exitCalls = exitSpy.mock.calls;
      stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(exitCalls).toEqual([[1]]);
    expect(stderr).toMatch(/ard\.baseUrl/);
  });
});

describe('collectArdSurfaces — config keys are cross-checked against discovery', () => {
  // 🚨 `ard emit` advertised every `skills.config` key with no existence check,
  // so a project with NO `skills/` directory and two config keys published two
  // entries carrying real URLs at exit 0, with nothing on stderr — a discovery
  // document that is entirely 404s. The `skipped` channel exists precisely so a
  // surface is never silently DROPPED; silently INVENTING one had no guard.
  it('skips a config key no discovered skill answers to', () => {
    const { surfaces, skipped } = collectArdSurfaces(SKILLS_PROJECT, { discoveredSkills: [] });

    expect(surfaces).toHaveLength(0);
    expect(skipped.find((s) => s.name === PUBLISHED_SKILL)?.reason).toMatch(/discover/i);
  });

  it('emits a config key that discovery confirms', () => {
    const { surfaces, skipped } = collectArdSurfaces(SKILLS_PROJECT, {
      discoveredSkills: [PUBLISHED_SKILL],
    });

    expect(surfaces.map((s) => s.name)).toEqual([PUBLISHED_SKILL]);
    expect(skipped.filter((s) => s.name === PUBLISHED_SKILL)).toHaveLength(0);
  });

  it('does not report an unpublished skill twice', () => {
    const { skipped } = collectArdSurfaces(SKILLS_PROJECT, { discoveredSkills: [] });

    expect(skipped.filter((s) => s.name === UNPUBLISHED_SKILL)).toHaveLength(1);
  });
});

describe('runArdEmit — a manifest never advertises a skill that is not there', () => {
  it('advertises nothing, and says why, for config keys with no SKILL.md', async () => {
    const root = projectWith(workDir, 'ghosts', CONFIG_YAML_WITH_ARD);
    const outputPath = safePath.join(root, 'out', 'ard.json');

    const result = await runArdEmit({ projectRoot: root, output: outputPath });

    expect(result.entryCount).toBe(0);
    expect(result.skipped.map((s) => s.name)).toContain(PUBLISHED_SKILL);
    expect(result.skipped[0]?.reason).toMatch(/discover/i);
  });

  it('omits an empty package.json `version` rather than emitting one', async () => {
    // 🚨 `"version": ""` reached the entry and emitted `"version": ""` at exit
    // 0 — a field asserting a version that is not one.
    const root = projectWithSkill(workDir, 'blank-version', CONFIG_YAML_WITH_ARD);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
    writeFileSync(safePath.join(root, 'package.json'), '{"name":"x","version":""}\n', 'utf-8');

    const { result, manifest } = await emitAndRead(root);

    expect(result.entryCount).toBe(1);
    expect(manifest.entries[0]).not.toHaveProperty('version');
  });
});

describe('runArdEmit — which of the three absences it is', () => {
  // 🚨 `--project-root /nope/nothing/here` reported "No `ard:` configuration
  // found", prescribing an edit to a file in a directory that does not exist.
  // `loadConfig` returns `undefined` for both "no directory" and "no config
  // file", so the command had to stat the root itself to tell them apart.
  it('says the project root does not exist, and does not prescribe a config edit', async () => {
    const missing = safePath.join(workDir, 'definitely-not-here');

    await expect(
      runArdEmit({ projectRoot: missing, output: safePath.join(workDir, 'x.json') })
    ).rejects.toThrow(/does not exist/i);
  });

  it('says the config FILE is missing when the root exists but carries none', async () => {
    const root = projectWith(workDir, 'no-file', CONFIG_YAML_WITHOUT_ARD);
    removeConfigFile(root);

    await expect(
      runArdEmit({ projectRoot: root, output: safePath.join(root, 'ard.json') })
    ).rejects.toThrow(/vibe-agent-toolkit\.config\.yaml/);
  });

  it('still names the `ard:` block when the config exists without one', async () => {
    const root = projectWith(workDir, 'no-block', CONFIG_YAML_WITHOUT_ARD);

    await expect(
      runArdEmit({ projectRoot: root, output: safePath.join(root, 'ard.json') })
    ).rejects.toThrow(/`ard:`/);
  });
});

describe('ardEmitCommand exit codes agree with the help text', () => {
  // 🚨 The command's own help published exit 2 as "Unexpected internal
  // failure", yet EVERY config-shape mistake exits 2 — `ard.publisher: "My
  // Company"` produced the carefully-written adopter message at EXIT=2, so CI
  // reading 2 as a crash pages someone for a typo. The sibling
  // `vat okf validate` labels 2 "System error" and enumerates user-input causes
  // under it; that is the label this command now uses, and a missing config
  // FILE moves to 2 to match the sibling for the same condition.
  const exitCodeFor = async (root: string): Promise<unknown[][]> => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls: unknown[][] = [];
    try {
      await ardEmitCommand({ projectRoot: root, output: safePath.join(workDir, 'exit.json') });
      calls = exitSpy.mock.calls;
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
    return calls;
  };

  it('exits 2 when the project root does not exist', async () => {
    expect(await exitCodeFor(safePath.join(workDir, 'still-not-here'))).toEqual([[2]]);
  });

  it('exits 2 when no config file is found, as `vat okf validate` does', async () => {
    const root = projectWith(workDir, 'exit-two-file', CONFIG_YAML_WITHOUT_ARD);
    removeConfigFile(root);
    expect(await exitCodeFor(root)).toEqual([[2]]);
  });

  it('exits 1 when the config exists but declares no `ard:` block', async () => {
    const root = projectWith(workDir, 'exit-one-block', CONFIG_YAML_WITHOUT_ARD);
    expect(await exitCodeFor(root)).toEqual([[1]]);
  });

  it('exits 1 for BOTH arms the help puts under 1, and publishes both', () => {
    // 🚨 The commit footer said "a missing ARD config now exits 2", which is
    // false for the commonest case — a config file that exists with no `ard:`
    // block still exits 1. The RULE the code implements: exit 1 means VAT read
    // this project and produced no manifest by its own rules (no `ard:` block,
    // or a surface it could not derive); exit 2 means it never got that far (no
    // root, no config file, a config it cannot parse, an internal failure).
    // Pinned against the HELP, so the two cannot drift apart again.
    const emit = createArdCommand().commands.find((c) => c.name() === 'emit');
    let help = '';
    emit?.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    emit?.outputHelp();

    const exitOneLine = help.split('\n').find((line) => line.includes('1 - ')) ?? '';
    expect(exitOneLine).toMatch(/`ard:` block/);
    expect(exitOneLine).toMatch(/derived/);
  });

  it('publishes exit 2 as a system error, not an internal failure', () => {
    const emit = createArdCommand().commands.find((c) => c.name() === 'emit');
    // `helpInformation()` renders only the generated body — the Exit Codes
    // block lives in an `addHelpText('after')` hook, which only `outputHelp()`
    // runs. Asserting on the former would pass no matter what the block said.
    let help = '';
    emit?.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    emit?.outputHelp();

    expect(help).toMatch(/2 - System error/);
    expect(help).not.toMatch(/Unexpected internal failure/);
  });
});

describe('collectArdSurfaces — the QUALIFIED override key outranks the bare one', () => {
  // 🚨 This site carried its own copy of the precedence rule, and neither copy
  // was pinned: two mutations reversing them to bare-first stayed green across
  // the whole suite. Here the rule decides EMITTABILITY — a marketplace is
  // advertised only if the block that wins carries a `type` — so a reversal
  // publishes, or hides, a surface with nothing on stderr to say so.
  const marketplaceOf = (config: ReturnType<typeof projectWithMarketplaceOverrides>) =>
    collectArdSurfaces(config, { discoveredSkills: [PUBLISHED_SKILL] });

  it('emits the marketplace when only the QUALIFIED block carries a type', () => {
    const { surfaces } = marketplaceOf(
      projectWithMarketplaceOverrides({
        [FIXTURE_MARKETPLACE]: { capabilities: ['FromBareKey'] },
        [QUALIFIED_MARKETPLACE_KEY]: { type: VENDOR_CATALOG_TYPE },
      })
    );
    expect(surfaces.map((s) => s.kind)).toContain('marketplace');
  });

  it('skips the marketplace when the QUALIFIED block carries none, whatever the bare one says', () => {
    const { surfaces, skipped } = marketplaceOf(
      projectWithMarketplaceOverrides({
        [FIXTURE_MARKETPLACE]: { type: VENDOR_CATALOG_TYPE },
        [QUALIFIED_MARKETPLACE_KEY]: { capabilities: ['FromQualifiedKey'] },
      })
    );
    expect(surfaces.map((s) => s.kind)).not.toContain('marketplace');
    expect(skipped.find((s) => s.kind === 'marketplace')?.reason).toMatch(/ard\.entries/);
  });
});

describe('runArdEmit — a bare override block that loses is NAMED, not dropped', () => {
  // The precedence rule is deterministic and documented, so this is not an
  // error. But the losing block is dead config the author cannot see is dead —
  // the same silence the ambiguity refusal exists to end.
  it('reports the shadowed bare key beside the qualified one that won', async () => {
    const root = projectWithSkill(workDir, 'shadowed', CONFIG_YAML_ARD_SHADOWED_KEYS);

    const { result, manifest } = await emitAndRead(root);

    expect(manifest.entries[0]?.capabilities).toEqual(['FromQualifiedKey']);

    expect(result.shadowed).toEqual([
      {
        kind: 'skill',
        name: PUBLISHED_SKILL,
        shadowedKey: PUBLISHED_SKILL,
        winningKey: `skill:${PUBLISHED_SKILL}`,
      },
    ]);
  });

  // 🪤 A fact on the result object nobody prints is the same silence in a new
  // place — the report has to reach the terminal, and only running the COMMAND
  // proves that it does.
  it('says so on stderr, and still exits 0', async () => {
    const root = projectWithSkill(workDir, 'shadowed-stderr', CONFIG_YAML_ARD_SHADOWED_KEYS);
    const { stderr, exitCalls } = await captureEmit(root);

    expect(stderr).toContain(`ard.entries.${PUBLISHED_SKILL}`);
    expect(stderr).toContain(`ard.entries."skill:${PUBLISHED_SKILL}"`);
    expect(exitCalls).toEqual([]);
  });
});

describe('runArdEmit — a dot segment never reaches a published address', () => {
  // 🚨 `ard.namespace: ".."` emitted `https://example.com/tenants/acme/<name>`
  // for a base of `…/acme/catalog` at exit 0: the manifest addressed one level
  // above where its own identifiers say the resources live.
  it('refuses a config whose namespace is a dot segment, and writes nothing', async () => {
    const root = projectWithSkill(workDir, 'dot-namespace', CONFIG_YAML_ARD_DOT_NAMESPACE);
    const outputPath = safePath.join(root, 'out', 'ard.json');

    await expect(runArdEmit({ projectRoot: root, output: outputPath })).rejects.toThrow(
      /namespace/i
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe('createArdCommand', () => {
  it('registers an `emit` subcommand', () => {
    const command = createArdCommand();
    expect(command.name()).toBe('ard');
    expect(command.commands.map((c) => c.name())).toContain('emit');
  });
});

/**
 * A run that advertises nothing has to be visible to a MACHINE.
 *
 * 🚨 `vat ard emit` over a config declaring `skills.config.ghost` with no
 * `skills/` directory wrote `{"entries":[]}`, printed `Wrote 0 ARD entries`, put
 * the reason on stderr and exited 0. A CI step that emits and publishes is
 * therefore GREEN over a discovery document advertising nothing, and there was
 * nothing on stdout to gate on: no `--format`, and the help's "Exit Codes"
 * section listed only `0 - Manifest written`, so a reader could not learn that
 * stderr may carry findings at exit 0.
 *
 * The empty manifest itself is a legal artifact and the default exit code stays
 * 0 — changing it would break every adopter whose repository legitimately
 * declares nothing yet. What is fixed is that the run now PUBLISHES what it
 * skipped, and says so in its own help.
 */
describe('ardEmitCommand — a zero-entry run is machine-readable and documented', () => {
  /** A config naming one skill that is on disk and one that is not. */
  const CONFIG_YAML_ARD_ONE_GHOST = [
    'version: 1',
    'skills:',
    '  include: ["skills/**/SKILL.md"]',
    '  config:',
    `    ${PUBLISHED_SKILL}: {}`,
    '    ghost-skill: {}',
    'ard:',
    `  publisher: ${FIXTURE_PUBLISHER}`,
    '  baseUrl: https://example.com/catalog',
    '',
  ].join('\n');

  /**
   * A project that opted into ARD and declares no surface at all.
   *
   * 🪤 Distinct from the ghost-skill fixture, and the distinction is what makes
   * the EMPTY arm of `--strict` testable: every other zero-entry fixture here
   * also skips a surface, so a case handed one of those exits 1 through the
   * skip branch and proves nothing about the empty one.
   */
  const CONFIG_YAML_ARD_NO_SURFACES = [
    'version: 1',
    'ard:',
    `  publisher: ${FIXTURE_PUBLISHER}`,
    '  baseUrl: https://example.com/catalog',
    '',
  ].join('\n');

  const reportFrom = (stdout: string): Record<string, unknown> =>
    JSON.parse(stdout) as Record<string, unknown>;

  it('publishes the skip count and the skipped surfaces as JSON', async () => {
    const root = projectWith(workDir, 'json-empty', CONFIG_YAML_WITH_ARD);

    const { stdout } = await captureEmit(root, { format: 'json' });

    const report = reportFrom(stdout);
    expect(report.entryCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.skipped).toEqual([
      expect.objectContaining({ name: PUBLISHED_SKILL, kind: 'skill' }),
    ]);
  });

  // The count is the thing a CI step reads; the LIST is the thing a human then
  // acts on. Both, or the report answers "how many" and not "which".
  it('separates a manifest that advertises nothing from one that advertises something', async () => {
    const empty = projectWith(workDir, 'json-status-empty', CONFIG_YAML_WITH_ARD);
    const full = projectWithSkill(workDir, 'json-status-written', CONFIG_YAML_WITH_ARD);

    const emptyReport = reportFrom((await captureEmit(empty, { format: 'json' })).stdout);
    const fullReport = reportFrom((await captureEmit(full, { format: 'json' })).stdout);

    expect(emptyReport.status).toBe('empty');
    expect(fullReport.status).toBe('written');
    expect(fullReport.entryCount).toBe(1);
    expect(fullReport.skippedCount).toBe(0);
  });

  it('keeps the default exit code at 0 over an empty manifest', async () => {
    const root = projectWith(workDir, 'default-exit-empty', CONFIG_YAML_ARD_NO_SURFACES);

    const { exitCalls, stdout } = await captureEmit(root, { format: 'json' });

    expect(reportFrom(stdout)).toMatchObject({ status: 'empty', skippedCount: 0 });
    expect(exitCalls).toEqual([]);
  });

  it('exits 1 under --strict when the manifest advertises nothing, skips or not', async () => {
    const root = projectWith(workDir, 'strict-empty', CONFIG_YAML_ARD_NO_SURFACES);

    const { exitCalls, stderr } = await captureEmit(root, { strict: true });

    expect(exitCalls).toEqual([[1]]);
    expect(stderr).toMatch(/--strict: the manifest advertises nothing/);
  });

  // The other half of the same gate, and a DIFFERENT run shape: entries were
  // written, so an assertion that only knew the empty case would pass here
  // while the surface nobody can reach went unreported.
  it('exits 1 under --strict when a configured surface was skipped, entries or not', async () => {
    const root = projectWithSkill(workDir, 'strict-skipped', CONFIG_YAML_ARD_ONE_GHOST);

    const { exitCalls, stdout } = await captureEmit(root, { strict: true, format: 'json' });

    const report = reportFrom(stdout);
    expect(report.entryCount).toBe(1);
    expect(report.skippedCount).toBe(1);
    expect(exitCalls).toEqual([[1]]);
  });

  it('exits 0 under --strict when every configured surface was emitted', async () => {
    const root = projectWithSkill(workDir, 'strict-clean', CONFIG_YAML_WITH_ARD);

    expect((await captureEmit(root, { strict: true })).exitCalls).toEqual([]);
  });

  // 🪤 Every case above calls the handler directly, which cannot see whether
  // Commander actually HANDS it the two new flags: an option declared
  // `--strict` that the handler reads as `options.strict` is one rename away
  // from a gate that is documented, tested and never reached. So this one
  // drives the parser.
  it('reaches the gate through the parsed command line, not just the handler', async () => {
    const root = projectWith(workDir, 'parsed-strict', CONFIG_YAML_WITH_ARD);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let exitCalls: unknown[][] = [];
    let stdout = '';
    let stderr = '';
    try {
      await createArdCommand().parseAsync(
        ['emit', '--project-root', root, '--output', safePath.join(root, 'out', 'ard.json'),
          '--format', 'json', '--strict'],
        { from: 'user' }
      );
      exitCalls = exitSpy.mock.calls;
      stdout = outSpy.mock.calls.map((call) => String(call[0])).join('');
      stderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    expect(reportFrom(stdout).status).toBe('empty');
    // 🪤 The exit code ALONE cannot see this: `process.exit` is mocked, so
    // Commander's own "unknown option" path exits 1 too — renaming the option
    // in the parser left this case green until it asserted on the message only
    // the gate writes.
    expect(stderr).toMatch(/--strict: 1 configured surface was not advertised/);
    expect(stderr).not.toMatch(/unknown option/i);
    expect(exitCalls).toEqual([[1]]);
  });

  // 🪤 A gate nobody can find is the banner-addressed-to-a-human shape: the
  // behaviour is only useful if the contract is READABLE from `--help`, which
  // is where a CI author looks before writing the step.
  it('publishes the zero-entry case and its gate in the exit-code contract', () => {
    const help = emitHelpText();

    // The whole exit-0 BLOCK, not its first line: the contract wraps, and an
    // assertion scoped to one line would pass or fail on where the text breaks
    // rather than on what it says.
    const lines = help.split('\n');
    const zeroAt = lines.findIndex((line) => line.includes('0 - '));
    const oneAt = lines.findIndex((line) => line.includes('1 - '));
    const exitZeroBlock = lines.slice(zeroAt, oneAt).join(' ');

    expect(exitZeroBlock).toMatch(/skip/i);
    expect(exitZeroBlock).toMatch(/advertises nothing/i);
    expect(help).toMatch(/--strict/);
    expect(help).toMatch(/--format/);
  });
});
