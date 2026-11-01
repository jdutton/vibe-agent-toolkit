/**
 * Every surface that says when `vat resources validate`'s `data.population` is
 * `null` names the SAME cases.
 *
 * The list is prose — the schema describe, `--help`, and every markdown
 * passage that states it (the skill, the population matrix, the CLI reference,
 * the changelog) — and nothing executes prose, so one surface kept a case ("no
 * root enumerated") for a whole review round after the code that produced it
 * was deleted. The markdown passages are FOUND, by scanning every tracked page,
 * so a page that starts stating the cases is held to them the day it does. The cases are
 * the walk answering: the walk lane selected, or a crawl that declined a source
 * bound to another root. And the one non-null case most often misread as null:
 * with the store off the projection lane still derives.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../src/commands/resources/validate-schema.js';
import { renderCommandHelp, subcommand } from '../help-text-helpers.js';

/** The tell each null case must be named by, on every surface. */
const NULL_CASES = [
  { name: 'the walk lane selected', tell: 'VAT_RESOURCES_CRAWL=walk' },
  { name: 'a declined source', tell: 'declined' },
] as const;

/** The non-null case every surface must state, so `null` is not read into it. */
const STORE_OFF = 'VAT_PROJECTION_STORE=0';

/** Wording for a case the code can no longer reach. */
const RETIRED_CASES = ['no root'] as const;

/** The repository root, every tracked markdown file's base. */
const REPO_ROOT = safePath.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/**
 * One surface's text, with backticks dropped and every run of whitespace one
 * space, so a wrap or a code span does not split a tell.
 *
 * @param text - The surface's raw text
 * @returns The comparable text
 */
function flattened(text: string): string {
  return text.replaceAll('`', '').replaceAll(/\s+/g, ' ');
}

/**
 * The population passage of a surface that says more than this about other things.
 *
 * @param text - The whole surface
 * @param anchor - Where the passage starts
 * @param length - How much of it to keep
 * @returns The passage
 */
function passage(text: string, anchor: string, length: number): string {
  const start = text.indexOf(anchor);
  if (start === -1) throw new Error(`surface no longer carries ${anchor}`);
  return text.slice(start, start + length);
}

/**
 * The blocks of a markdown document — a paragraph, a list item, a table row —
 * each with the heading it sits under, so a list item under
 * `### vat resources validate` knows which verb it describes.
 *
 * @param text - The whole document
 * @returns One entry per block
 */
function markdownBlocks(text: string): Array<{ readonly heading: string; readonly block: string }> {
  const blocks: Array<{ heading: string; block: string }> = [];
  let heading = '';
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) blocks.push({ heading, block: current.join('\n') });
    current = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      flush();
      heading = line;
    } else if (line.trim() === '' || line.startsWith('|') || /^\s*- /u.test(line)) {
      flush();
      if (line.trim() !== '') current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Does this block state when `vat resources validate`'s population is null?
 *
 * @param heading - The heading the block sits under
 * @param block - The block's text
 * @returns True for a block that names the verb (or sits under its heading), its population and `null`
 */
function statesValidateNull(heading: string, block: string): boolean {
  const flat = flattened(block);
  return flattened(`${heading} ${block}`).includes('resources validate') && /\bpopulation\b/u.test(flat) && /\bnull\b/u.test(flat);
}

/** Every tracked markdown file in the repository, repo-relative. */
function trackedMarkdown(): string[] {
  const listed = spawnSync(gitExecutable(), ['-C', REPO_ROOT, 'ls-files', '-z', '--', '*.md'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((path) => path !== '');
}

/**
 * Every markdown surface that states the null cases, found rather than listed:
 * a page that starts stating them is checked the day it does.
 */
function markdownSurfaces(): Array<{ readonly label: string; readonly text: () => string }> {
  return trackedMarkdown().flatMap((path) =>
    markdownBlocks(readFileSync(safePath.join(REPO_ROOT, path), 'utf8'))
      .filter(({ heading, block }) => statesValidateNull(heading, block))
      .map(({ block }, index) => ({ label: `${path} (passage ${String(index + 1)})`, text: () => block })),
  );
}

const MARKDOWN_SURFACES = markdownSurfaces();

/** Pages that state the null cases today: the scan must find each, or it has gone blind. */
const STATING_PAGES = [
  '.changes/population-provenance.md',
  'docs/architecture/command-population-matrix.md',
  'packages/cli/docs/resources.md',
  'packages/vat-development-agents/resources/skills/vat-knowledge-resources.md',
] as const;

const SURFACES: ReadonlyArray<{ readonly label: string; readonly text: () => string }> = [
  {
    label: 'the schema describe',
    text: () => RESOURCES_VALIDATE_REPORT_SCHEMA.innerType().options[0].shape.data.shape.population.description ?? '',
  },
  {
    label: 'vat resources validate --help',
    text: () => passage(renderCommandHelp(subcommand(createResourcesCommand(), 'validate')), 'data.population:', 600),
  },
  ...MARKDOWN_SURFACES,
];

describe('the markdown surfaces are found, not listed', () => {
  it.each(STATING_PAGES)('finds the passage in %s', (page) => {
    expect(MARKDOWN_SURFACES.some(({ label }) => label.startsWith(`${page} `))).toBe(true);
  });

  it('scans validation-codes.md, which names the verb without stating its null cases', () => {
    expect(trackedMarkdown()).toContain('docs/validation-codes.md');
  });
});

describe('the null cases of vat resources validate data.population', () => {
  describe.each(SURFACES)('$label', ({ text }) => {
    it.each(NULL_CASES)('names $name', ({ tell }) => {
      expect(flattened(text())).toContain(tell);
    });

    it(`says ${STORE_OFF} still derives`, () => {
      expect(flattened(text())).toContain(STORE_OFF);
    });

    it.each(RETIRED_CASES)('no longer names "%s"', (retired) => {
      expect(flattened(text())).not.toContain(retired);
    });
  });
});
