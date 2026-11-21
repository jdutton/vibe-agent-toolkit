/**
 * The skill-text declaration: every regex and constant the skill-text core
 * (`core.ts`) applies, and nothing else.
 *
 * The skills phase of `vat validate` checks a skill document's raw text with
 * detectors that live in `@vibe-agent-toolkit/agent-skills`. Each detector has
 * a TEXT half (which patterns match where) and a JUDGEMENT half (severity,
 * message, fix, location, config, the frontmatter it compares against). The
 * text half is the core, a pure function of the text and this object; the
 * judgement half stays live in agent-skills and is rebuilt from the core's
 * records every run.
 *
 * Everything the core's output depends on, other than its own control flow, is
 * here, so {@link skillTextDeclarationDigest} moves whenever a pattern, a
 * constant or an order does. `local/skill-text-core-purity` holds the core to
 * that: it refuses a regex, a non-trivial literal or a runtime import there
 * other than this module.
 *
 * Every pattern below is the agent-skills detector's pattern verbatim (same
 * source, same flags). The regexes are shared objects, so the whole declaration
 * is deep-frozen: `matchAll` copies its source's `lastIndex` into the clone it
 * iterates, so one `exec`/`test` on a shared global regex anywhere in the
 * process would make every later scan drop matches, and the digest cannot see
 * that. Frozen, `lastIndex` stays 0 and such a call throws instead. The core
 * reads a global regex only through `matchAll` and `split` (which never write
 * it) and a non-global one through `exec`/`test` (which do not either).
 */

import { createHash } from 'node:crypto';

import { deepFreeze } from '@vibe-agent-toolkit/utils';

/*
 * Every regex is a literal, written out from fragments (a month list, an
 * environment variable name, a command position, a binary name): the
 * declaration test rebuilds each composition below and pins the literal's
 * source to it, so a literal cannot drift from what this comment says it is.
 * This is the only statement of the patterns; no lane holds a copy.
 *
 * - Time-sensitive: `\b<phrase> <month> \d{4}\b`, the month list
 *   `(?:january|...|december)`, case-insensitive.
 * - Asset: `$NAME`, `${NAME}`, `$env:NAME` and `${env:NAME}`, case-insensitive,
 *   never consuming an enclosing expansion's brace.
 * - Command: a command position (`(?:^|[|;&\x60])\s*`: start of line, or after
 *   a pipe, semicolon, ampersand or backtick, then indentation), the command,
 *   then for a flag check one lazy segment up to the next separator
 *   (`[^\n|;&\x60]*?`) before the flag.
 * - External CLI: `(^|[\s;|&])<binary>(\s|$)`, multiline.
 */
