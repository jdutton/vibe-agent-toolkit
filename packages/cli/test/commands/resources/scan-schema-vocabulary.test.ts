/**
 * `vat resources scan`'s `lane` and `extentSource` enums are the resources
 * package's unions, not a hand-typed copy of them.
 *
 * Both lists are built from exhaustive records over the unions, so a lane or
 * enumerator added or removed there fails to compile until the record matches,
 * and this schema follows it with no edit.
 */
import { CRAWL_LANES, CRAWL_SOURCE_KINDS } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { RESOURCES_SCAN_REPORT_SCHEMA } from '../../../src/commands/resources/scan-schema.js';

const DATA = RESOURCES_SCAN_REPORT_SCHEMA.innerType().options[0].shape.data.shape;

describe('vat resources scan vocabulary', () => {
  it('publishes exactly the crawl lanes', () => {
    expect(DATA.lane.options).toEqual(CRAWL_LANES);
  });

  it('publishes exactly the crawl source kinds', () => {
    expect(DATA.extentSource.unwrap().options).toEqual(CRAWL_SOURCE_KINDS);
  });
});
