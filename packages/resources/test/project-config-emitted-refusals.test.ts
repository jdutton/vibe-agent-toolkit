/**
 * The PUBLISHED `project-config.json` refuses what `loadConfig` refuses about `resources.checks`.
 *
 * Two of the config's refusals are Zod refinements — a check named like a built-in, and
 * `allowEmpty` without `examined` — and `zod-to-json-schema` drops every refinement. An editor or
 * CI step validating against the committed artifact then accepted a config `loadConfig` refused.
 * These cases validate the COMMITTED file with a real JSON Schema validator, so they fail the day
 * the generator stops emitting either constraint.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { createAjvWithUriFormats } from '../src/ajv-factory.js';
import { BUILTIN_CHECK_NAMES } from '../src/projection/builtin-check-names.js';
import { ProjectConfigSchema } from '../src/schemas/project-config.js';

const SCHEMA_FILE = safePath.join(import.meta.dirname, '..', 'schemas', 'project-config.json');
const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as object;
const validate = createAjvWithUriFormats(schema).compile(schema);

/** A config holding exactly these `resources.checks`. */
function withChecks(checks: Record<string, unknown>): Record<string, unknown> {
  return { resources: { checks } };
}

const CHECK = { description: 'd', sql: 'SELECT path FROM resource_realizations' };

/** The published schema's verdict and the runtime's, side by side. */
function verdicts(config: Record<string, unknown>): { published: boolean; runtime: boolean } {
  return { published: validate(config), runtime: ProjectConfigSchema.safeParse(config).success };
}

describe('the published project-config schema', () => {
  it('accepts an ordinary check, as loadConfig does (positive control)', () => {
    expect(verdicts(withChecks({ mine: CHECK }))).toStrictEqual({ published: true, runtime: true });
    expect(verdicts(withChecks({ mine: { ...CHECK, examined: 'SELECT 1', allowEmpty: true } })))
      .toStrictEqual({ published: true, runtime: true });
  });

  it.each(BUILTIN_CHECK_NAMES)('refuses a check named like the built-in %s, as loadConfig does', (name) => {
    expect(verdicts(withChecks({ [name]: CHECK }))).toStrictEqual({ published: false, runtime: false });
  });

  it('spells its cross-field rules through presenceImplies, never as an if/then conditional', () => {
    expect(readFileSync(SCHEMA_FILE, 'utf8')).not.toMatch(/"(if|then)":/);
  });

  it('refuses allowEmpty without examined, as loadConfig does', () => {
    expect(verdicts(withChecks({ mine: { ...CHECK, allowEmpty: true } }))).toStrictEqual({ published: false, runtime: false });
  });
});
