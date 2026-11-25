import { describe, expect, it } from 'vitest';

import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

import { lf, recordsOf } from './core-helpers.js';

const SKILL = lf(
  '---',
  'name: x',
  '"allowed-tools": Bash Read',
  '---',
  'Use the Bash tool to run.',
  '```bash',
  'az login',
  'gh pr list',
  '```',
  '```',
  'docker run x',
  '```',
  'from msal import X',
);

function compatRecords(text: string): Array<[string, string, number, string]> {
  return skillTextFactsOf(text, SKILL_TEXT_DECLARATION)
    .matches.filter((match) => match.family.startsWith('compat'))
    .map((match) => [match.family, match.patternId, match.line, match.matchText]);
}

describe('compat families', () => {
  it('records in evidence order: key, prose, fenced shell, external CLIs, browser auth', () => {
    expect(compatRecords(SKILL)).toEqual([
      ['compatAllowedToolsKey', 'allowed-tools-key', 3, '"allowed-tools":'],
      ['compatProseTool', 'PROSE_LOCAL_SHELL_TOOL_REFERENCE', 5, 'Bash tool'],
      ['compatFencedShell', 'FENCED_SHELL_BLOCK', 6, 'bash'],
      ['compatExternalCli', 'EXTERNAL_CLI_AZ', 7, 'az '],
      // The separator class takes the newline before `gh`, so its line is the one above,
      // exactly as the detector computes it today.
      ['compatExternalCli', 'EXTERNAL_CLI_GH', 7, '\ngh '],
      ['compatExternalCli', 'EXTERNAL_CLI_DOCKER', 11, 'docker '],
      ['compatBrowserAuth', 'BROWSER_AUTH_MSAL_PYTHON_IMPORT', 13, 'from msal'],
      ['compatBrowserAuth', 'BROWSER_AUTH_AZ_LOGIN', 6, '\naz login'],
    ]);
  });

  it('records only the first fenced shell block and skips non-shell languages', () => {
    const text = lf('```ts', 'gh x', '```', '```SH', 'kubectl get', '```', '```zsh', 'op read', '```');
    expect(recordsOf(text, 'compatFencedShell')).toEqual([['FENCED_SHELL_BLOCK', 4, 'SH']]);
    expect(recordsOf(text, 'compatExternalCli')).toEqual([
      ['EXTERNAL_CLI_KUBECTL', 5, 'kubectl '],
      ['EXTERNAL_CLI_OP', 8, 'op '],
    ]);
  });

  it('counts the body lines before a later-line match', () => {
    const text = lf('intro', '```sh', 'echo hi', 'cd x', '  docker run', '```');
    expect(recordsOf(text, 'compatExternalCli')).toEqual([['EXTERNAL_CLI_DOCKER', 5, ' docker ']]);
  });

  it('locates the allowed-tools key in CRLF frontmatter, and sees no fenced block under CRLF', () => {
    const text = '---\r\nname: x\r\nallowed-tools : Bash\r\n---\r\n```bash\r\naz x\r\n```\r\n';
    expect(recordsOf(text, 'compatAllowedToolsKey')).toEqual([['allowed-tools-key', 3, 'allowed-tools :']]);
    expect(recordsOf(text, 'compatFencedShell')).toEqual([]);
    expect(recordsOf(text, 'compatExternalCli')).toEqual([]);
  });

  it('has no key record without frontmatter or key', () => {
    expect(recordsOf('allowed-tools: Bash', 'compatAllowedToolsKey')).toEqual([]);
    expect(recordsOf(lf('---', 'name: x', '---'), 'compatAllowedToolsKey')).toEqual([]);
  });

  it('records each browser-auth pattern once, at its first match', () => {
    const text = lf(
      'import "@azure/msal-node"',
      'gcloud auth login',
      'x; aws sso login',
      'webbrowser.open (u)',
      'webbrowser.open(v)',
    );
    expect(recordsOf(text, 'compatBrowserAuth')).toEqual([
      ['BROWSER_AUTH_MSAL_JS_IMPORT', 1, '@azure/msal-node'],
      ['BROWSER_AUTH_GCLOUD_LOGIN', 1, '\ngcloud auth login'],
      ['BROWSER_AUTH_AWS_SSO_LOGIN', 3, ' aws sso login'],
      ['BROWSER_AUTH_WEBBROWSER_OPEN', 4, 'webbrowser.open ('],
    ]);
  });
});
