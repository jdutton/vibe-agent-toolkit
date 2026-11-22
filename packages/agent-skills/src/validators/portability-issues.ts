/**
 * The line-family constructors: SKILL_TIME_SENSITIVE_CONTENT,
 * NON_PORTABLE_ASSET_REFERENCE and NON_PORTABLE_COMMAND, built from a
 * document's skill-text record.
 *
 * The text half of each (per line, the first pattern or variant that matches)
 * is the skill-text core's in `@vibe-agent-toolkit/resources`, whose
 * declaration holds every pattern. What stays here is judgement: each
 * variant's label (its pattern ID), its fix and the message.
 *
 * A *portability check family* rolls every variant up to one registry code, so
 * one `validation.allow` entry (or severity override) silences the whole concern
 * for a file — adding an esoteric check never explodes the override surface.
 * Each variant still carries its own label (named in the finding) and fix
 * (tailored remediation), so the guidance stays specific. Extend a family by
 * adding a variant to the declaration and a fix here: the `satisfies` below
 * refuses one without the other.
 */

import type { SkillTextFacts, VariantId } from '@vibe-agent-toolkit/resources';
import { CODE_REGISTRY, type IssueCode, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import { recordsOf } from './skill-text-records.js';

const RELATIVE_PATH_HINT =
  'Reference bundled files by a path relative to the skill directory (e.g. `scripts/run.mjs`).';

/**
 * Each portability variant's remediation, shown as the finding's `fix`.
 *
 * The NON_PORTABLE_COMMAND fixes assert how a utility behaves on macOS/BSD. The
 * CI matrix is Ubuntu + Windows only, so no test in this repo can contradict
 * these claims — they are vendor claims and go stale silently. The `readlink-f`
 * variant already did: `-f` was absent from macOS for years, and is present and
 * working as of macOS 26.5.2. When a variant's macOS behaviour converges with
 * GNU, DELETE the variant — do not reword it, or the detector trains adopters to
 * ignore the code.
 *
 * @vendor-claim reviewed=2026-07-29 verify=On a current macOS, run each variant against the system binaries rather than Homebrew coreutils — `ls /usr/bin/timeout`, `echo x | /usr/bin/grep -P x`, `/usr/bin/sed -i s/a/b/ FILE`, `/usr/bin/readlink -f ./missing.txt`, `/bin/date -d 2020-01-01` — and run the GNU counterparts on Linux to confirm the difference still exists
 */
const VARIANT_FIXES = {
  'claude-plugin-root': `\`CLAUDE_PLUGIN_ROOT\` is a Claude Code plugin-only variable that points at the plugin, not the skill, and is absent under standalone mounts. ${RELATIVE_PATH_HINT}`,
  // NOT an asset reference. CLAUDE_PROJECT_DIR denotes the *user's repository*
  // — the thing the skill operates on — so there is no skill-relative path
  // that can express it and the RELATIVE_PATH_HINT advice does not apply.
  // Advising it here actively misleads: an adopter reported that the pattern
  // this flags (`--project-dir` → `$CLAUDE_PROJECT_DIR` → cwd) was their *fix*
  // for anchoring user artifacts on the plugin install dir by mistake.
  'claude-project-dir': '`CLAUDE_PROJECT_DIR` is a Claude Code-only variable, so a skill relying on it will not resolve the user\'s project on other runtimes. There is no skill-relative equivalent — if the skill genuinely operates on the user\'s repository, take the location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as a fallback, and make sure the skill\'s declared `targets` reflect the Claude Code dependency.',
  // Load-bearing in Claude Code and MEANINGLESS in the API code-execution
  // container: there the location is a stable literal (`/skills/<name>/`, cwd
  // `/`), so no equivalent variable is set, measured live against the Messages
  // API. `${CLAUDE_SKILL_DIR}` therefore expands to empty there.
  'claude-skill-dir': `\`CLAUDE_SKILL_DIR\` is set by Claude Code and is absent in the API code-execution container, where it expands to empty. ${RELATIVE_PATH_HINT} A relative path resolves on every target because the MODEL resolves it against the skill directory — not because cwd happens to be right. When a process genuinely needs an absolute path, instruct the agent to cd into the skill directory first rather than reaching for another variable.`,
  // The same mistake pointed the other way: the API container's literal mount
  // point hardcoded into a skill, which resolves nowhere in Claude Code.
  'api-skill-mount': `\`/skills/<name>/\` is the Anthropic API code-execution container's mount point and does not exist in Claude Code, a claude.ai upload, or any other host. ${RELATIVE_PATH_HINT} When a process genuinely needs an absolute path, instruct the agent to cd into the skill directory first.`,
  'absolute-script-path': `An absolute path to a bundled script will not exist on another machine or runtime. ${RELATIVE_PATH_HINT}`,
  'timeout': '`timeout` is not installed on macOS by default. Gate on its availability (`command -v timeout`), use a portable alternative, or drop it.',
  'grep-pcre': 'PCRE (`grep -P` / `--perl-regexp`) is unsupported by BSD/macOS grep. Use `grep -E` (extended regex) instead.',
  'sed-i-no-backup': 'GNU `sed -i` and BSD `sed -i \'\'` differ. Pass an explicit suffix (`sed -i.bak ...`) or write to a temp file and move it back.',
  'readlink-f': '`readlink -f` is not portable: on macOS it fails (exit 1, no output) when the final path component does not exist, where GNU canonicalizes it, and `-f` was absent from macOS entirely for years. Use a portable resolve (e.g. a `cd "$(dirname …)" && pwd` shell function or a Node/Python one-liner).',
  'date-d': 'GNU `date -d` is not supported by BSD/macOS `date`, which uses `-v` or `-j -f`. Avoid `-d` or branch on the platform.',
} as const satisfies Record<VariantId, string>;

/** One portability family: its code, the record family it reads and its headline. */
interface PortabilityFamily {
  readonly code: IssueCode;
  readonly family: 'nonPortableAsset' | 'nonPortableCommand';
  readonly summarize: (label: string, matchText: string) => string;
}

const NON_PORTABLE_ASSET: PortabilityFamily = {
  code: 'NON_PORTABLE_ASSET_REFERENCE',
  family: 'nonPortableAsset',
  // The headline names the finding only; remediation differs per variant (a
  // skill-relative path is the answer for bundled assets but is meaningless
  // for CLAUDE_PROJECT_DIR), so the advice lives in each variant's `fix`.
  summarize: (label, matchText) =>
    `Non-portable reference [${label}]: "${matchText.trim()}" — will not resolve on every surface this skill can run on`,
};

const NON_PORTABLE_COMMAND: PortabilityFamily = {
  code: 'NON_PORTABLE_COMMAND',
  family: 'nonPortableCommand',
  // Strip the leading command-position separator (backtick / pipe / etc.) the
  // pattern captured, so the message shows just the command.
  summarize: (label, matchText) =>
    `Non-portable command [${label}]: "${matchText.trim().replace(/^[`|;&\s]+/, '')}" — fails on macOS/BSD; use a portable equivalent`,
};

