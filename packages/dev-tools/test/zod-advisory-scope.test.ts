/**
 * The zod advisory's register entry is scoped to `zod@3.25.76` by this check, not by a comment:
 * red when another affected zod resolves (the entry would hide it), red when 3.25.76 is gone (the
 * entry is stale), red when the entry itself is gone (this check is stale).
 */
import { describe, expect, it } from 'vitest';

import { resolvedZodVersions, zodAdvisoryScopeFindings } from '../src/zod-advisory-scope.js';

/** A `bun.lock` packages block resolving zod at each version, under nested keys where asked. */
function lockOf(...resolutions: ReadonlyArray<readonly [key: string, version: string]>): string {
  const lines = resolutions.map(([key, version]) => `    "${key}": ["zod@${version}", "", {}, "sha512-x"],`);
  return ['{', '  "packages": {', '    "react": ["react@19.2.0", "", {}, "sha512-y"],', '    "zod-to-json-schema": ["zod-to-json-schema@3.24.6", "", { "peerDependencies": { "zod": "^3.24.1" } }, "sha512-z"],', ...lines, '  }', '}'].join('\n');
}

const REGISTER = '[[IgnoredVulns]]\nid = "GHSA-mrhx-c7xc-m3w5"\nignoreUntil = 2026-12-31\n';

describe('resolvedZodVersions', () => {
  it('reads every resolved zod, nested keys included, and no declared range or similarly named package', () => {
    const lock = lockOf(['zod', '3.25.76'], ['knip/zod', '4.6.7'], ['@langchain/core/zod', '4.6.7']);

    expect(resolvedZodVersions(lock)).toEqual(['3.25.76', '4.6.7']);
  });

  // bun.lock keys an npm alias by the alias and writes the real package in the tuple; OSV reads the tuple.
  it('reads a zod installed under an npm alias, whatever its key', () => {
    const lock = lockOf(['zod', '3.25.76'], ['zod-v3', '3.22.4'], ['some-pkg/legacy-schema', '4.5.1']);

    expect(resolvedZodVersions(lock)).toEqual(['3.22.4', '3.25.76', '4.5.1']);
  });
});

