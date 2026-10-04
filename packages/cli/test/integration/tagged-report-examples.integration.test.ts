/**
 * Every tagged fenced example in the docs is a valid report, and every report
 * entry of the registry has one — one per ENTRY, not per verb: verbs that share
 * an entry (`build` and `verify` publish `validate`'s) share its example.
 *
 * ## The tag
 *
 * A fenced block whose info string is a language followed by `vat-report=<verb>`
 * (language `yaml` or `json`, `<verb>` exactly as typed after `vat`, spaces and
 * all — for example `yaml vat-report=skills validate`) is a published document.
 * It must parse and validate against the registry schema of the verb it names
 * (`PUBLISHED_SHAPES` in `src/report-schemas.ts`, entries of kind `report`).
 *
 * This is the one sanctioned reading of code blocks for meaning: it reads ONLY
 * blocks that carry the tag, and no other block is parsed. The population is
 * `git ls-files '*.md'` minus `CHANGELOG.md` and `.changes/` (history that
 * quotes retired shapes).
 *
 * Both ways: an unknown verb in a tag fails; a report entry with no tagged
 * example fails; a tagged block that does not parse or validate fails with its
 * file and line. An example is produced by running the built CLI and trimming,
 * never written by hand.
 *
 * ## Why this is an integration test
 *
 * It spawns `git ls-files` and reads every tracked markdown file — real I/O,
 * which the unit tier forbids (`local/no-io-in-unit-tier`).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { PUBLISHED_SHAPES } from '../../src/report-schemas.js';

const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

const TAG = 'vat-report=';
const MAX_FENCE_INDENT = 3;
const MIN_FENCE_LENGTH = 3;

/** A fence line split into its marker run and the rest of the line; undefined when `text` is not a fence. */
function parseFence(text: string): { marker: string; rest: string } | undefined {
  const indent = text.length - text.trimStart().length;
  if (indent > MAX_FENCE_INDENT) return undefined;
  const body = text.slice(indent);
  const char = body.charAt(0);
  if (char !== '`' && char !== '~') return undefined;
  let length = 0;
  while (body.charAt(length) === char) length++;
  return length < MIN_FENCE_LENGTH ? undefined : { marker: body.slice(0, length), rest: body.slice(length) };
}

interface TaggedBlock {
  readonly file: string;
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly language: string;
  readonly verb: string;
  readonly body: string;
}

interface ReportEntry {
  readonly verbs: readonly string[];
  readonly schema: { safeParse(value: unknown): { success: true } | { success: false; error: { issues: readonly { path: readonly (string | number)[]; message: string }[] } } };
}

const REPORT_ENTRIES: readonly ReportEntry[] = PUBLISHED_SHAPES.filter((shape) => shape.kind === 'report') as unknown as readonly ReportEntry[];

/** A fence that is open: its marker, where it opened, its info string and the lines so far. */
interface OpenFence {
  readonly marker: string;
  readonly line: number;
  readonly info: string;
  readonly body: string[];
}

/** What reading one file found: the tagged blocks, and every tag it could not read as one. */
interface TaggedScan {
  readonly blocks: TaggedBlock[];
  readonly problems: string[];
}

/** An info string that is exactly `<language> vat-report=<verb>`. */
function parseTag(info: string): { language: string; verb: string } | undefined {
  const tagAt = info.indexOf(TAG);
  if (tagAt <= 0) return undefined;
  const language = info.slice(0, tagAt).trim();
  if (language.length === 0 || /\s/.test(language) || info.charAt(tagAt - 1) !== ' ') return undefined;
  return { language, verb: info.slice(tagAt + TAG.length).trim() };
}

/** Whether an info string is meant as a tag, however badly it is spelled. */
function mentionsTag(info: string): boolean {
  return /vat[-_ ]?report/i.test(info);
}

