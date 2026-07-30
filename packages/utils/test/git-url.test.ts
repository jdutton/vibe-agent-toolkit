import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isGitUrl,
  nonInteractiveGitOverrides,
  parseGitUrl,
  type ParsedGitUrl,
} from '../src/git-url.js';

const HTTPS_CLONE_URL = 'https://github.com/foo/bar.git';
const SSH_URL_FORM = 'ssh://git@github.com/foo/bar.git';
const SSH_CLONE_URL = 'git@github.com:foo/bar.git';
const FILE_URL_FORM = pathToFileURL('/some/bare-repo.git').href;
const SUBPATH_BAZ = 'plugins/baz';
const TOO_MANY_SLASHES = 'foo/bar/baz';
const INVALID_URL_PATTERN = /Invalid git URL/;

describe('parseGitUrl — HTTPS forms', () => {
  const cases: Array<{ name: string; input: string; expected: ParsedGitUrl }> = [
    {
      name: 'plain HTTPS .git URL',
      input: HTTPS_CLONE_URL,
      expected: { cloneUrl: HTTPS_CLONE_URL, inferredFromShorthand: false },
    },
    {
      name: 'HTTPS .git URL with ref',
      input: `${HTTPS_CLONE_URL}#v1.2.3`,
      expected: { cloneUrl: HTTPS_CLONE_URL, ref: 'v1.2.3', inferredFromShorthand: false },
    },
    {
      name: 'HTTPS .git URL with ref + subpath',
      input: `${HTTPS_CLONE_URL}#main:${SUBPATH_BAZ}`,
      expected: {
        cloneUrl: HTTPS_CLONE_URL,
        ref: 'main',
        subpath: SUBPATH_BAZ,
        inferredFromShorthand: false,
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
      inferredFromShorthand: false,
    });
  });

  it('parses /tree/<ref> with no subpath', () => {
    expect(parseGitUrl('https://github.com/foo/bar/tree/v1.2.3')).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      ref: 'v1.2.3',
      inferredFromShorthand: false,
    });
  });
});

describe('parseGitUrl — GitHub shorthand', () => {
  it('expands `owner/repo` to a full HTTPS clone URL', () => {
    expect(parseGitUrl('foo/bar')).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      inferredFromShorthand: true,
    });
  });

  it('expands `owner/repo#ref` to clone URL + ref', () => {
    expect(parseGitUrl('foo/bar#claude-marketplace')).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      ref: 'claude-marketplace',
      inferredFromShorthand: true,
    });
  });

  it('expands `owner/repo#ref:subpath` to clone URL + ref + subpath', () => {
    expect(parseGitUrl(`foo/bar#main:${SUBPATH_BAZ}`)).toEqual({
      cloneUrl: HTTPS_CLONE_URL,
      ref: 'main',
      subpath: SUBPATH_BAZ,
      inferredFromShorthand: true,
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
      inferredFromShorthand: false,
    });
  });

  it('parses git@host:owner/repo.git#ref', () => {
    expect(parseGitUrl(`${SSH_CLONE_URL}#v1.2.3`)).toEqual({
      cloneUrl: SSH_CLONE_URL,
      ref: 'v1.2.3',
      inferredFromShorthand: false,
    });
  });

  it('parses git@host:owner/repo.git#ref:subpath', () => {
    expect(parseGitUrl(`${SSH_CLONE_URL}#main:${SUBPATH_BAZ}`)).toEqual({
      cloneUrl: SSH_CLONE_URL,
      ref: 'main',
      subpath: SUBPATH_BAZ,
      inferredFromShorthand: false,
    });
  });

  it('parses ssh://git@host/owner/repo.git', () => {
    expect(parseGitUrl(SSH_URL_FORM)).toEqual({
      cloneUrl: SSH_URL_FORM,
      inferredFromShorthand: false,
    });
  });
});

