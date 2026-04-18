/**
 * Pattern registry — the authoritative list of things VAT's detectors look for.
 *
 * Every pattern a detector fires references an entry here by stable ID.
 * Naming convention: describe what the pattern matches (the observable
 * phenomenon), not what observation it might support.
 */

import type { PatternDefinition } from './types.js';

export const PATTERN_REGISTRY: Record<string, PatternDefinition> = {
  // Shell-presence patterns
  FENCED_SHELL_BLOCK: {
    patternId: 'FENCED_SHELL_BLOCK',
    source: 'code',
    description: 'Fenced code block with language bash/sh/shell/zsh.',
    confidence: 'high',
  },
  ALLOWED_TOOLS_LOCAL_SHELL: {
    patternId: 'ALLOWED_TOOLS_LOCAL_SHELL',
    source: 'code',
    description: 'Frontmatter allowed-tools list includes Bash/Edit/Write/NotebookEdit.',
    confidence: 'high',
  },
  PROSE_LOCAL_SHELL_TOOL_REFERENCE: {
    patternId: 'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
    source: 'code',
    description: 'Prose mentions "Bash/Edit/Write/NotebookEdit tool" by name.',
    confidence: 'medium',
  },

  // External-CLI patterns
  EXTERNAL_CLI_AZ: {
    patternId: 'EXTERNAL_CLI_AZ',
    source: 'code',
    description: 'az CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_AWS: {
    patternId: 'EXTERNAL_CLI_AWS',
    source: 'code',
    description: 'aws CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_GCLOUD: {
    patternId: 'EXTERNAL_CLI_GCLOUD',
    source: 'code',
    description: 'gcloud CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_KUBECTL: {
    patternId: 'EXTERNAL_CLI_KUBECTL',
    source: 'code',
    description: 'kubectl CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_DOCKER: {
    patternId: 'EXTERNAL_CLI_DOCKER',
    source: 'code',
    description: 'docker CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_TERRAFORM: {
    patternId: 'EXTERNAL_CLI_TERRAFORM',
    source: 'code',
    description: 'terraform CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_GH: {
    patternId: 'EXTERNAL_CLI_GH',
    source: 'code',
    description: 'gh CLI invocation in a shell block.',
    confidence: 'high',
  },
  EXTERNAL_CLI_OP: {
    patternId: 'EXTERNAL_CLI_OP',
    source: 'code',
    description: '1Password CLI (op) invocation in a shell block.',
    confidence: 'high',
  },

  // Browser-auth patterns
  BROWSER_AUTH_AZ_LOGIN: {
    patternId: 'BROWSER_AUTH_AZ_LOGIN',
    source: 'code',
    description: '"az login" invocation in a shell context.',
    confidence: 'high',
  },
  BROWSER_AUTH_GCLOUD_LOGIN: {
    patternId: 'BROWSER_AUTH_GCLOUD_LOGIN',
    source: 'code',
    description: '"gcloud auth login" invocation in a shell context.',
    confidence: 'high',
  },
  BROWSER_AUTH_AWS_SSO_LOGIN: {
    patternId: 'BROWSER_AUTH_AWS_SSO_LOGIN',
    source: 'code',
    description: '"aws sso login" invocation in a shell context.',
    confidence: 'high',
  },
  BROWSER_AUTH_MSAL_PYTHON_IMPORT: {
    patternId: 'BROWSER_AUTH_MSAL_PYTHON_IMPORT',
    source: 'code',
    description: 'Python "from msal" import.',
    confidence: 'medium',
  },
  BROWSER_AUTH_MSAL_JS_IMPORT: {
    patternId: 'BROWSER_AUTH_MSAL_JS_IMPORT',
    source: 'code',
    description: '@azure/msal-* JS import.',
    confidence: 'medium',
  },
  BROWSER_AUTH_WEBBROWSER_OPEN: {
    patternId: 'BROWSER_AUTH_WEBBROWSER_OPEN',
    source: 'code',
    description: 'Python webbrowser.open(...) call.',
    confidence: 'medium',
  },
};

export function getPatternDefinition(patternId: string): PatternDefinition | undefined {
  return PATTERN_REGISTRY[patternId];
}

export function assertPatternRegistered(patternId: string): void {
  if (!(patternId in PATTERN_REGISTRY)) {
    throw new Error(`Unregistered pattern ID: ${patternId}. Add it to PATTERN_REGISTRY.`);
  }
}
