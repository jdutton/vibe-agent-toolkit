/**
 * Changelog fragments: one `.changes/<topic>.md` per branch or topic, folded
 * into `CHANGELOG.md` by the stable version bump.
 *
 * Every branch used to edit the same `## [Unreleased]` block of one 900-line
 * file, so every rebase conflicted there and the conflict was resolved by
 * hand — the trap being that "keep ours" silently drops what theirs added. A
 * fragment is a file only its branch touches: no two branches conflict on it,
 * and `bump-version <stable>` is the one place they meet, appending each
 * fragment's bullets under the matching `### Section` of the new version
 * heading and deleting the fragment.
 *
 * A fragment is well-formed when:
 *   - it is non-empty;
 *   - every heading is `### <Section>` with `<Section>` one of
 *     {@link FRAGMENT_SECTIONS} — no `## [version]` headings, those belong to
 *     the changelog;
 *   - the first non-blank line is such a heading;
 *   - every other non-blank line is a bullet (`- `) or an indented continuation.
 *
 * `validate-structure` runs {@link validateFragments} so a malformed fragment
 * fails the gate on the branch that wrote it, not the release that folds it.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';

import { direntKindFollowingSync, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

/** Where fragments live, relative to the repo root. */
export const CHANGES_DIR = '.changes';

/** The section headings a fragment may use, in the order the changelog lists them. */
export const FRAGMENT_SECTIONS = [
  'Breaking',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Security',
  'Fixed',
] as const;

export type FragmentSection = (typeof FRAGMENT_SECTIONS)[number];

/** One parsed fragment. */
export interface ChangelogFragment {
  /** Path relative to the repo root. */
  readonly relPath: string;
  /** Section → the lines under it (bullets and their continuations), verbatim. */
  readonly sections: ReadonlyMap<FragmentSection, readonly string[]>;
}

/** A fragment the parser refused, and why. */
export interface FragmentProblem {
  readonly relPath: string;
  readonly reason: string;
}

const HEADING_PREFIX = '### ';
const isSection = (name: string): name is FragmentSection => (FRAGMENT_SECTIONS as readonly string[]).includes(name);

/** The `### ` heading's name, or `undefined` for any other line. */
function sectionHeadingOf(line: string): string | undefined {
  return line.startsWith(HEADING_PREFIX) ? line.slice(HEADING_PREFIX.length).trim() : undefined;
}

/** What one non-blank fragment line is. */
type FragmentLine =
  | { kind: 'section'; name: string }
  | { kind: 'other-heading' }
  | { kind: 'bullet' }
  | { kind: 'continuation' }
  | { kind: 'prose' };

function classifyLine(line: string): FragmentLine {
  const name = sectionHeadingOf(line);
  if (name !== undefined) return { kind: 'section', name };
  if (line.startsWith('#')) return { kind: 'other-heading' };
  if (line.startsWith('- ')) return { kind: 'bullet' };
  if (line.startsWith(' ') || line.startsWith('\t')) return { kind: 'continuation' };
  return { kind: 'prose' };
}

/** Parser state while walking a fragment's lines. */
interface ParseState {
  readonly sections: Map<FragmentSection, string[]>;
  current: FragmentSection | undefined;
  sawBullet: boolean;
}

/** Apply one classified line; the reason it was refused, or `undefined`. */
function applyLine(state: ParseState, line: string, classified: FragmentLine): string | undefined {
  switch (classified.kind) {
    case 'section': {
      if (!isSection(classified.name)) {
        return `"### ${classified.name}" is not a changelog section; use one of ${FRAGMENT_SECTIONS.join(', ')}`;
      }
      state.current = classified.name;
      if (!state.sections.has(classified.name)) state.sections.set(classified.name, []);
      return undefined;
    }
    case 'other-heading':
      return 'only "### <Section>" headings are allowed in a fragment; version headings belong to CHANGELOG.md';
    case 'prose':
      return state.current === undefined
        ? 'content before the first "### <Section>" heading'
        : 'expected a "- " bullet or an indented continuation line';
    case 'bullet':
    case 'continuation': {
      if (state.current === undefined) return 'content before the first "### <Section>" heading';
      if (classified.kind === 'bullet') state.sawBullet = true;
      state.sections.get(state.current)?.push(line);
      return undefined;
    }
  }
}

/**
 * Parse one fragment's text.
 *
 * @param text - The file's content
 * @param relPath - Its path, for the problem report
 * @returns The fragment, or the first problem found
 */
