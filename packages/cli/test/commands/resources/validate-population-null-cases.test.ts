/**
 * Every surface that says when `vat resources validate`'s `data.population` is
 * `null` names the SAME cases.
 *
 * The list is prose in four places — the schema describe, `--help`, the
 * `vat-knowledge-resources` skill and the population matrix — and nothing
 * executes prose, so one surface kept a case ("no root enumerated") for a
 * whole review round after the code that produced it was deleted. The cases are
 * the walk answering: the walk lane selected, or a crawl that declined a source
 * bound to another root. And the one non-null case most often misread as null:
 * with the store off the projection lane still derives.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createResourcesCommand } from '../../../src/commands/resources/index.js';
import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../../src/commands/resources/validate-schema.js';
import { renderCommandHelp, subcommand } from '../../help-text-helpers.js';

/** The tell each null case must be named by, on every surface. */
const NULL_CASES = [
  { name: 'the walk lane selected', tell: 'VAT_RESOURCES_CRAWL=walk' },
  { name: 'a declined source', tell: 'declined' },
] as const;

/** The non-null case every surface must state, so `null` is not read into it. */
const STORE_OFF = 'VAT_PROJECTION_STORE=0';

/** Wording for a case the code can no longer reach. */
const RETIRED_CASES = ['no root'] as const;

/** The shipped skill that teaches the resources verbs. */
const KNOWLEDGE_SKILL = new URL(
  '../../../../vat-development-agents/resources/skills/vat-knowledge-resources.md',
  import.meta.url,
);

/** The architecture matrix row for `vat resources validate`. */
const POPULATION_MATRIX = new URL('../../../../../docs/architecture/command-population-matrix.md', import.meta.url);

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

const SURFACES: ReadonlyArray<{ readonly label: string; readonly text: () => string }> = [
  {
    label: 'the schema describe',
    text: () => RESOURCES_VALIDATE_REPORT_SCHEMA.innerType().options[0].shape.data.shape.population.description ?? '',
  },
  {
    label: 'vat resources validate --help',
    text: () => passage(renderCommandHelp(subcommand(createResourcesCommand(), 'validate')), 'data.population:', 600),
  },
  {
    label: 'the vat-knowledge-resources skill',
    text: () => passage(readFileSync(KNOWLEDGE_SKILL, 'utf8'), 'publishes `data.population` too', 600),
  },
  {
    label: 'the population matrix',
    text: () => passage(readFileSync(POPULATION_MATRIX, 'utf8'), '| `vat resources validate` |', 1400),
  },
];

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
