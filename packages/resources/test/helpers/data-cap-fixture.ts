/**
 * The committed JSON Schema documents the data-job output caps were derived from
 * (`test/fixtures/data-output-caps/`, gzipped), as `docs/architecture/fact-extractors-limits.md`
 * records them.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { safePath } from '@vibe-agent-toolkit/utils';

const FIXTURES = safePath.join(__dirname, '..', 'fixtures', 'data-output-caps');

/**
 * @param name - The fixture's name, without its extension
 * @returns The fixture document's text
 */
export function dataCapFixture(name: 'contract-large' | 'contract-medium'): string {
  return gunzipSync(readFileSync(safePath.join(FIXTURES, `${name}.schema.json.gz`))).toString('utf8');
}
