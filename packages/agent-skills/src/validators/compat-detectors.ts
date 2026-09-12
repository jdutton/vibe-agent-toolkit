/**
 * Compat capability detectors.
 *
 * Pure module: (content, filePath) -> { evidence, observations }. Detectors
 * collect raw EvidenceRecord[] from the source, then deriveObservations()
 * rolls evidence up into capability-level Observation[]. The verdict layer
 * (downstream) decides whether each observation produces a compat issue.
 *
 * Pattern IDs MUST be registered in PATTERN_REGISTRY (assertPatternRegistered
 * is called against every emitted record).
 */

import { CODE_REGISTRY, type IssueCode, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { EvidenceRecord, Observation } from '../evidence/index.js';
import {
  buildEvidence,
  deriveObservationsFromEvidence,
  EXTERNAL_CLI_BINARIES,
} from '../evidence/index.js';
import { parseFrontmatter } from '../parsers/frontmatter-parser.js';
import { allowedToolsOf } from '../schemas/allowed-tools.js';

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);
const LOCAL_SHELL_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const;

const BROWSER_AUTH_PATTERNS: ReadonlyArray<{ patternId: string; re: RegExp; description: string }> = [
  { patternId: 'BROWSER_AUTH_MSAL_PYTHON_IMPORT', re: /\bfrom\s+msal\b/, description: 'from msal import' },
  { patternId: 'BROWSER_AUTH_MSAL_JS_IMPORT', re: /@azure\/msal-(node|browser|common)/, description: '@azure/msal-* import' },
  { patternId: 'BROWSER_AUTH_AZ_LOGIN', re: /(^|[\s;|&])az\s+login\b/m, description: "'az login' in shell" },
  { patternId: 'BROWSER_AUTH_GCLOUD_LOGIN', re: /(^|[\s;|&])gcloud\s+auth\s+login\b/m, description: "'gcloud auth login' in shell" },
  { patternId: 'BROWSER_AUTH_AWS_SSO_LOGIN', re: /(^|[\s;|&])aws\s+sso\s+login\b/m, description: "'aws sso login' in shell" },
  { patternId: 'BROWSER_AUTH_WEBBROWSER_OPEN', re: /\bwebbrowser\.open\s*\(/, description: 'webbrowser.open() call' },
];

// The frontmatter span, on `\n`-normalized content, used ONLY to locate the
// line the `allowed-tools:` key sits on. The value is read through
// `parseFrontmatter`, never from this regex.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const ALLOWED_TOOLS_KEY_RE = /^allowed-tools:/m;
const PROSE_TOOL_RE = /\b(Bash|Edit|Write|NotebookEdit)\s+tool\b/;

export interface DetectorOutput {
  evidence: EvidenceRecord[];
  observations: Observation[];
}

/**
 * Locate the line number (1-based) within `content` where `index` falls.
 */
function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Iterate over fenced code blocks. Yields {language, body, line, index} for
 * each fence. `line` points at the opening fence; `index` is the offset of
 * the body start within `content`.
 */
function* iterCodeBlocks(
  content: string,
): Generator<{ language: string; body: string; line: number; bodyIndex: number }> {
  const CODE_BLOCK_RE = /^```(\w*)\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const language = match[1] ?? '';
    const body = match[2] ?? '';
    const line = lineForIndex(content, match.index);
    // body starts after the opening fence + language + '\n'
    const bodyIndex = match.index + match[0].indexOf('\n', 0) + 1;
    yield { language, body, line, bodyIndex };
  }
}

/**
 * The `allowed-tools:` declarations a SKILL.md carries and the 1-based line of
 * the key; `{ tools: [], line: 0 }` when the key is absent or the frontmatter
 * does not parse (the skill validator names that file
 * `SKILL_MISSING_FRONTMATTER` on the same run — nothing is read out of it here).
 *
 * 🚩 This used to be a hand parser that saw ONLY the `[…]` flow form and split
 * it on commas. Claude Code's documented spelling is space-separated, and a
 * block sequence is valid YAML, so `allowed-tools: Read Bash` and a `- Bash`
 * list both read as NO declaration and the local-shell capability reported
 * clean over them. The value now goes through the same `parseFrontmatter` the
 * validator uses and the same `allowedToolsOf` the settings-compat checker uses.
 */
export function allowedToolsDeclarations(content: string): { tools: string[]; line: number } {
  const parsed = parseFrontmatter(content);
  if (!parsed.success) return { tools: [], line: 0 };
  // `yaml.parse` of an empty document is `null`; a scalar document is not a mapping.
  const fields: unknown = parsed.frontmatter;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return { tools: [], line: 0 };
  const tools = allowedToolsOf((fields as Record<string, unknown>)['allowed-tools']) ?? [];
  if (tools.length === 0) return { tools: [], line: 0 };

  // Locate the line of the key. parseFrontmatter normalized CRLF; do the same.
  const normalized = content.replaceAll('\r\n', '\n');
  const fmBody = FRONTMATTER_RE.exec(normalized)?.[1] ?? '';
  const at = ALLOWED_TOOLS_KEY_RE.exec(fmBody);
  // The opening `---` is line 1, so the key's line is 1 + its line within the body.
  const line = at ? 1 + lineForIndex(fmBody, at.index) : 0;
  return { tools, line };
}

/**
 * The tool a declaration names: `Bash(git:*)` and `Bash` both declare Bash.
 * The parenthesised part scopes the grant; it does not change which tool the
 * skill needs.
 */
function toolNameOf(declaration: string): string {
  const paren = declaration.indexOf('(');
  return paren === -1 ? declaration : declaration.slice(0, paren);
}

export function collectLocalShellEvidence(
  content: string,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];

  // Frontmatter allowed-tools
  const { tools, line: atLine } = allowedToolsDeclarations(content);
  const matchedTool = tools.find(t => (LOCAL_SHELL_TOOLS as readonly string[]).includes(toolNameOf(t)));
  if (matchedTool !== undefined) {
    out.push(
      buildEvidence(
        'ALLOWED_TOOLS_LOCAL_SHELL',
        filePath,
        locationRoot,
        `allowed-tools includes ${matchedTool}`,
        atLine || undefined,
      ),
    );
  }

  // Prose reference to a local-shell tool by name
  const proseMatch = PROSE_TOOL_RE.exec(content);
  if (proseMatch) {
    out.push(
      buildEvidence(
        'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
        filePath,
        locationRoot,
        proseMatch[0],
        lineForIndex(content, proseMatch.index),
      ),
    );
  }

  // Fenced shell code block (record the first one — one is enough to assert
  // the capability; downstream verdict only needs the existence claim).
  for (const block of iterCodeBlocks(content)) {
    if (SHELL_LANGUAGES.has(block.language.toLowerCase())) {
      out.push(
        buildEvidence(
          'FENCED_SHELL_BLOCK',
          filePath,
          locationRoot,
          `\`\`\`${block.language} block`,
          block.line,
        ),
      );
      break;
    }
  }

  return out;
}

