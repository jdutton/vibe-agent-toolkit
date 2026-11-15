/**
 * Every `osv-scanner.toml` ignore is held to the package versions it accepts, both ways: red when
 * another affected version resolves (the entry would hide it), red when an accepted version or the
 * package is gone (the entry is stale), red when an entry and its scope row do not pair up.
 */
import { describe, expect, it } from 'vitest';

import { type AcceptedAdvisory, osvIgnoreFindings, resolvedVersions } from '../src/osv-ignore-register.js';

const ID = 'GHSA-mrhx-c7xc-m3w5';
const SCOPES: Readonly<Record<string, AcceptedAdvisory>> = { [ID]: { package: 'zod', accepted: ['3.25.76'], affected: '<4.6.6' } };

/** A `bun.lock` packages block resolving each `[key, "name@version"]` tuple. */
function lockOf(...resolutions: ReadonlyArray<readonly [key: string, tuple: string]>): string {
  const lines = resolutions.map(([key, tuple]) => `    "${key}": ["${tuple}", "", {}, "sha512-x"],`);
  return ['{', '  "packages": {', '    "react": ["react@19.2.0", "", {}, "sha512-y"],', '    "zod-to-json-schema": ["zod-to-json-schema@3.24.6", "", { "peerDependencies": { "zod": "^3.24.1" } }, "sha512-z"],', ...lines, '  }', '}'].join('\n');
}

function entry(id: string, extra = ''): string {
  return `[[IgnoredVulns]]\nid = "${id}"\nignoreUntil = 2026-12-31\nreason = "accepted"\n${extra}`;
}

const REGISTER = entry(ID);

describe('resolvedVersions', () => {
  it('reads every resolved version, nested keys included, and no declared range or similarly named package', () => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', 'zod@4.6.7'], ['@langchain/core/zod', 'zod@4.6.7']);

    expect(resolvedVersions(lock, 'zod')).toEqual(['3.25.76', '4.6.7']);
  });

  // bun.lock keys an npm alias by the alias and writes the real package in the tuple; OSV reads the tuple.
  it('reads a version installed under an npm alias, whatever its key', () => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['zod-v3', 'zod@3.22.4'], ['some-pkg/legacy-schema', 'zod@4.5.1']);

    expect(resolvedVersions(lock, 'zod')).toEqual(['3.22.4', '3.25.76', '4.5.1']);
  });

  it('reads a scoped package by its full name, its regex metacharacters taken literally', () => {
    const lock = lockOf(['@hono/node-server', '@hono/node-server@1.19.17'], ['honoXnode-server', 'honoXnode-server@9.9.9']);

    expect(resolvedVersions(lock, '@hono/node-server')).toEqual(['1.19.17']);
    expect(resolvedVersions(lock, 'hono.node-server')).toEqual([]);
  });
});

