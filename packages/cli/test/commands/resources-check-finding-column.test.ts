/**
 * `column` has ONE home — `ValidationIssueSchema` — and the published finding inherits it.
 *
 * The enforcer is the GENERATED artifact an adopter validates against, not the Zod source: a
 * second declaration (a `.extend({ column })` re-added beside the inherited one) is what this file
 * counts, so the count is read where the two would meet.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

const SCHEMA_FILE = safePath.join(resolveFromImportMeta(import.meta.url, '..', '..'), 'schemas', 'resources-check.json');

describe('resources-check.json', () => {
  it('declares the finding `column` exactly once', () => {
    const text = readFileSync(SCHEMA_FILE, 'utf-8');

    expect(text.match(/"column":/g) ?? []).toHaveLength(1);
  });
});
