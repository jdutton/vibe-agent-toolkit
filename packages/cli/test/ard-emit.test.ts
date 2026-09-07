/**
 * `vat ard emit` — assembling surfaces out of the project config, and refusing
 * to invent the parts the ARD specification does not define.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { ArdConfigMissingError, ardEmitCommand, runArdEmit } from '../src/commands/ard/emit.js';
import { createArdCommand } from '../src/commands/ard/index.js';
import { collectArdSurfaces } from '../src/commands/ard/surfaces.js';

import {
  CONFIG_YAML_WITHOUT_ARD,
  CONFIG_YAML_WITH_ARD,
  PUBLISHED_SKILL,
  SKILLS_PROJECT,
  UNPUBLISHED_SKILL,
  projectWith,
  projectWithMarketplace,
  projectWithSkill,
  removeConfigFile,
} from './ard-test-helpers.js';

const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ard-cli-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

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
      projectWithMarketplace('application/x-vendor-catalog+json'),
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
  it('exits non-zero when derivation fails', async () => {
    const root = projectWith(workDir, 'exit-one', CONFIG_YAML_WITHOUT_ARD);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCalls: unknown[][] = [];
    try {
      await ardEmitCommand({ projectRoot: root, output: safePath.join(root, 'ard.json') });
      // 🪤 Read the calls BEFORE restoring: `mockRestore()` resets the spy,
      // which clears `mock.calls` — asserting afterwards sees zero calls and
      // fails for a reason that has nothing to do with the code under test.
      exitCalls = exitSpy.mock.calls;
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(exitCalls).toEqual([[1]]);
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

describe('createArdCommand', () => {
  it('registers an `emit` subcommand', () => {
    const command = createArdCommand();
    expect(command.name()).toBe('ard');
    expect(command.commands.map((c) => c.name())).toContain('emit');
  });
});
