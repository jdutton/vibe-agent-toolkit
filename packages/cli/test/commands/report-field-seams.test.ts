/**
 * Small pure derivations behind three verbs' documents: `resources scan`'s
 * per-collection counts, which phase report stops `vat build`, and a config
 * `license` value as `marketplace publish` composes it.
 */

import { buildErrorReport, buildReport } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { __internal as build } from '../../src/commands/build.js';
import { __internal as publish } from '../../src/commands/claude/marketplace/publish.js';
import { __internal as scan } from '../../src/commands/resources/scan.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';

const GATE = { strict: false };

describe('resources scan collection counts', () => {
  const stats = { collections: { docs: { resourceCount: 3 }, skills: { resourceCount: 1 } } };

  it('lists every collection, or only the one --collection names', () => {
    expect(scan.collectionCounts(stats, undefined)).toEqual({ docs: { resourceCount: 3 }, skills: { resourceCount: 1 } });
    expect(scan.collectionCounts(stats, 'skills')).toEqual({ skills: { resourceCount: 1 } });
    expect(scan.collectionCounts(undefined, undefined)).toEqual({});
  });
});

describe('vat build phase stop', () => {
  it('stops on a report that ends non-zero, never on a clean one', () => {
    const clean = buildReport({ examined: 1, findings: [], data: null, gate: GATE });
    const refused = buildErrorReport({ error: { code: 'CONFIG_INVALID', message: 'x' }, gate: GATE, examined: 0, findings: [], data: null });

    expect(build.stopsTheBuild({ name: 'skills', report: clean })).toBe(false);
    expect(build.stopsTheBuild({ name: 'skills', report: refused })).toBe(true);
  });
});

describe('marketplace publish license options', () => {
  it('reads a path as a file, an SPDX id as a rendered license, and refuses an unrenderable one', () => {
    expect(publish.resolveLicenseOptions('./LICENSE.md', 'Acme')).toEqual({ type: 'file', filePath: './LICENSE.md' });
    expect(publish.resolveLicenseOptions('MIT', 'Acme')).toEqual({ type: 'spdx', value: 'MIT', ownerName: 'Acme' });

    let refusal: unknown;
    try {
      publish.resolveLicenseOptions('NOT-A-REAL-LICENSE-ID', 'Acme');
    } catch (error) {
      refusal = error;
    }
    expect(refusalCodeOf(refusal)).toBe('CONFIG_INVALID');
  });
});
