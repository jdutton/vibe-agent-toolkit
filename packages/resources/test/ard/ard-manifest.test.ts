/**
 * The `/.well-known/ard.json` document: build it, validate it, write it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ARD_CONTEXT_URI,
  ARD_WELL_KNOWN_PATH,
  buildArdEntry,
  buildArdManifest,
  writeArdManifest,
} from '../../src/ard/index.js';

import { MINIMAL_ARD_CONFIG, MINIMAL_SKILL_SURFACE, createArdOracle } from './ard-test-helpers.js';

const oracle = createArdOracle();
const workDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ard-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const entry = buildArdEntry(MINIMAL_SKILL_SURFACE, MINIMAL_ARD_CONFIG);

describe('buildArdManifest', () => {
  it('carries the ARD JSON-LD context and the entries array', () => {
    const manifest = buildArdManifest([entry]);
    expect(manifest['@context']).toBe(ARD_CONTEXT_URI);
    expect(manifest.entries).toHaveLength(1);
  });

  it('validates against the vendored ArdManifest definition', () => {
    const manifest = buildArdManifest([entry]);
    const ok = oracle.validateManifest(manifest);
    expect(ok, oracle.errorsOf(oracle.validateManifest)).toBe(true);
  });

  it('accepts an empty entries array — a publisher with nothing to advertise is well-formed', () => {
    expect(oracle.validateManifest(buildArdManifest([]))).toBe(true);
  });

  it('names the well-known path the spec publishes at', () => {
    expect(ARD_WELL_KNOWN_PATH).toBe('/.well-known/ard.json');
  });
});

describe('writeArdManifest', () => {
  it('writes pretty-printed JSON, creating parent directories', async () => {
    const outputPath = safePath.join(workDir, 'nested', 'out', 'ard.json');
    await writeArdManifest(buildArdManifest([entry]), outputPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
    const text = readFileSync(outputPath, 'utf-8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "entries"');
    expect(oracle.validateManifest(JSON.parse(text))).toBe(true);
  });

  it('round-trips through disk without changing the document', async () => {
    const outputPath = safePath.join(workDir, 'roundtrip.json');
    const manifest = buildArdManifest([entry]);
    await writeArdManifest(manifest, outputPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a test temp dir
    expect(JSON.parse(readFileSync(outputPath, 'utf-8'))).toEqual(manifest);
  });
});
