/**
 * `vat ard emit` — assembling surfaces out of the project config, and refusing
 * to invent the parts the ARD specification does not define.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

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

describe('runArdEmit', () => {
  it('writes a manifest carrying every derived entry', async () => {
    const root = projectWith(workDir, 'emits', CONFIG_YAML_WITH_ARD);
    const outputPath = safePath.join(root, 'out', 'ard.json');
    const result = await runArdEmit({ projectRoot: root, output: outputPath });
    expect(result.entryCount).toBe(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
    const manifest = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      '@context': string;
      entries: Array<{ identifier: string; type: string; url: string }>;
    };
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
    rmSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), { force: true });
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

describe('createArdCommand', () => {
  it('registers an `emit` subcommand', () => {
    const command = createArdCommand();
    expect(command.name()).toBe('ard');
    expect(command.commands.map((c) => c.name())).toContain('emit');
  });
});