function binaryLineRE(binary: string): RegExp {
  // Start of line or after a shell separator (space/tab/;|&), followed by whitespace/EOL.
  // This prevents matching `az-foo` or `gh-cli`.
  // eslint-disable-next-line security/detect-non-literal-regexp -- whitelist of literals
  return new RegExp(String.raw`(^|[\s;|&])${binary}(\s|$)`, 'm');
}

export function collectExternalCLIEvidence(
  content: string,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const block of iterCodeBlocks(content)) {
    const lang = block.language.toLowerCase();
    if (!SHELL_LANGUAGES.has(lang) && lang !== '') continue;
    for (const { binary, patternId } of EXTERNAL_CLI_BINARIES) {
      const m = binaryLineRE(binary).exec(block.body);
      if (!m) continue;
      const key = `${patternId}|${block.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Compute line within the original content: opening-fence line + offset
      // within block body. block.line already points at the opening fence,
      // so body's first line is block.line + 1.
      const offsetWithinBody = block.body.slice(0, m.index).split('\n').length - 1;
      const matchedLine = block.line + 1 + offsetWithinBody;
      out.push(
        buildEvidence(
          patternId,
          filePath,
          locationRoot,
          `${binary} invocation in shell block`,
          matchedLine,
        ),
      );
    }
  }
  return out;
}

export function collectBrowserAuthEvidence(
  content: string,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const { patternId, re, description } of BROWSER_AUTH_PATTERNS) {
    const m = re.exec(content);
    if (!m) continue;
    out.push(
      buildEvidence(
        patternId,
        filePath,
        locationRoot,
        description,
        lineForIndex(content, m.index),
      ),
    );
  }
  return out;
}

const SKILL_LOCAL_SHELL_PATTERN_IDS: ReadonlySet<string> = new Set([
  'ALLOWED_TOOLS_LOCAL_SHELL',
  'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
  'FENCED_SHELL_BLOCK',
]);

export function deriveObservations(evidence: readonly EvidenceRecord[]): Observation[] {
  return deriveObservationsFromEvidence(evidence, {
    localShellPatternIds: SKILL_LOCAL_SHELL_PATTERN_IDS,
    subject: 'skill',
  });
}

/**
 * Convert a capability Observation into a ValidationIssue using the
 * default severity, fix, and reference from CODE_REGISTRY.
 */
export function observationToIssue(obs: Observation, location: string): ValidationIssue {
  const code = obs.code as IssueCode;
  const entry = CODE_REGISTRY[code];
  return {
    severity: entry.defaultSeverity,
    code,
    message: obs.summary,
    location,
    fix: entry.fix,
    reference: entry.reference,
  };
}

/**
 * @param locationRoot - The ONE base every emitted evidence `location.file` is
 *   expressed relative to. Required, so a producer cannot emit an absolute
 *   location by omission.
 */
export function runCompatDetectors(
  content: string,
  filePath: string,
  locationRoot: string,
): DetectorOutput {
  const evidence: EvidenceRecord[] = [
    ...collectLocalShellEvidence(content, filePath, locationRoot),
    ...collectExternalCLIEvidence(content, filePath, locationRoot),
    ...collectBrowserAuthEvidence(content, filePath, locationRoot),
  ];
  const observations = deriveObservations(evidence);
  return { evidence, observations };
}