/** Record `fence` as a block, or as a problem when it mentions the tag without being one: a tag is never skipped silently. */
function recordFence(file: string, fence: OpenFence, scan: TaggedScan): void {
  if (!mentionsTag(fence.info)) return;
  const tag = parseTag(fence.info);
  if (tag === undefined) {
    scan.problems.push(`${file}:${fence.line}: info string "${fence.info}" mentions vat-report but is not "<yaml|json> vat-report=<verb>"`);
    return;
  }
  scan.blocks.push({ file, line: fence.line, language: tag.language, verb: tag.verb, body: fence.body.join('\n') });
}

/** Whether `text` closes `fence`: the same marker character, at least as long, and nothing after it. */
function closes(text: string, fence: OpenFence): boolean {
  const match = parseFence(text);
  if (match === undefined) return false;
  return match.marker.startsWith(fence.marker.charAt(0)) && match.marker.length >= fence.marker.length && match.rest.trim() === '';
}

/** The tagged blocks of `markdown` and every tag it could not read; every other fence is skipped whole. */
function collectTaggedBlocks(file: string, markdown: string): TaggedScan {
  const scan: TaggedScan = { blocks: [], problems: [] };
  let open: OpenFence | undefined;
  for (const [index, text] of markdown.split('\n').entries()) {
    if (open === undefined) {
      const match = parseFence(text);
      if (match !== undefined) open = { marker: match.marker, line: index + 1, info: match.rest.trim(), body: [] };
    } else if (closes(text, open)) {
      recordFence(file, open, scan);
      open = undefined;
    } else {
      open.body.push(text);
    }
  }
  if (open !== undefined && mentionsTag(open.info)) scan.problems.push(`${file}:${open.line}: fence tagged vat-report is never closed`);
  return scan;
}

function entryForVerb(verb: string): ReportEntry | undefined {
  return REPORT_ENTRIES.find((entry) => entry.verbs.includes(verb));
}

/** One line per problem in `blocks`; empty when every block parses and validates. */
function problemsIn(blocks: readonly TaggedBlock[]): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const where = `${block.file}:${block.line}`;
    const entry = entryForVerb(block.verb);
    if (entry === undefined) {
      problems.push(`${where}: vat-report=${block.verb} names no report verb`);
      continue;
    }
    let document: unknown;
    try {
      if (block.language === 'json') document = JSON.parse(block.body);
      else if (block.language === 'yaml') document = yaml.parse(block.body);
      else {
        problems.push(`${where}: language "${block.language}" is neither yaml nor json`);
        continue;
      }
    } catch (error) {
      problems.push(`${where}: does not parse as ${block.language}: ${(error as Error).message}`);
      continue;
    }
    const verdict = entry.schema.safeParse(document);
    if (!verdict.success) {
      const issues = verdict.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      problems.push(`${where}: not a valid ${block.verb} report: ${issues}`);
    }
  }
  return problems;
}

/** One line per report entry that no block in `blocks` exemplifies. */
function uncoveredIn(blocks: readonly TaggedBlock[]): string[] {
  const covered = new Set(blocks.map((block) => entryForVerb(block.verb)));
  return REPORT_ENTRIES.filter((entry) => !covered.has(entry)).map((entry) => `no tagged example for ${entry.verbs.join(' | ')}`);
}

