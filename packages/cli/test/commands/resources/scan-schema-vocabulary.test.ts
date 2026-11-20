/**
 * `vat resources scan`'s `extentSource` enum is the resources package's union,
 * not a hand-typed copy of it.
 *
 * The list is built from an exhaustive record over the union, so an enumerator
 * added or removed there fails to compile until the record matches, and this
 * schema follows it with no edit.
 */
import { CRAWL_SOURCE_KINDS } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { RESOURCES_SCAN_REPORT_SCHEMA } from '../../../src/commands/resources/scan-schema.js';

const DATA = RESOURCES_SCAN_REPORT_SCHEMA.innerType().options[0].shape.data.shape;

describe('vat resources scan vocabulary', () => {
  it('publishes exactly the crawl source kinds', () => {
    expect(DATA.extentSource.options).toEqual(CRAWL_SOURCE_KINDS);
  });
});
