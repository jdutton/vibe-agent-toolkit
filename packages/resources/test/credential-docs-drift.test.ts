/**
 * The credentials kinds and the `.yarnrc.yml` kept keys are stated in several docs. The code is the
 * one source (`data-credential-files.ts`, `data-yarnrc.ts`); a doc that names them must carry the
 * code's own text, so a kind or key added in code cannot be missing from a doc.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REFUSED_CREDENTIAL_KINDS_PROSE } from '../src/projection/data-credential-files.js';
import { YARNRC_KEPT_KEYS_PROSE } from '../src/projection/data-yarnrc.js';

/** A repo file's text, by path from the repository root. */
function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8').replaceAll('\n', ' ').replaceAll(/ {2,}/g, ' ');
}

const SKILLS = 'packages/vat-development-agents/resources/skills/vat-adoption-and-configuration.md';
const GOLDEN = 'packages/vat-development-agents/test/golden/vat-development-agents/skills/vat-adoption-and-configuration/SKILL.md';

/** Each doc that lists the refused kinds. */
const KIND_DOCS = ['docs/validation-codes.md', 'packages/cli/docs/resources.md', SKILLS, GOLDEN];
/** Each doc that lists the kept `.yarnrc.yml` keys. */
const KEY_DOCS = KIND_DOCS;

describe('the credentials docs are held to the code', () => {
  it.each(KIND_DOCS)('%s lists exactly the refused kinds the code refuses', (doc) => {
    expect(repoFile(doc)).toContain(REFUSED_CREDENTIAL_KINDS_PROSE);
  });

  it.each(KEY_DOCS)('%s lists exactly the yarnrc keys the code keeps', (doc) => {
    expect(repoFile(doc)).toContain(YARNRC_KEPT_KEYS_PROSE);
  });
});