export const SKILL_TEXT_DECLARATION = deepFreeze({
  /** The one line separator every line number and line count is taken on. */
  lineSeparator: '\n',

  /** The raw capture of the first `# ` line, for a skill its frontmatter does not name. */
  h1: /^#[ \t]([^\n]*)$/m,

  /** SKILL_TIME_SENSITIVE_CONTENT: per line, the first pattern that matches. */
  timeSensitive: {
    family: 'timeSensitive',
    patterns: [
      { id: 'as-of-month', pattern: /\bas of (?:january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\b/i },
      { id: 'after-month', pattern: /\bafter (?:january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\b/i },
      { id: 'before-month', pattern: /\bbefore (?:january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\b/i },
      { id: 'until-month', pattern: /\buntil (?:january|february|march|april|may|june|july|august|september|october|november|december) \d{4}\b/i },
      { id: 'as-of-year-month', pattern: /\bas of \d{4}-\d{2}\b/i },
    ],
  },

  /** NON_PORTABLE_ASSET_REFERENCE: per line, the first variant that matches. */
  nonPortableAsset: {
    family: 'nonPortableAsset',
    patterns: [
      { id: 'claude-plugin-root', pattern: /\$\{CLAUDE_PLUGIN_ROOT\}|\$\{?env:CLAUDE_PLUGIN_ROOT\b|\$\{?CLAUDE_PLUGIN_ROOT\b/i },
      { id: 'claude-project-dir', pattern: /\$\{CLAUDE_PROJECT_DIR\}|\$\{?env:CLAUDE_PROJECT_DIR\b|\$\{?CLAUDE_PROJECT_DIR\b/i },
      { id: 'claude-skill-dir', pattern: /\$\{CLAUDE_SKILL_DIR\}|\$\{?env:CLAUDE_SKILL_DIR\b|\$\{?CLAUDE_SKILL_DIR\b/i },
      { id: 'api-skill-mount', pattern: /(?:^|[\s"'`(])\/skills\/[A-Za-z0-9._-]+(?:\/|(?![\w.-]))/ },
      {
        id: 'absolute-script-path',
        pattern: /\b(?:node|bun|deno|python3?|ruby|sh|bash|uv)\s+["']?\/[^\s"']+\.(?:mjs|cjs|js|ts|py|rb|sh)\b/,
      },
    ],
  },

  /** NON_PORTABLE_COMMAND: per line, the first variant that matches. */
  nonPortableCommand: {
    family: 'nonPortableCommand',
    patterns: [
      { id: 'timeout', pattern: /(?:^|[|;&\x60])\s*timeout\s+\S+/ },
      {
        id: 'grep-pcre',
        pattern: /(?:^|[|;&\x60])\s*grep\b[^\n|;&\x60]*?\s(?:-[A-Za-z]*P|--perl-regexp)\b/,
      },
      { id: 'sed-i-no-backup', pattern: /(?:^|[|;&\x60])\s*sed\b[^\n|;&\x60]*?\s-i(?=\s|$)/ },
      { id: 'readlink-f', pattern: /(?:^|[|;&\x60])\s*readlink\b[^\n|;&\x60]*?\s-[a-z]*f\b/ },
      { id: 'date-d', pattern: /(?:^|[|;&\x60])\s*date\b[^\n|;&\x60]*?\s-d\b/ },
    ],
  },

  /**
   * MCP_TOOL_NAME_UNQUALIFIED: per line, each distinct trimmed code-span name
   * the document's prose spells fully-qualified, unless that line qualifies it.
   * `mcp__<server>__<tool>` is found by the core's scanner from `prefix`,
   * `separator` and the three character classes, never by a regex over the
   * text: the regex it replaced (`/\bmcp__[\w-]+?__([a-z][A-Za-z0-9_-]*)(?![\w-])/gu`)
   * is quadratic on `"mcp__-".repeat(n)`.
   */
  mcp: {
    family: 'mcpUnqualified',
    patternId: 'mcp-code-span',
    frontmatterFence: '---',
    prefix: 'mcp__',
    separator: '__',
    /** `\b`'s word class, one character. */
    wordChar: /^\w$/u,
    /** A name character of either half: `[\w-]`, one character. */
    nameChar: /^[\w-]$/u,
    /** The first character of a tool half. */
    toolStart: /^[a-z]$/u,
    /** Separators a tool capture may end on, trimmed off it. */
    toolSeparators: ['-', '_'],
    /** The two characters whose presence makes a tool name multi-segment. */
    underscore: '_',
    hyphen: '-',
    /** `ServerName:tool_name`; linear because the lookbehind admits one start per name run. */
    apiQualified: /(?<![\w-])([\w-]+):([a-z]\w*)(?![\w-])/gu,
    serverIsNamed: /^[A-Z][A-Za-z0-9-]*$/u,
    toolStartsLowercase: /^[a-z]/u,
    toolHasCaseHump: /[a-z0-9][A-Z]/u,
    codeSpan: /`([^`\n]+)`/g,
  },

  /**
   * SKILL_CROSS_SKILL_AUTH_UNDECLARED: the distinct tokens with a dependency
   * intro in the `lookbehindChars` before them — sibling refs, then env keys,
   * each in text order. `family` scans the whole text (the packaging lane);
   * `bodyFamily` scans the frontmatter parser's body (the skill lane).
   */
  crossSkill: {
    family: 'crossSkillAuth',
    bodyFamily: 'crossSkillAuthBody',
    siblingRef: { id: 'sibling-skill-ref', pattern: /`([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/gi },
    envKey: { id: 'anthropic-env-key', pattern: /\bANTHROPIC_[A-Z][A-Z0-9_]*_(?:API_)?KEY\b/g },
    /** The generic key: the universal default, never a cross-skill dependency. */
    envKeySkip: 'ANTHROPIC_API_KEY',
    dependencyIntro: /\b(requires?|depends?\s+on)\b/i,
    lookbehindChars: 60,
  },

  /** SKILL_BODY_NOT_IMPERATIVE over the frontmatter parser's body: second-person openers outside fences and quotes. */
  imperative: {
    family: 'imperativeBody',
    id: 'second-person-opener',
    opener: /^You\s+(should|can|need|must|will|may)\b/i,
    fence: /^\s*```/,
    quote: /^\s*>/,
    sampleChars: 80,
  },

  /**
   * The fence rule `frontmatterFencesOf` applies for both the frontmatter
   * parser and the body families: a leading BOM dropped, `\r\n`, a lone `\r`
   * and `\n` each one line ending, the first line a fence, the block closed by
   * the next fence line. The body is everything after that closing line.
   */
  body: {
    bom: String.fromCodePoint(0xfe_ff),
    lineEnding: /\r\n?|\n/,
    fence: /^---[ \t]*$/,
  },

  /** The compat capability evidence, in the order the detector emits it. */
  compat: {
    /** The frontmatter span on CRLF-normalized text, only to locate the `allowed-tools:` key's line. */
    crlf: '\r\n',
    frontmatter: /^---\n([\s\S]*?)\n---/,
    allowedToolsKey: {
      family: 'compatAllowedToolsKey',
      id: 'allowed-tools-key',
      pattern: /^(?:"allowed-tools"|'allowed-tools'|allowed-tools)\s*:/m,
    },
    proseTool: {
      family: 'compatProseTool',
      id: 'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
      pattern: /\b(Bash|Edit|Write|NotebookEdit)\s+tool\b/,
    },
    /** Fenced code blocks; an LF must follow the language, so a CRLF document has none. */
    codeBlock: /^```(\w*)\n([\s\S]*?)^```/gm,
    fencedShell: { family: 'compatFencedShell', id: 'FENCED_SHELL_BLOCK' },
    shellLanguages: ['bash', 'sh', 'shell', 'zsh'],
    /** External CLIs, per shell or unlabelled block, in this order; the first match of each in the block. */
    externalCliFamily: 'compatExternalCli',
    externalCli: [
      { binary: 'az', patternId: 'EXTERNAL_CLI_AZ', pattern: /(^|[\s;|&])az(\s|$)/m },
      { binary: 'aws', patternId: 'EXTERNAL_CLI_AWS', pattern: /(^|[\s;|&])aws(\s|$)/m },
      { binary: 'gcloud', patternId: 'EXTERNAL_CLI_GCLOUD', pattern: /(^|[\s;|&])gcloud(\s|$)/m },
      { binary: 'kubectl', patternId: 'EXTERNAL_CLI_KUBECTL', pattern: /(^|[\s;|&])kubectl(\s|$)/m },
      { binary: 'docker', patternId: 'EXTERNAL_CLI_DOCKER', pattern: /(^|[\s;|&])docker(\s|$)/m },
      { binary: 'terraform', patternId: 'EXTERNAL_CLI_TERRAFORM', pattern: /(^|[\s;|&])terraform(\s|$)/m },
      { binary: 'gh', patternId: 'EXTERNAL_CLI_GH', pattern: /(^|[\s;|&])gh(\s|$)/m },
      { binary: 'op', patternId: 'EXTERNAL_CLI_OP', pattern: /(^|[\s;|&])op(\s|$)/m },
    ],
    /** Browser-auth flows, in this order; the first match of each in the whole text. */
    browserAuthFamily: 'compatBrowserAuth',
    browserAuth: [
      { id: 'BROWSER_AUTH_MSAL_PYTHON_IMPORT', pattern: /\bfrom\s+msal\b/ },
      { id: 'BROWSER_AUTH_MSAL_JS_IMPORT', pattern: /@azure\/msal-(node|browser|common)/ },
      { id: 'BROWSER_AUTH_AZ_LOGIN', pattern: /(^|[\s;|&])az\s+login\b/m },
      { id: 'BROWSER_AUTH_GCLOUD_LOGIN', pattern: /(^|[\s;|&])gcloud\s+auth\s+login\b/m },
      { id: 'BROWSER_AUTH_AWS_SSO_LOGIN', pattern: /(^|[\s;|&])aws\s+sso\s+login\b/m },
      { id: 'BROWSER_AUTH_WEBBROWSER_OPEN', pattern: /\bwebbrowser\.open\s*\(/ },
    ],
  },
} as const);

/** The declaration's type: what the core and the digest take. */
export type SkillTextDeclaration = typeof SKILL_TEXT_DECLARATION;


/** The external CLIs the compat evidence names, with the pattern ID each is evidenced by. */
export const EXTERNAL_CLI_BINARIES = SKILL_TEXT_DECLARATION.compat.externalCli;

/** A variant of the two portability families. */
export type VariantId =
  | SkillTextDeclaration['nonPortableAsset']['patterns'][number]['id']
  | SkillTextDeclaration['nonPortableCommand']['patterns'][number]['id'];

/** Every pattern ID a skill-text record can carry. */
export type PatternId =
  | SkillTextDeclaration['timeSensitive']['patterns'][number]['id']
  | VariantId
  | SkillTextDeclaration['mcp']['patternId']
  | SkillTextDeclaration['crossSkill']['siblingRef']['id']
  | SkillTextDeclaration['crossSkill']['envKey']['id']
  | SkillTextDeclaration['imperative']['id']
  | SkillTextDeclaration['compat']['allowedToolsKey']['id']
  | SkillTextDeclaration['compat']['proseTool']['id']
  | SkillTextDeclaration['compat']['fencedShell']['id']
  | SkillTextDeclaration['compat']['externalCli'][number]['patternId']
  | SkillTextDeclaration['compat']['browserAuth'][number]['id'];

const D = SKILL_TEXT_DECLARATION;

/** The pattern IDs each family's records may carry; its keys are every family, in emission order. */
export const SKILL_TEXT_FAMILY_PATTERNS = {
  [D.timeSensitive.family]: D.timeSensitive.patterns.map(({ id }) => id),
  [D.nonPortableAsset.family]: D.nonPortableAsset.patterns.map(({ id }) => id),
  [D.nonPortableCommand.family]: D.nonPortableCommand.patterns.map(({ id }) => id),
  [D.mcp.family]: [D.mcp.patternId],
  [D.crossSkill.family]: [D.crossSkill.siblingRef.id, D.crossSkill.envKey.id],
  [D.crossSkill.bodyFamily]: [D.crossSkill.siblingRef.id, D.crossSkill.envKey.id],
  [D.imperative.family]: [D.imperative.id],
  [D.compat.allowedToolsKey.family]: [D.compat.allowedToolsKey.id],
  [D.compat.proseTool.family]: [D.compat.proseTool.id],
  [D.compat.fencedShell.family]: [D.compat.fencedShell.id],
  [D.compat.externalCliFamily]: D.compat.externalCli.map(({ patternId }) => patternId),
  [D.compat.browserAuthFamily]: D.compat.browserAuth.map(({ id }) => id),
} as const satisfies Record<string, readonly PatternId[]>;

/** A family of skill-text records. */
export type SkillTextFamily = keyof typeof SKILL_TEXT_FAMILY_PATTERNS;

/** The pattern IDs a record of `Family` may carry. */
export type SkillTextFamilyPatternId<Family extends SkillTextFamily> = (typeof SKILL_TEXT_FAMILY_PATTERNS)[Family][number];

/** Every family, in emission order. */
export const SKILL_TEXT_FAMILIES = Object.keys(SKILL_TEXT_FAMILY_PATTERNS) as SkillTextFamily[];

/** Every pattern ID, each once. */
export const SKILL_TEXT_PATTERN_IDS: PatternId[] = [
  ...new Set<PatternId>(Object.values(SKILL_TEXT_FAMILY_PATTERNS).flat()),
];

/** Code-unit order: the same on every machine, unlike a locale's collation. */
function byCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A canonical serialization: a regex as its source and flags, an array in
 * order, an object as `[key, value]` pairs in code-unit key order, a string or
 * number as JSON.
 */
function canonical(value: unknown): unknown {
  if (value instanceof RegExp) return { regexFlags: value.flags, regexSource: value.source };
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .sort(byCodeUnits)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]);
  }
  return value;
}

/**
 * The sha256 of `declaration`'s canonical serialization: it moves with every
 * regex source or flag, constant and order the core applies, and not with
 * object key order. The core's control flow is not covered.
 *
 * @param declaration - The declaration a core applies: {@link SKILL_TEXT_DECLARATION}
 */
export function skillTextDeclarationDigest(declaration: SkillTextDeclaration): string {
  return createHash('sha256').update(JSON.stringify(canonical(declaration))).digest('hex');
}
