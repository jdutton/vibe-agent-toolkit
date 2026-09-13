/**
 * The unused-export ratchet's pure half: what knip's report becomes, how the
 * list is reconciled in BOTH directions, how a name is tagged, and what the
 * regenerated allowlist looks like. knip itself is not run here — the gate
 * (`bun run unused-exports`) is the integration.
 */

import { describe, expect, it } from 'vitest';

import type { UnusedExportFile } from '../src/unused-exports-allowlist.js';
import {
  classifyReason,
  flattenAllowlist,
  reconcile,
  renderAllowlist,
  reportedExportsOf,
} from '../src/unused-exports.js';

const ALLOWLIST: readonly UnusedExportFile[] = [
  { file: 'packages/a/src/x.ts', unused: [{ name: 'alpha', reason: 'test-only' }, { name: 'beta', reason: 'dead' }] },
  { file: 'packages/b/src/y.ts', unused: [{ name: 'gamma', reason: 'dead' }] },
];

describe('reportedExportsOf', () => {
  it('flattens every export kind knip reports, forward-slashed', () => {
    const reported = reportedExportsOf({
      issues: [
        { file: String.raw`packages\a\src\x.ts`, exports: [{ name: 'alpha' }], types: [{ name: 'Alpha' }] },
        { file: 'packages/b/src/y.ts', nsExports: [{ name: 'ns' }], nsTypes: [{ name: 'NsT' }] },
        { file: 'packages/c/package.json' },
      ],
    });

    expect(reported).toEqual([
      { file: 'packages/a/src/x.ts', name: 'alpha' },
      { file: 'packages/a/src/x.ts', name: 'Alpha' },
      { file: 'packages/b/src/y.ts', name: 'ns' },
      { file: 'packages/b/src/y.ts', name: 'NsT' },
    ]);
  });
});

describe('reconcile', () => {
  it('is clean when the report and the list agree', () => {
    const reported = flattenAllowlist(ALLOWLIST);

    expect(reconcile(reported, ALLOWLIST)).toEqual({ unlisted: [], stale: [] });
  });

  it('names a reported export the list does not carry', () => {
    const reported = [...flattenAllowlist(ALLOWLIST), { file: 'packages/a/src/x.ts', name: 'delta' }];

    expect(reconcile(reported, ALLOWLIST).unlisted).toEqual([{ file: 'packages/a/src/x.ts', name: 'delta' }]);
  });

  it('names a listed entry the report no longer carries — the list may only shrink', () => {
    const reported = flattenAllowlist(ALLOWLIST).filter((e) => e.name !== 'beta');

    expect(reconcile(reported, ALLOWLIST).stale).toEqual([{ file: 'packages/a/src/x.ts', name: 'beta', reason: 'dead' }]);
  });

  it('keys on file AND name, so the same name in another module is a different export', () => {
    const reported = [...flattenAllowlist(ALLOWLIST), { file: 'packages/b/src/y.ts', name: 'alpha' }];

    expect(reconcile(reported, ALLOWLIST).unlisted).toEqual([{ file: 'packages/b/src/y.ts', name: 'alpha' }]);
  });
});

describe('classifyReason', () => {
  const entry = { file: 'packages/a/src/x/y.ts', name: 'alpha' };
  const IMPORT = "import { alpha } from '../../src/x/y.js';";

  it('is test-only when a test imports the module and uses the name as a whole identifier', () => {
    expect(classifyReason(entry, [`${IMPORT}\nconst x = alpha();`])).toBe('test-only');
    expect(classifyReason(entry, ["import { alpha } from '../src/x/y';"])).toBe('test-only');
  });

  it('is dead when the name is used but the module is not imported — another module’s alpha', () => {
    expect(classifyReason(entry, ["import { alpha } from '../../src/other.js'; alpha();"])).toBe('dead');
  });

  it('is dead when the module is imported but the name appears only inside a longer identifier', () => {
    expect(classifyReason(entry, [`${IMPORT}\nconst alphabet = 1; alphaBeta(); _alpha;`.replace(IMPORT, "import { beta } from '../../src/x/y.js';")])).toBe('dead');
  });

  it('is dead when no test source mentions it at all', () => {
    expect(classifyReason(entry, ['nothing here', ''])).toBe('dead');
  });

  it('accepts a directory import for an index module', () => {
    const index = { file: 'packages/a/src/x/index.ts', name: 'alpha' };
    expect(classifyReason(index, ["import { alpha } from '../../src/x';"])).toBe('test-only');
    expect(classifyReason(index, ["import { alpha } from '../../src/x/index.js';"])).toBe('test-only');
  });

  it('treats `$` as part of an identifier', () => {
    const dollar = { file: 'packages/a/src/x/y.ts', name: '$q' };
    expect(classifyReason(dollar, ["import { z } from '../../src/x/y.js'; const $query = 1;"])).toBe('dead');
    expect(classifyReason(dollar, ["import { $q } from '../../src/x/y.js'; const v = $q;"])).toBe('test-only');
  });
});

describe('renderAllowlist', () => {
  it('groups by file, sorts files and names, and round-trips through the module shape', () => {
    const rendered = renderAllowlist([
      { file: 'packages/b/src/y.ts', name: 'gamma', reason: 'dead' },
      { file: 'packages/a/src/x.ts', name: 'beta', reason: 'dead' },
      { file: 'packages/a/src/x.ts', name: 'alpha', reason: 'test-only' },
    ]);

    expect(rendered).toContain("export const UNUSED_EXPORTS_ALLOWLIST: readonly UnusedExportFile[] = [");
    expect(rendered.indexOf("packages/a/src/x.ts")).toBeLessThan(rendered.indexOf("packages/b/src/y.ts"));
    expect(rendered.indexOf("name: 'alpha'")).toBeLessThan(rendered.indexOf("name: 'beta'"));
    expect(rendered).toContain("  { file: 'packages/b/src/y.ts', unused: [\n    { name: 'gamma', reason: 'dead' },\n  ] },");
  });

  it('renders an empty list as an empty array, not a broken module', () => {
    expect(renderAllowlist([])).toContain('readonly UnusedExportFile[] = [\n];');
  });
});
