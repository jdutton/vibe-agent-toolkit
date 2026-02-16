import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeCompatibility } from '../src/compatibility-analyzer.js';
import type { CompatibilityEvidence } from '../src/types.js';

import { verdicts } from './test-helpers.js';

const fixtureDir = (name: string) => resolve(import.meta.dirname, 'fixtures', name);
const hasSource = (evidence: CompatibilityEvidence[], source: string) =>
  evidence.some((e: CompatibilityEvidence) => e.source === source);

describe('analyzeCompatibility', () => {
  it('marks pure instruction plugin as compatible everywhere', async () => {
    const result = await analyzeCompatibility(fixtureDir('pure-instruction-plugin'));
    expect(result.plugin).toBe('pure-instruction');
    expect(result.analyzed).toEqual(verdicts('compatible', 'compatible', 'compatible'));
    expect(result.evidence).toEqual([]);
  });

  it('flags python script plugin as needs-review for desktop', async () => {
    const result = await analyzeCompatibility(fixtureDir('python-script-plugin'));
    expect(result.analyzed).toEqual(verdicts('needs-review', 'compatible', 'compatible'));
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(hasSource(result.evidence, 'code-block')).toBe(true);
    expect(hasSource(result.evidence, 'script')).toBe(true);
  });

  it('flags desktop-incompatible plugin as incompatible for desktop', async () => {
    const result = await analyzeCompatibility(fixtureDir('desktop-incompatible-plugin'));
    expect(result.analyzed['claude-desktop']).toBe('incompatible');
    expect(hasSource(result.evidence, 'frontmatter')).toBe(true);
  });

  it('detects hook handler runtime requirements', async () => {
    const result = await analyzeCompatibility(fixtureDir('hook-heavy-plugin'));
    expect(result.analyzed['claude-desktop']).toBe('needs-review');
    expect(hasSource(result.evidence, 'hook')).toBe(true);
  });

  it('handles node MCP server as compatible', async () => {
    const result = await analyzeCompatibility(fixtureDir('mcp-plugin'));
    expect(result.analyzed['claude-desktop']).toBe('compatible');
  });

  it('marks node-bundled plugin as compatible everywhere', async () => {
    const result = await analyzeCompatibility(fixtureDir('node-bundled-plugin'));
    expect(result.analyzed).toEqual(verdicts('compatible', 'compatible', 'compatible'));
  });

  it('includes summary counts', async () => {
    const result = await analyzeCompatibility(fixtureDir('python-script-plugin'));
    expect(result.summary.totalFiles).toBeGreaterThan(0);
    expect(result.summary.scriptFiles).toBeGreaterThan(0);
    expect(result.summary.skillFiles).toBeGreaterThan(0);
  });

  it('throws for directory without plugin.json', async () => {
    const nonexistent = resolve(import.meta.dirname, 'fixtures', 'nonexistent');
    await expect(analyzeCompatibility(nonexistent))
      .rejects.toThrow();
  });
});
