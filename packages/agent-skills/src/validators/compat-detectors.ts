/**
 * Compat capability detectors.
 *
 * (skill-text record, filePath, frontmatter) -> { evidence, observations }. It
 * parses and scans nothing: the text half of every detector (the `allowed-tools:`
 * key's line, the first prose tool reference, the first fenced shell block,
 * external CLIs per shell block, browser-auth flows) is the skill-text core's
 * `compat*` families in `@vibe-agent-toolkit/resources`, and `allowed-tools` is
 * read from the frontmatter the caller's own parse returned
 * ({@link detectorFrontmatter} for a caller that has none). The detectors turn
 * those records into raw EvidenceRecord[], then deriveObservations() rolls
 * evidence up into capability-level Observation[]. The verdict layer
 * (downstream) decides whether each observation produces a compat issue.
 *
 * Known quirk, kept: a fenced block's opening line must end in `\n`, so a CRLF
 * document has no fenced-block evidence (no FENCED_SHELL_BLOCK, no external CLI).
 *
 * Pattern IDs MUST be registered in PATTERN_REGISTRY (assertPatternRegistered
 * is called against every emitted record).
 */

import {
  EXTERNAL_CLI_BINARIES,
  isPerRunParseRefusal,
  type MeasuredContent,
  type ParseRoute,
  type SkillTextFacts,
  type SkillTextFamilyPatternId,
} from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type IssueCode, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { EvidenceRecord, Observation } from '../evidence/index.js';
import { buildEvidence, deriveObservationsFromEvidence } from '../evidence/index.js';
import { parseFrontmatter } from '../parsers/frontmatter-parser.js';
import { allowedToolsOf } from '../schemas/allowed-tools.js';

import { recordsOf } from './skill-text-records.js';

const LOCAL_SHELL_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const;

/** A browser-auth pattern's ID. */
type BrowserAuthId = SkillTextFamilyPatternId<'compatBrowserAuth'>;

/** An external CLI's pattern ID. */
type ExternalCliId = SkillTextFamilyPatternId<'compatExternalCli'>;

/** What each browser-auth flow's evidence says it found: judgement, never the matched text. */
const BROWSER_AUTH_DESCRIPTIONS = {
  BROWSER_AUTH_MSAL_PYTHON_IMPORT: 'from msal import',
  BROWSER_AUTH_MSAL_JS_IMPORT: '@azure/msal-* import',
  BROWSER_AUTH_AZ_LOGIN: "'az login' in shell",
  BROWSER_AUTH_GCLOUD_LOGIN: "'gcloud auth login' in shell",
  BROWSER_AUTH_AWS_SSO_LOGIN: "'aws sso login' in shell",
  BROWSER_AUTH_WEBBROWSER_OPEN: 'webbrowser.open() call',
} as const satisfies Record<BrowserAuthId, string>;

/**
 * An external CLI's binary, by the pattern ID its evidence carries: total by
 * construction, since {@link ExternalCliId} is the IDs of this same list.
 */
const EXTERNAL_CLI_BINARY = Object.fromEntries(
  EXTERNAL_CLI_BINARIES.map(({ binary, patternId }) => [patternId, binary]),
) as Readonly<Record<ExternalCliId, string>>;

export interface DetectorOutput {
  evidence: EvidenceRecord[];
  observations: Observation[];
}

/**
 * A file's frontmatter, parsed once for the detectors by a caller that has no
 * parse of its own: `undefined` when it does not parse (the skill validator
 * names that file `SKILL_MISSING_FRONTMATTER` on the same run). A block the
 * parse worker refused for this run throws that refusal — refused is not
 * "declares nothing", and the caller names the file unchecked.
 */
export async function detectorFrontmatter(input: MeasuredContent, route: ParseRoute): Promise<Record<string, unknown> | undefined> {
  const parsed = await parseFrontmatter(input, route);
  if (parsed.success) return parsed.frontmatter;
  if (isPerRunParseRefusal(parsed.cause)) throw parsed.cause;
  return undefined;
}