describe('osvIgnoreFindings', () => {
  it("passes today's shape: the accepted version and fixed nested copies", () => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', 'zod@4.6.7'], ['@modelcontextprotocol/sdk/zod', 'zod@4.6.6']);

    expect(osvIgnoreFindings(lock, REGISTER, SCOPES)).toEqual([]);
  });

  it('passes an empty register with an empty table: nothing is ignored', () => {
    expect(osvIgnoreFindings(lockOf(['zod', 'zod@4.6.7']), '# no entries\n', {})).toEqual([]);
  });

  it.each(['4.5.1', '4.6.5', '4.6.6-beta.1', '3.25.75', '3.22.4'])('refuses another affected version, %s, that the entry would hide', (version) => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', `zod@${version}`]);

    expect(osvIgnoreFindings(lock, REGISTER, SCOPES)).toEqual([expect.stringContaining(`zod@${version} resolves`)]);
  });

  it('refuses once the accepted version is gone: the bump patched it, so the entry is stale', () => {
    const lock = lockOf(['zod', 'zod@4.6.7']);

    expect(osvIgnoreFindings(lock, REGISTER, SCOPES)).toEqual([expect.stringContaining('zod@3.25.76 no longer resolves')]);
  });

  it('refuses once the package is gone from bun.lock altogether', () => {
    expect(osvIgnoreFindings(lockOf(), REGISTER, SCOPES)).toEqual([expect.stringContaining(`delete the ${ID} entry`)]);
  });

  it('refuses one accepted version gone while another remains', () => {
    const scopes = { [ID]: { package: 'zod', accepted: ['3.25.76', '3.24.0'], affected: '<4.6.6' } };

    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), REGISTER, scopes)).toEqual([expect.stringContaining('zod@3.24.0 no longer resolves')]);
  });

  it.each(['github:colinhacks/zod#abc123', 'workspace:packages/zod', 'https://example.test/zod-3.22.4.tgz'])('reports a version resolved from %s as a finding, not a crash: no version says whether it is affected', (source) => {
    const lock = lockOf(['zod', 'zod@3.25.76'], ['knip/zod', `zod@${source}`]);

    expect(osvIgnoreFindings(lock, REGISTER, SCOPES)).toEqual([expect.stringContaining(`zod@${source}`)]);
  });

  it('refuses an entry with no scope row: an unscoped ignore hides its advisory everywhere', () => {
    const register = `${REGISTER}\n${entry('GHSA-aaaa-bbbb-cccc')}`;

    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), register, SCOPES)).toEqual([expect.stringContaining('GHSA-aaaa-bbbb-cccc, which has no ACCEPTED_ADVISORIES row')]);
  });

  it('refuses a scope row with no entry: the table only ratchets if it is asserted both ways', () => {
    expect(osvIgnoreFindings(lockOf(['zod', 'zod@4.6.7']), '# no entries\n', SCOPES)).toEqual([expect.stringContaining(`scopes ${ID}, which osv-scanner.toml no longer ignores`)]);
  });

  it('refuses a commented-out entry the same way: it ignores nothing, so its row is stale', () => {
    const commented = REGISTER.split('\n').map((line) => `# ${line}`).join('\n');

    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), commented, SCOPES)).toEqual([expect.stringContaining('no longer ignores')]);
  });

  it.each([
    ['reason', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 2026-12-31\n`, 'has no `reason`'],
    ['blank reason', `[[IgnoredVulns]]\nid = "${ID}"\nignoreUntil = 2026-12-31\nreason = "  "\n`, 'has no `reason`'],
    ['ignoreUntil', `[[IgnoredVulns]]\nid = "${ID}"\nreason = "accepted"\n`, 'has no `ignoreUntil`'],
  ])('refuses an entry with no %s', (_field, register, message) => {
    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), register, SCOPES)).toEqual([expect.stringContaining(message)]);
  });

  it('refuses a [[PackageOverrides]] table: it ignores wider than one advisory and nothing scopes it', () => {
    const register = `${REGISTER}\n[[PackageOverrides]]\nname = "zod"\nignore = true\n`;

    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), register, SCOPES)).toEqual([expect.stringContaining('declares `PackageOverrides`')]);
  });

  it.each([
    ['a string', 'IgnoredVulns = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['an array holding a non-table', 'IgnoredVulns = ["GHSA-mrhx-c7xc-m3w5"]\n'],
  ])('refuses IgnoredVulns written as %s rather than an array of tables', (_shape, register) => {
    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), register, {})).toEqual([expect.stringContaining('not an array of tables')]);
  });

  it('reads an id quoted inside another entry\'s multi-line reason as content, not an entry', () => {
    const register = `[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\nignoreUntil = 2026-12-31\nreason = """\nid = "${ID}"\n"""\n`;

    expect(osvIgnoreFindings(lockOf(['zod', 'zod@3.25.76']), register, SCOPES)).toEqual([
      expect.stringContaining('GHSA-0000-0000-0000, which has no ACCEPTED_ADVISORIES row'),
      expect.stringContaining('no longer ignores'),
    ]);
  });
});