export function parseFragment(text: string, relPath: string): ChangelogFragment | FragmentProblem {
  const state: ParseState = { sections: new Map(), current: undefined, sawBullet: false };

  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    const reason = applyLine(state, line, classifyLine(line));
    if (reason !== undefined) return { relPath, reason: `${relPath}:${index + 1}: ${reason}` };
  }

  if (!state.sawBullet) return { relPath, reason: `${relPath}: no bullets — an empty fragment says nothing to the reader` };
  return { relPath, sections: state.sections };
}

/** Whether a parse result is a problem rather than a fragment. */
export function isFragmentProblem(result: ChangelogFragment | FragmentProblem): result is FragmentProblem {
  return 'reason' in result;
}

/** The fragment files under `.changes/`, sorted; `README.md` is documentation, not a fragment. */
export function listFragmentFiles(repoRoot: string): string[] {
  try {
    const dir = safePath.join(repoRoot, CHANGES_DIR);
    return readdirSync(dir, { withFileTypes: true })
      // Followed: a linked fragment is a fragment.
      .filter((entry) => direntKindFollowingSync(dir, entry) === 'file' && entry.name.endsWith('.md') && entry.name !== 'README.md')
      .map((entry) => `${CHANGES_DIR}/${entry.name}`)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
}

/** Every fragment, parsed; problems are returned beside the fragments, never dropped. */
export function readFragments(repoRoot: string): { fragments: ChangelogFragment[]; problems: FragmentProblem[] } {
  const fragments: ChangelogFragment[] = [];
  const problems: FragmentProblem[] = [];
  for (const relPath of listFragmentFiles(repoRoot)) {
    const result = parseFragment(readFileSync(safePath.join(repoRoot, relPath), 'utf8'), relPath);
    if (isFragmentProblem(result)) problems.push(result);
    else fragments.push(result);
  }
  return { fragments, problems };
}

/** The problems with the fragments on disk — empty when every fragment is well-formed. */
export function validateFragments(repoRoot: string): FragmentProblem[] {
  return readFragments(repoRoot).problems;
}

/**
 * Fold fragments into the body of one changelog version section.
 *
 * Bullets land at the END of the matching `### Section` when the body already
 * has one, so a section's existing sub-structure (`#### CLI`, prose) is kept
 * intact; sections the body lacks are appended in {@link FRAGMENT_SECTIONS}
 * order. The body's own text is never rewritten.
 *
 * @param body - The text under a version heading, up to the next `## ` heading
 * @param fragments - The fragments to fold in
 * @returns The merged body
 */
export function mergeFragmentsIntoBody(body: string, fragments: readonly ChangelogFragment[]): string {
  const byName = new Map<FragmentSection, string[]>();
  for (const fragment of fragments) {
    for (const [section, lines] of fragment.sections) {
      const bucket = byName.get(section) ?? [];
      bucket.push(...lines);
      byName.set(section, bucket);
    }
  }
  if (byName.size === 0) return body;

  const trimmed = body.trimEnd();
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  // Index of each `### Section` heading in the body, by its exact name.
  const headingAt = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const name = sectionHeadingOf(line);
    if (name !== undefined) headingAt.set(name, index);
  }
  // A section ends at the next `## `/`### ` heading; a `#### ` sub-heading is
  // part of the section it sits in.
  const nextHeading = (from: number): number => {
    const after = lines.findIndex((line, index) => index > from && /^#{2,3} /.test(line));
    return after === -1 ? lines.length : after;
  };

  // Insert deepest-first so earlier indices stay valid.
  const existing = FRAGMENT_SECTIONS.filter((section) => byName.has(section) && headingAt.has(section))
    .map((section) => ({ section, at: headingAt.get(section) ?? 0 }))
    .sort((a, b) => b.at - a.at);
  for (const { section, at } of existing) {
    const end = nextHeading(at);
    // Trim trailing blank lines inside the section, then append with one blank separator.
    let insertAt = end;
    while (insertAt > at + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, '', ...(byName.get(section) ?? []));
  }

  const missing = FRAGMENT_SECTIONS.filter((section) => byName.has(section) && !headingAt.has(section));
  for (const section of missing) {
    lines.push('', `### ${section}`, '', ...(byName.get(section) ?? []));
  }

  return `${lines.join('\n')}\n`;
}

/** Delete the fragment files that were folded in. */
export function deleteFragments(repoRoot: string, fragments: readonly ChangelogFragment[]): void {
  for (const fragment of fragments) rmSync(safePath.join(repoRoot, fragment.relPath));
}