function trackedMarkdown(): string[] {
  const result = spawnSync(gitExecutable(), ['ls-files', '-z', '--', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout
    .split('\0')
    .filter((path) => path.length > 0 && path !== 'CHANGELOG.md' && !toForwardSlash(path).startsWith('.changes/'));
}

function scanTracked(): TaggedScan {
  const scans = trackedMarkdown().map((file) => collectTaggedBlocks(file, readFileSync(safePath.join(REPO_ROOT, file), 'utf8')));
  return { blocks: scans.flatMap((scan) => scan.blocks), problems: scans.flatMap((scan) => scan.problems) };
}

const GOOD_DOCUMENT = 'status: ok\nexamined: 0\nfindings: []\nsummary:\n  errors: 0\n  warnings: 0\n  info: 0\ngate:\n  strict: false\ndata: null\n';

function fenced(info: string, body: string): string {
  return `intro\n\n\`\`\`${info}\n${body}\`\`\`\n`;
}

describe('tagged report examples — the checker itself', () => {
  it('reads only tagged blocks, with file and line, and skips a tag nested in a longer fence', () => {
    const markdown = `${fenced('yaml', 'a: 1\n')}\n${fenced('yaml vat-report=cache clear', 'a: 1\n')}\n\`\`\`\`md\n\`\`\`yaml vat-report=cache clear\nb: 2\n\`\`\`\n\`\`\`\`\n`;
    const { blocks, problems } = collectTaggedBlocks('x.md', markdown);
    expect(problems).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ file: 'x.md', line: 9, language: 'yaml', verb: 'cache clear', body: 'a: 1' });
  });

  it('fails an unknown verb', () => {
    const { blocks } = collectTaggedBlocks('x.md', fenced('yaml vat-report=no such verb', GOOD_DOCUMENT));
    expect(problemsIn(blocks)).toEqual(['x.md:3: vat-report=no such verb names no report verb']);
  });

  it('fails a document the verb schema rejects, naming file and line', () => {
    const { blocks } = collectTaggedBlocks('x.md', fenced('yaml vat-report=cache clear', 'status: success\n'));
    const [problem] = problemsIn(blocks);
    expect(problem).toMatch(/^x\.md:3: not a valid cache clear report: /);
  });

  it('fails a block that does not parse', () => {
    const { blocks } = collectTaggedBlocks('x.md', fenced('json vat-report=cache clear', '{ not json\n'));
    expect(problemsIn(blocks)[0]).toMatch(/^x\.md:3: does not parse as json: /);
  });

  it('reports every report entry as uncovered when nothing is tagged', () => {
    const uncovered = uncoveredIn([]);
    expect(uncovered).toHaveLength(REPORT_ENTRIES.length);
    expect(uncovered).toContain('no tagged example for cache clear');
  });
});

/** Every problem scanning `markdown` finds: unreadable tags first, then what the blocks it did read get wrong. */
function scanProblems(markdown: string): string[] {
  const scan = collectTaggedBlocks('x.md', markdown);
  return [...scan.problems, ...problemsIn(scan.blocks)];
}

describe('tagged report examples — a tag can never be skipped silently', () => {
  it('reports a tagged fence that never closes', () => {
    const markdown = 'intro\n\n```yaml vat-report=cache clear\nstatus: ok\n';
    expect(scanProblems(markdown)).toEqual(['x.md:3: fence tagged vat-report is never closed']);
  });

  it('reports a tag with no language', () => {
    expect(scanProblems(fenced('vat-report=cache clear', GOOD_DOCUMENT))).toEqual([
      'x.md:3: info string "vat-report=cache clear" mentions vat-report but is not "<yaml|json> vat-report=<verb>"',
    ]);
  });

  it('reports a tag whose language holds whitespace', () => {
    expect(scanProblems(fenced('yaml title=x vat-report=cache clear', GOOD_DOCUMENT))).toEqual([
      'x.md:3: info string "yaml title=x vat-report=cache clear" mentions vat-report but is not "<yaml|json> vat-report=<verb>"',
    ]);
  });

  it('reports a mistyped tag', () => {
    expect(scanProblems(fenced('yaml vat-report:cache clear', GOOD_DOCUMENT))).toHaveLength(1);
    expect(scanProblems(fenced('yaml vat_report=cache clear', GOOD_DOCUMENT))).toHaveLength(1);
  });

  it('reports a tag with an empty verb', () => {
    expect(scanProblems(fenced('yaml vat-report=', GOOD_DOCUMENT))).toHaveLength(1);
  });
});

describe('tagged report examples — the docs', () => {
  const { blocks, problems } = scanTracked();

  it('every tagged block parses and validates against its verb schema, and no tag is unreadable', () => {
    expect([...problems, ...problemsIn(blocks)]).toEqual([]);
  });

  it('every report entry has at least one tagged example', () => {
    expect(uncoveredIn(blocks)).toEqual([]);
  });
});