describe('parseGitUrl — shorthand provenance marker', () => {
  // The marker exists because an expanded shorthand URL is byte-identical to a
  // typed one: the consumer cannot recover "was this inferred?" by inspecting
  // `cloneUrl`, so the fact has to travel with the value.
  const inferred = ['foo/bar', 'foo/bar#main', `foo/bar#main:${SUBPATH_BAZ}`];
  for (const input of inferred) {
    it(`marks ${JSON.stringify(input)} as inferred from shorthand`, () => {
      expect(parseGitUrl(input).inferredFromShorthand).toBe(true);
    });
  }

  const explicit = [
    HTTPS_CLONE_URL,
    `${HTTPS_CLONE_URL}#main:${SUBPATH_BAZ}`,
    'https://github.com/foo/bar/tree/main',
    SSH_CLONE_URL,
    `${SSH_CLONE_URL}#main:${SUBPATH_BAZ}`,
    SSH_URL_FORM,
    FILE_URL_FORM,
    `${FILE_URL_FORM}#main:${SUBPATH_BAZ}`,
  ];
  for (const input of explicit) {
    it(`does not mark explicitly supplied ${JSON.stringify(input)}`, () => {
      expect(parseGitUrl(input).inferredFromShorthand).toBe(false);
    });
  }
});

describe('nonInteractiveGitOverrides', () => {
  const forShorthand = (): ReturnType<typeof nonInteractiveGitOverrides> =>
    nonInteractiveGitOverrides(parseGitUrl('foo/bar'));

  it('adds nothing when the user supplied the URL explicitly', () => {
    const overrides = nonInteractiveGitOverrides(parseGitUrl(HTTPS_CLONE_URL));
    expect(overrides.env).toEqual({});
    expect(overrides.configArgs).toEqual([]);
  });

  it('adds nothing for an explicit SSH URL either', () => {
    const overrides = nonInteractiveGitOverrides(parseGitUrl(SSH_CLONE_URL));
    expect(overrides.env).toEqual({});
    expect(overrides.configArgs).toEqual([]);
  });

  it("disables git's terminal prompt for an inferred shorthand URL", () => {
    expect(forShorthand().env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('short-circuits the entire askpass chain for an inferred shorthand URL', () => {
    // git consults GIT_ASKPASS → core.askPass → SSH_ASKPASS *before* it ever
    // honours GIT_TERMINAL_PROMPT, so the prompt flag alone leaves the stall open.
    const overrides = forShorthand();
    expect(overrides.env.GIT_ASKPASS).toBe('');
    expect(overrides.env.SSH_ASKPASS).toBe('');
    expect(overrides.configArgs).toEqual(['-c', 'core.askPass=']);
  });

  it('forbids credential-helper escalation without disabling the helpers', () => {
    const overrides = forShorthand();
    expect(overrides.env.GCM_INTERACTIVE).toBe('never');
    // A stored, non-interactive credential must still be usable, so we must not
    // reset the helper list or suppress system/global config.
    expect(overrides.env).not.toHaveProperty('GIT_CONFIG_NOSYSTEM');
    expect(overrides.configArgs).not.toContain('credential.helper=');
  });

  it('never sets GIT_CONFIG_* (it would clobber a caller-supplied overlay)', () => {
    const overrides = forShorthand();
    expect(Object.keys(overrides.env).filter((k) => k.startsWith('GIT_CONFIG'))).toEqual([]);
  });

  it('applies to shorthand with a ref and subpath too', () => {
    const overrides = nonInteractiveGitOverrides(parseGitUrl(`foo/bar#main:${SUBPATH_BAZ}`));
    expect(overrides.env.GIT_TERMINAL_PROMPT).toBe('0');
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
    'foo/bar#main', // shorthand with ref fragment
    'foo/bar#main:packages/x', // shorthand with ref + subpath fragment
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
    'foo@host:', // empty path after colon — not a real SSH URL
  ];
  for (const p of paths) {
    it(`treats ${JSON.stringify(p)} as a path (not a URL)`, () => {
      expect(isGitUrl(p)).toBe(false);
    });
  }
});