describe('zodAdvisoryScopeFindings', () => {
  it('passes today\'s shape: 3.25.76 and fixed nested copies', () => {
    const lock = lockOf(['zod', '3.25.76'], ['knip/zod', '4.6.7'], ['@modelcontextprotocol/sdk/zod', '4.6.6']);

    expect(zodAdvisoryScopeFindings(lock, REGISTER)).toEqual([]);
  });

  it.each(['4.5.1', '4.6.5', '4.6.6-beta.1', '3.25.75', '3.22.4'])('refuses another affected zod, %s, that the entry would hide', (version) => {
    const lock = lockOf(['zod', '3.25.76'], ['knip/zod', version]);

    expect(zodAdvisoryScopeFindings(lock, REGISTER)).toEqual([expect.stringContaining(`zod@${version}`)]);
  });

  it('refuses once 3.25.76 is gone: the entry is stale and must be deleted', () => {
    const lock = lockOf(['zod', '4.6.7']);

    expect(zodAdvisoryScopeFindings(lock, REGISTER)).toEqual([expect.stringContaining('delete the GHSA-mrhx-c7xc-m3w5 entry')]);
  });

  it('refuses once the entry is gone: this check guards nothing and is deleted with it', () => {
    const lock = lockOf(['zod', '4.6.7']);

    expect(zodAdvisoryScopeFindings(lock, '# no entries\n')).toEqual([expect.stringContaining('delete this check')]);
  });

  it('refuses an affected zod installed under an npm alias, which the entry would hide', () => {
    const lock = lockOf(['zod', '3.25.76'], ['zod-v3', '3.22.4']);

    expect(zodAdvisoryScopeFindings(lock, REGISTER)).toEqual([expect.stringContaining('zod@3.22.4')]);
  });

  it.each(['github:colinhacks/zod#abc123', 'workspace:packages/zod', 'https://example.test/zod-3.22.4.tgz'])('reports a zod resolved from %s as a finding, not a crash: no version says whether it is affected', (source) => {
    const lock = lockOf(['zod', '3.25.76'], ['knip/zod', source]);

    expect(zodAdvisoryScopeFindings(lock, REGISTER)).toEqual([expect.stringContaining(`zod@${source}`)]);
  });

  it('refuses once the entry is commented out: it ignores nothing, so this check guards nothing', () => {
    const lock = lockOf(['zod', '3.25.76']);
    const commented = REGISTER.split('\n').map((line) => `# ${line}`).join('\n');

    expect(zodAdvisoryScopeFindings(lock, commented)).toEqual([expect.stringContaining('delete this check')]);
  });

  it.each([
    ['under another table', '[[PackageOverrides]]\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['quoted inside another entry\'s multi-line reason', '[[IgnoredVulns]]\nid = "GHSA-0000-0000-0000"\nreason = """\nid = "GHSA-mrhx-c7xc-m3w5"\n"""\n'],
    // An implementation that sets the in-table flag on the first [[IgnoredVulns]] and never resets it passes the row above.
    ['under a table that FOLLOWS an [[IgnoredVulns]] entry', '[[IgnoredVulns]]\nid = "OTHER"\n[[PackageOverrides]]\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
    // A literal delimiter does not close a basic multi-line string, nor the reverse.
    ['inside a basic multi-line string that quotes a literal delimiter', '[[IgnoredVulns]]\nreason = """\nit\'s \'\'\' quoted\nid = "GHSA-mrhx-c7xc-m3w5"\n"""\n'],
    ['inside a literal multi-line string that quotes a basic delimiter', '[[IgnoredVulns]]\nreason = \'\'\'\nsays """ here\nid = "GHSA-mrhx-c7xc-m3w5"\n\'\'\'\n'],
    // An escaped quote is content in a basic string, so a backslash before the delimiter does not close it.
    ['inside a basic multi-line string past an escaped delimiter', '[[IgnoredVulns]]\nreason = """\nan escaped \\""" stays open\nid = "GHSA-mrhx-c7xc-m3w5"\n"""\n'],
    // A delimiter inside a one-line string opens nothing.
    ['inside a multi-line string after a one-line string quoting the other delimiter', '[[IgnoredVulns]]\nnote = "a \'\'\' in a basic string"\nreason = """\nid = "GHSA-mrhx-c7xc-m3w5"\n"""\n'],
  ])('refuses an id line %s: OSV-Scanner ignores nothing for it', (_where, register) => {
    expect(zodAdvisoryScopeFindings(lockOf(['zod', '3.25.76']), register)).toEqual([expect.stringContaining('delete this check')]);
  });

  it.each([
    ['after a multi-line string closed on the line it opened', '[[IgnoredVulns]]\nreason = """one line"""\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['after a multi-line string that quotes the other delimiter and closes', '[[IgnoredVulns]]\nreason = """\nit\'s \'\'\' quoted\n"""\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['after a basic multi-line string closed with extra quotes', '[[IgnoredVulns]]\nreason = """\nends with a quote""""\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
    ['after a one-line string quoting a delimiter', '[[IgnoredVulns]]\nnote = "a \'\'\' in a basic string"\nid = "GHSA-mrhx-c7xc-m3w5"\n'],
  ])('reads an id line %s as the entry', (_where, register) => {
    expect(zodAdvisoryScopeFindings(lockOf(['zod', '3.25.76']), register)).toEqual([]);
  });

  it('reads a literal-string id as the entry OSV-Scanner reads it as', () => {
    expect(zodAdvisoryScopeFindings(lockOf(['zod', '3.25.76']), REGISTER.replace('"GHSA-mrhx-c7xc-m3w5"', "'GHSA-mrhx-c7xc-m3w5'"))).toEqual([]);
  });

  it('refuses a lockfile with no zod at all rather than passing an empty population', () => {
    expect(zodAdvisoryScopeFindings(lockOf(), REGISTER)).toEqual([expect.stringContaining('resolves no zod')]);
  });
});