/**
 * One issue per record of a portability family: one per line (the first
 * matching variant won in the core), anchored at `docLocation` + `line`,
 * carrying the variant's label and tailored fix.
 */
function collectPortabilityFamilyIssues(
  facts: SkillTextFacts,
  docLocation: string,
  issues: ValidationIssue[],
  family: PortabilityFamily,
): void {
  const registryEntry = CODE_REGISTRY[family.code];
  for (const { patternId, line, matchText } of recordsOf(facts, family.family)) {
    const label: VariantId = patternId;
    issues.push({
      severity: registryEntry.defaultSeverity,
      code: family.code,
      message: family.summarize(label, matchText),
      location: docLocation,
      line,
      fix: VARIANT_FIXES[label],
      reference: registryEntry.reference,
    });
  }
}

/**
 * NON_PORTABLE_ASSET_REFERENCE issues of one skill document.
 *
 * @param facts - The document's skill-text record
 * @param docLocation - Its project-relative location
 * @param issues - Where the issues are appended
 */
export function collectNonPortableAssetReferenceIssues(
  facts: SkillTextFacts,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  collectPortabilityFamilyIssues(facts, docLocation, issues, NON_PORTABLE_ASSET);
}

/**
 * NON_PORTABLE_COMMAND issues of one skill document.
 *
 * @param facts - The document's skill-text record
 * @param docLocation - Its project-relative location
 * @param issues - Where the issues are appended
 */
export function collectNonPortableCommandIssues(
  facts: SkillTextFacts,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  collectPortabilityFamilyIssues(facts, docLocation, issues, NON_PORTABLE_COMMAND);
}

/**
 * SKILL_TIME_SENSITIVE_CONTENT issues: one per line whose prose may become
 * stale (the first pattern won in the core), at that line.
 *
 * @param facts - The SKILL.md's skill-text record
 * @param skillLocation - Its project-relative location
 * @param issues - Where the issues are appended
 */
export function collectTimeSensitiveContentIssues(
  facts: SkillTextFacts,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const registryEntry = CODE_REGISTRY.SKILL_TIME_SENSITIVE_CONTENT;
  for (const { line, matchText } of recordsOf(facts, 'timeSensitive')) {
    issues.push({
      severity: registryEntry.defaultSeverity,
      code: 'SKILL_TIME_SENSITIVE_CONTENT',
      message: `Time-sensitive phrase "${matchText}" may become stale`,
      location: skillLocation,
      line,
      fix: registryEntry.fix,
      reference: registryEntry.reference,
    });
  }
}
