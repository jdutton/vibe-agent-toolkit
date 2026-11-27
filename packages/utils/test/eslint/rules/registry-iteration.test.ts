/**
 * `registry-iteration` — the relation registries are iterated only through their accessors. The
 * VALID cases pin what is not iteration (named access, an index, an unrelated object, a shadowing
 * local) and the allowlisted registry module; the INVALID ones pin every way of enumerating a
 * registry, under its own name, a renamed import, a namespace import or a local alias.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'registry-iteration';
const SRC = '/repo/packages/cli/src/report-schemas.ts';
const TEST = '/repo/packages/cli/test/helpers/cache-differential.ts';
const REGISTRY = '/repo/packages/resources/src/projection/derived-table-registry.ts';
const ALLOW = [{ allowFiles: ['packages/resources/src/projection/derived-table-registry.ts'] }];
const IMPORT = "import { PROJECTION_TABLES, ROW_SET_TABLES, DERIVED_TABLES } from '@vibe-agent-toolkit/resources';";
const error = (name: string): Array<{ messageId: string; data: { name: string } }> => [{ messageId: 'iteration', data: { name } }];

const CASES: RuleCases = {
  valid: [
    // Named access is not iteration.
    { code: `${IMPORT} export const name = PROJECTION_TABLES.blobs.name;`, filename: SRC },
    { code: `${IMPORT} export const spec = PROJECTION_TABLES[key];`, filename: SRC },
    { code: `${IMPORT} export const spec = ROW_SET_TABLES['dataFiles'];`, filename: TEST },
    { code: `${IMPORT} export const has = 'blobs' in PROJECTION_TABLES;`, filename: SRC },
    // Through an accessor.
    { code: "import { storedRelationSpecs } from '@vibe-agent-toolkit/resources'; export const specs = storedRelationSpecs();", filename: SRC },
    // Another object.
    { code: 'export const keys = Object.keys(OTHER_TABLES);', filename: SRC },
    { code: "import { OTHER as PROJECTION } from './x.js'; export const keys = Object.values(PROJECTION);", filename: SRC },
    { code: 'for (const key in other) { use(key); }', filename: SRC },
    // A renamed import of something else, under a registry's name.
    { code: "import { OTHER as PROJECTION_TABLES } from './x.js'; export const keys = Object.values(PROJECTION_TABLES);", filename: SRC },
    // A local parameter that shadows the name is not the registry.
    { code: 'export function f(PROJECTION_TABLES) { return Object.values(PROJECTION_TABLES); }', filename: SRC },
    // Not `Object`.
    { code: `${IMPORT} export const keys = Thing.values(PROJECTION_TABLES);`, filename: SRC },
    // The registry module itself, allowlisted.
    { code: 'const DERIVED_TABLES = {}; export function all() { return Object.values(DERIVED_TABLES); }', filename: REGISTRY, options: ALLOW },
  ],
  invalid: [
    { code: `${IMPORT} export const specs = Object.values(PROJECTION_TABLES);`, filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: `${IMPORT} export const keys = Object.keys(ROW_SET_TABLES);`, filename: TEST, errors: error('ROW_SET_TABLES') },
    { code: `${IMPORT} export const pairs = Object.entries(DERIVED_TABLES);`, filename: SRC, errors: error('DERIVED_TABLES') },
    { code: `${IMPORT} export const copy = Object.fromEntries(Object.entries(PROJECTION_TABLES));`, filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: `${IMPORT} export const names = Object.getOwnPropertyNames(PROJECTION_TABLES);`, filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: `${IMPORT} export const names = Reflect.ownKeys(DERIVED_TABLES);`, filename: SRC, errors: error('DERIVED_TABLES') },
    { code: `${IMPORT} export const specs = Object['values'](PROJECTION_TABLES);`, filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: `${IMPORT} for (const key in PROJECTION_TABLES) { use(key); }`, filename: TEST, errors: error('PROJECTION_TABLES') },
    // Under a renamed import, a namespace import, a local alias, and a cast.
    { code: "import { PROJECTION_TABLES as TABLES } from '@vibe-agent-toolkit/resources'; export const specs = Object.values(TABLES);", filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: "import * as resources from '@vibe-agent-toolkit/resources'; export const specs = Object.values(resources.ROW_SET_TABLES);", filename: SRC, errors: error('ROW_SET_TABLES') },
    { code: `${IMPORT} const TABLES = PROJECTION_TABLES; export const specs = Object.values(TABLES);`, filename: SRC, errors: error('PROJECTION_TABLES') },
    { code: `${IMPORT} export const specs = Object.values(PROJECTION_TABLES as Record<string, unknown>);`, filename: SRC, errors: error('PROJECTION_TABLES') },
    // Declared in the file itself, outside the allowlist.
    { code: 'const DERIVED_TABLES = {}; export const all = Object.values(DERIVED_TABLES);', filename: SRC, errors: error('DERIVED_TABLES') },
    // An allowlist naming another file does not cover this one.
    { code: `${IMPORT} export const specs = Object.values(PROJECTION_TABLES);`, filename: SRC, options: ALLOW, errors: error('PROJECTION_TABLES') },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
