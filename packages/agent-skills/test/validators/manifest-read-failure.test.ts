/**
 * `manifestReadFailure` is the ONE decision every JSON manifest validator makes about a
 * failed manifest read — the marketplace, the registry and (in claude-marketplace) the
 * plugin validator all call it, so they cannot drift. It asks the classifier: an `absent`
 * fault is the validator's own "missing" finding; any other filesystem fault is
 * `SCAN_PATH_UNREADABLE` naming the errno and never the absolute path; a defect propagates.
 */
import { describe, expect, it } from 'vitest';

import { manifestReadFailure } from '../../src/validators/marketplace-validator.js';

const LOCATION = '.claude-plugin/plugin.json';
const MISSING = { code: 'PLUGIN_MISSING_MANIFEST', message: 'Plugin manifest not found', fix: 'Create it' } as const;

/** A raw errno as `readFileSync` raises it, its message carrying the absolute path. */
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: refused, open '/abs/secret/plugin.json'`), { code, path: '/abs/secret/plugin.json' });
}

describe('manifestReadFailure', () => {
  it.each(['ENOENT', 'ENOTDIR'])('reports %s as the validator\'s own missing finding', (code) => {
    expect(manifestReadFailure(errno(code), LOCATION, MISSING)).toMatchObject({ code: 'PLUGIN_MISSING_MANIFEST', location: LOCATION });
  });

  it.each(['EACCES', 'EISDIR', 'ENAMETOOLONG', 'EIO'])('reports %s as SCAN_PATH_UNREADABLE naming the errno, never the absolute path', (code) => {
    const issue = manifestReadFailure(errno(code), LOCATION, MISSING);

    expect(issue).toMatchObject({ code: 'SCAN_PATH_UNREADABLE', location: LOCATION });
    expect(issue.message).toContain(code);
    expect(issue.message).not.toContain('/abs/secret');
  });

  it.each(['EMFILE', 'ENOSPC', 'EBUSY'])('throws %s classified: the machine ran out, which is the run\'s refusal, never a finding', (code) => {
    expect(() => manifestReadFailure(errno(code), LOCATION, MISSING)).toThrow(expect.objectContaining({ code: 'FS_FAULT', errno: code }));
  });

  it('rethrows a defect untouched: only a filesystem fault is a finding', () => {
    const defect = new TypeError('x is undefined');

    expect(() => manifestReadFailure(defect, LOCATION, MISSING)).toThrow(defect);
  });
});
