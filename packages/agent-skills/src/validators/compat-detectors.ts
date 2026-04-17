/**
 * Compat smell detectors.
 *
 * Pure module: (content, filePath) -> ValidationIssue[]. Each detector
 * decides whether to fire; description/fix/reference come from
 * CODE_REGISTRY, mirroring walker-to-issues.ts. Detectors wire into
 * skill-validator in Phase 3 and flow through validation.severity /
 * validation.allow like every other framework code.
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

const COMPAT_CODES = [
  'COMPAT_REQUIRES_BROWSER_AUTH',
  'COMPAT_REQUIRES_LOCAL_SHELL',
  'COMPAT_REQUIRES_EXTERNAL_CLI',
] as const;

type CompatCode = (typeof COMPAT_CODES)[number];

function makeIssue(code: CompatCode, filePath: string, evidence: string): ValidationIssue {
  const entry = CODE_REGISTRY[code];
  return {
    severity: entry.defaultSeverity,
    code,
    message: `${entry.description} (detected: ${evidence})`,
    location: filePath,
    fix: entry.fix,
    reference: entry.reference,
  };
}

/**
 * Iterate over fenced code blocks. Yields {language, body, line} for each
 * fence. Used by shell + external-CLI detectors in later tasks.
 */
function* iterCodeBlocks(content: string): Generator<{ language: string; body: string; line: number }> {
  const CODE_BLOCK_RE = /^```(\w*)\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const language = match[1] ?? '';
    const body = match[2] ?? '';
    const line = content.slice(0, match.index).split('\n').length;
    yield { language, body, line };
  }
}

const LOCAL_SHELL_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const;

// Minimal frontmatter peek for the allowed-tools list. Skill-validator
// does full YAML parsing elsewhere; here we only need the one field,
// so a narrow regex is cheaper than re-parsing.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const ALLOWED_TOOLS_RE = /^allowed-tools:\s*\[([^\]]*)\]/m;

function allowedToolsList(content: string): string[] {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm) return [];
  const fmBody = fm[1] ?? '';
  const at = ALLOWED_TOOLS_RE.exec(fmBody);
  if (!at) return [];
  const raw = at[1] ?? '';
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

const PROSE_TOOL_RE = /\b(Bash|Edit|Write|NotebookEdit)\s+tool\b/;
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);

// Unbundled CLI binaries. Narrow initial list — start with what real adopters
// already use (avonrisk-sdlc uses az), grow only when community scanning
// (workstream B) surfaces new patterns.
const EXTERNAL_BINARIES = ['az', 'aws', 'gcloud', 'kubectl', 'docker', 'terraform', 'gh', 'op'] as const;

function binaryLineRE(binary: string): RegExp {
  // Start of line or after a shell separator (space/tab/;|&), followed by whitespace/EOL.
  // This prevents matching `az-foo` or `gh-cli`.
  // eslint-disable-next-line security/detect-non-literal-regexp -- whitelist of literals
  return new RegExp(String.raw`(^|[\s;|&])${binary}(\s|$)`, 'm');
}

// Browser-auth patterns: interactive OAuth/device-code flows that assume a
// local browser. Non-browser auth (bearer tokens, service-principal secrets)
// is portable and intentionally NOT flagged.
const BROWSER_AUTH_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bfrom\s+msal\b/, label: "Python 'msal' import" },
  { re: /@azure\/msal-(node|browser|common)/, label: 'JS @azure/msal-* import' },
  { re: /(^|[\s;|&])az\s+login\b/m, label: "'az login' in shell" },
  { re: /(^|[\s;|&])gcloud\s+auth\s+login\b/m, label: "'gcloud auth login' in shell" },
  { re: /(^|[\s;|&])aws\s+sso\s+login\b/m, label: "'aws sso login' in shell" },
  { re: /\bwebbrowser\.open\s*\(/, label: 'webbrowser.open() call' },
];

// Per-code detectors implemented in Tasks 4-6:
export function detectBrowserAuth(content: string, filePath: string): ValidationIssue[] {
  for (const { re, label } of BROWSER_AUTH_PATTERNS) {
    if (re.test(content)) {
      return [makeIssue('COMPAT_REQUIRES_BROWSER_AUTH', filePath, label)];
    }
  }
  return [];
}
export function detectLocalShell(content: string, filePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (evidence: string): void => {
    issues.push(makeIssue('COMPAT_REQUIRES_LOCAL_SHELL', filePath, evidence));
  };

  const tools = allowedToolsList(content);
  const matchedTool = tools.find(t => (LOCAL_SHELL_TOOLS as readonly string[]).includes(t));
  if (matchedTool) {
    push(`allowed-tools includes ${matchedTool}`);
  }

  if (PROSE_TOOL_RE.test(content)) {
    push('prose references a local-shell tool by name');
  }

  for (const block of iterCodeBlocks(content)) {
    if (SHELL_LANGUAGES.has(block.language.toLowerCase())) {
      push(`fenced ${block.language} code block`);
      break;
    }
  }

  // Dedupe inside the detector: runCompatDetectors also dedupes across
  // detectors, but keeping this local keeps per-detector output tight
  // for standalone callers and tests.
  const seen = new Set<string>();
  return issues.filter(i => {
    const key = `${i.code}|${i.location ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function detectExternalCLI(content: string, filePath: string): ValidationIssue[] {
  for (const block of iterCodeBlocks(content)) {
    const lang = block.language.toLowerCase();
    if (!SHELL_LANGUAGES.has(lang) && lang !== '') continue;
    for (const bin of EXTERNAL_BINARIES) {
      if (binaryLineRE(bin).test(block.body)) {
        return [
          makeIssue(
            'COMPAT_REQUIRES_EXTERNAL_CLI',
            filePath,
            `external CLI invocation '${bin}' in fenced code block`,
          ),
        ];
      }
    }
  }
  return [];
}

/**
 * Run every compat detector and return the concatenated issue list.
 * Deduplicates by (code, location) so overlapping patterns don't double-fire.
 */
export function runCompatDetectors(content: string, filePath: string): ValidationIssue[] {
  const raw = [
    ...detectBrowserAuth(content, filePath),
    ...detectLocalShell(content, filePath),
    ...detectExternalCLI(content, filePath),
  ];
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const issue of raw) {
    const key = `${issue.code}|${issue.location ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

export { COMPAT_CODES, iterCodeBlocks, makeIssue, type CompatCode };