/**
 * The `allowed-tools:` declarations a SKILL.md carries and the 1-based line of
 * the key; `{ tools: [], line: 0 }` when the key is absent or there is no
 * parsed frontmatter.
 *
 * 🚩 This used to be a hand parser that saw ONLY the `[…]` flow form and split
 * it on commas. Claude Code's documented spelling is space-separated, and a
 * block sequence is valid YAML, so `allowed-tools: Read Bash` and a `- Bash`
 * list both read as NO declaration and the local-shell capability reported
 * clean over them. The value comes from the caller's YAML parse and goes
 * through the same `allowedToolsOf` the settings-compat checker uses; the key's
 * line is the core's `compatAllowedToolsKey` record (YAML lets the key be
 * quoted and pad before the colon, and the locator finds those too).
 */
export function allowedToolsDeclarations(
  facts: SkillTextFacts,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
): { tools: string[]; line: number } {
  const tools = allowedToolsOf(frontmatter?.['allowed-tools']) ?? [];
  if (tools.length === 0) return { tools: [], line: 0 };
  const [key] = recordsOf(facts, 'compatAllowedToolsKey');
  return { tools, line: key?.line ?? 0 };
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

function collectLocalShellEvidence(
  facts: SkillTextFacts,
  filePath: string,
  locationRoot: string,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];

  // Frontmatter allowed-tools
  const { tools, line: atLine } = allowedToolsDeclarations(facts, frontmatter);
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

  // Prose reference to a local-shell tool by name (the first one).
  for (const { line, matchText } of recordsOf(facts, 'compatProseTool')) {
    out.push(buildEvidence('PROSE_LOCAL_SHELL_TOOL_REFERENCE', filePath, locationRoot, matchText, line));
  }

  // Fenced shell code block (the first one — one is enough to assert the
  // capability; downstream verdict only needs the existence claim).
  for (const { line, matchText: language } of recordsOf(facts, 'compatFencedShell')) {
    out.push(buildEvidence('FENCED_SHELL_BLOCK', filePath, locationRoot, `\`\`\`${language} block`, line));
  }

  return out;
}

/** An external CLI invoked in a shell (or unlabelled) block: one per binary per block, at the invocation's line. */
function collectExternalCLIEvidence(
  facts: SkillTextFacts,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  return recordsOf(facts, 'compatExternalCli').map(({ patternId, line }) =>
    buildEvidence(patternId, filePath, locationRoot, `${EXTERNAL_CLI_BINARY[patternId]} invocation in shell block`, line));
}

/** A browser-auth flow anywhere in the file: one per pattern, at its first match. */
function collectBrowserAuthEvidence(
  facts: SkillTextFacts,
  filePath: string,
  locationRoot: string,
): EvidenceRecord[] {
  return recordsOf(facts, 'compatBrowserAuth').map(({ patternId, line }) =>
    buildEvidence(patternId, filePath, locationRoot, BROWSER_AUTH_DESCRIPTIONS[patternId], line));
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
    message: obs.description,
    location,
    fix: entry.fix,
    reference: entry.reference,
  };
}

/**
 * @param facts - The file's skill-text record (`skillTextFactsOf` over its raw
 *   text, frontmatter and all; or the store's copy of it)
 * @param filePath - The file, for each evidence record's location
 * @param locationRoot - The ONE base every emitted evidence `location.file` is
 *   expressed relative to. Required, so a producer cannot emit an absolute
 *   location by omission.
 * @param frontmatter - The frontmatter the caller's parse of the file returned
 *   (`undefined` when it did not parse) — never parsed again here
 */
export function runCompatDetectors(
  facts: SkillTextFacts,
  filePath: string,
  locationRoot: string,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
): DetectorOutput {
  const evidence: EvidenceRecord[] = [
    ...collectLocalShellEvidence(facts, filePath, locationRoot, frontmatter),
    ...collectExternalCLIEvidence(facts, filePath, locationRoot),
    ...collectBrowserAuthEvidence(facts, filePath, locationRoot),
  ];
  const observations = deriveObservations(evidence);
  return { evidence, observations };
}
