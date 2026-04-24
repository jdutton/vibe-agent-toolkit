import { describe, expect, it } from 'vitest';

import { isGitUrl, parseGitUrl, type ParsedGitUrl } from '../../src/utils/git-url.js';

const HTTPS_CLONE_URL = 'https://github.com/foo/bar.git';
const SSH_URL_FORM = 'ssh://git@github.com/foo/bar.git';
const SSH_CLONE_URL = 'git@github.com:foo/bar.git';
const SUBPATH_BAZ = 'plugins/baz';
const TOO_MANY_SLASHES = 'foo/bar/baz';
const INVALID_URL_PATTERN = /Invalid git URL/;

describe('parseGitUrl — HTTPS forms', () => {
  const cases: Array<{ name: string; input: string; expected: ParsedGitUrl }> = [
    {
      name: 'plain HTTPS .git URL',
      input: HTTPS_CLONE_URL,
      expected: { cloneUrl: HTTPS_CLONE_URL },
    },
    {
      name: 'HTTPS .git URL with ref',
      input: `${HTTPS_CLONE_URL}#v1.2.3`,
      expected: { cloneUrl: HTTPS_CLONE_URL, ref: 'v1.2.3' },
    },
    {
      name: 'HTTPS .git URL with ref + subpath',
      input: `${HTTPS_CLONE_URL}#main:${SUBPATH_BAZ}`,
      expected: {
        cloneUrl: HTTPS_CLONE_URL,
        ref: 'main',
        subpath: SUBPATH_BAZ,
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(parseGitUrl(c.input)).toEqual(c.expected);
    });
  }
});

describe('parseGitUrl — GitHub web URL form', () => {
  it('parses /tree/<ref>/<subpath>', () => {
    expect(parseGitUrl(`https://github.com/foo/bar/tree/main/${SUBPATH_BAZ}`)).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      ref: 'main',
      subpath: SUBPATH_BAZ,
    });
  });

  it('parses /tree/<ref> with no subpath', () => {
    expect(parseGitUrl('https://github.com/foo/bar/tree/v1.2.3')).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      ref: 'v1.2.3',
    });
  });
});

describe('parseGitUrl — GitHub shorthand', () => {
  it('expands `owner/repo` to a full HTTPS clone URL', () => {
    expect(parseGitUrl('foo/bar')).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
    });
  });

  it('does not match strings with more than one slash', () => {
    expect(() => parseGitUrl(TOO_MANY_SLASHES)).toThrow(INVALID_URL_PATTERN);
  });
});

describe('parseGitUrl — SSH forms', () => {
  it('parses git@host:owner/repo.git', () => {
    expect(parseGitUrl(SSH_CLONE_URL)).toEqual({
      cloneUrl: SSH_CLONE_URL,
    });
  });

  it('parses git@host:owner/repo.git#ref', () => {
    expect(parseGitUrl(`${SSH_CLONE_URL}#v1.2.3`)).toEqual({
      cloneUrl: SSH_CLONE_URL,
      ref: 'v1.2.3',
    });
  });

  it('parses git@host:owner/repo.git#ref:subpath', () => {
    expect(parseGitUrl(`${SSH_CLONE_URL}#main:${SUBPATH_BAZ}`)).toEqual({
      cloneUrl: SSH_CLONE_URL,
      ref: 'main',
      subpath: SUBPATH_BAZ,
    });
  });

  it('parses ssh://git@host/owner/repo.git', () => {
    expect(parseGitUrl(SSH_URL_FORM)).toEqual({
      cloneUrl: SSH_URL_FORM,
    });
  });
});

describe('parseGitUrl — malformed inputs throw with helpful message', () => {
  const malformed = [
    'hptts://github.com/foo/bar.git', // typo in scheme
    'github.com/foo/bar', // missing scheme, has dots so not shorthand
    '   ', // whitespace only
    'just-a-word', // no slash, no scheme
    TOO_MANY_SLASHES, // shorthand with too many slashes
  ];

  for (const input of malformed) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseGitUrl(input)).toThrow(INVALID_URL_PATTERN);
    });
  }

  it('reports empty input clearly', () => {
    expect(() => parseGitUrl('')).toThrow(/empty/);
  });
});

describe('isGitUrl', () => {
  const urls = [
    HTTPS_CLONE_URL,
    'http://example.com/foo/bar.git',
    SSH_URL_FORM,
    SSH_CLONE_URL,
    'foo/bar', // shorthand
    `https://github.com/foo/bar/tree/main/${SUBPATH_BAZ}`,
  ];
  for (const u of urls) {
    it(`recognizes ${JSON.stringify(u)} as a URL`, () => {
      expect(isGitUrl(u)).toBe(true);
    });
  }

  const paths = [
    '.',
    './foo/bar',
    '/absolute/path/to/dir',
    'foo', // single token, no slash
    TOO_MANY_SLASHES, // multi-segment relative path
    'foo/bar.md', // looks like a file path with extension
    String.raw`C:\Users\foo`, // Windows path
  ];
  for (const p of paths) {
    it(`treats ${JSON.stringify(p)} as a path (not a URL)`, () => {
      expect(isGitUrl(p)).toBe(false);
    });
  }
});
