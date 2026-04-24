import { describe, expect, it } from 'vitest';

import {
  renderProvenanceHeader,
  rewritePathsInResults,
  type Provenance,
} from '../../../src/commands/audit/provenance.js';

const TEMP_ROOT = '/fake-tmp/vat-audit-XXXX';
const GITHUB_URL = 'https://github.com/foo/bar.git';
const SUBPATH = 'plugins/baz';

describe('renderProvenanceHeader', () => {
  it('renders url + ref + commit on one line', () => {
    const p: Provenance = {
      url: GITHUB_URL,
      ref: 'main',
      commit: 'abc123de',
    };
    expect(renderProvenanceHeader(p)).toBe(
      `Audited: ${GITHUB_URL} @ main (commit abc123de)\n`
    );
  });

  it('includes a Subpath line when subpath is set', () => {
    const p: Provenance = {
      url: GITHUB_URL,
      ref: 'main',
      commit: 'abc123de',
      subpath: SUBPATH,
    };
    expect(renderProvenanceHeader(p)).toBe(
      `Audited: ${GITHUB_URL} @ main (commit abc123de)\n` +
        `Subpath: ${SUBPATH}\n`
    );
  });

  it('preserves SSH URL form as the user typed it', () => {
    const p: Provenance = {
      url: 'git@github.com:foo/bar.git',
      ref: 'main',
      commit: 'abc123de',
    };
    expect(renderProvenanceHeader(p)).toContain('git@github.com:foo/bar.git');
  });
});

describe('rewritePathsInResults', () => {
  it('rewrites path strings prefixed with the temp root', () => {
    const results = [
      { path: `${TEMP_ROOT}/${SUBPATH}/SKILL.md`, issues: [] },
      {
        path: `${TEMP_ROOT}/other/SKILL.md`,
        issues: [{ message: 'bad', file: `${TEMP_ROOT}/other/file.md` }],
        linkedFiles: [`${TEMP_ROOT}/other/sibling.md`],
      },
    ];
    const rewritten = rewritePathsInResults(results, TEMP_ROOT);
    expect(rewritten[0].path).toBe(`${SUBPATH}/SKILL.md`);
    expect(rewritten[1].path).toBe('other/SKILL.md');
    expect(rewritten[1].issues[0].file).toBe('other/file.md');
    expect(rewritten[1].linkedFiles[0]).toBe('other/sibling.md');
  });

  it('leaves paths that do not start with the temp root unchanged', () => {
    const results = [{ path: '/some/other/path.md', issues: [] }];
    const rewritten = rewritePathsInResults(results, TEMP_ROOT);
    expect(rewritten[0].path).toBe('/some/other/path.md');
  });

  it('does not mutate the input array', () => {
    const results = [{ path: `${TEMP_ROOT}/file.md`, issues: [] }];
    const original = structuredClone(results);
    rewritePathsInResults(results, TEMP_ROOT);
    expect(results).toEqual(original);
  });
});
