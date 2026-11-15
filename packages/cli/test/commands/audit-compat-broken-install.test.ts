/**
 * A broken INSTALL fails `vat audit --compat`; it is never a plugin "that could
 * not be analyzed".
 *
 * Both compat lanes are best-effort per plugin: a plugin the analyzer or the
 * settings checker could not run on is said on stderr and filed as not
 * checked, and the audit goes on. Their catches used to take EVERYTHING —
 * a `ParserUnavailableError` included — so a run whose parser could not load
 * reported each plugin as unanalyzable and still finished. Both catches now
 * classify through `classifyCompatibilityFailure`, an allowlist, and every VAT
 * defect is rethrown.
 *
 * The seam is the claude-marketplace barrel: the two lane entry points are
 * armed to reject; the classifier and the audit's own catches are shipped code.
 */

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import type * as MarketplaceModule from '@vibe-agent-toolkit/claude-marketplace';
import { ParserUnavailableError } from '@vibe-agent-toolkit/resources';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCompatAnalysis } from '../../src/commands/audit.js';
import { silentLogger } from '../test-doubles.js';

/** What each armed lane rejects with, or nothing. */
const armed = vi.hoisted(() => ({ analyze: undefined as unknown, settings: undefined as unknown }));

vi.mock('@vibe-agent-toolkit/claude-marketplace', async (importOriginal) => {
  const actual = await importOriginal<typeof MarketplaceModule>();
  const analyzeCompatibility: typeof actual.analyzeCompatibility = async (...args) => {
    if (armed.analyze !== undefined) throw armed.analyze;
    return actual.analyzeCompatibility(...args);
  };
  const checkSettingsCompatibility: typeof actual.checkSettingsCompatibility = async (...args) => {
    if (armed.settings !== undefined) throw armed.settings;
    return actual.checkSettingsCompatibility(...args);
  };
  return { ...actual, analyzeCompatibility, checkSettingsCompatibility };
});

const PLUGIN_DIR = '/vat-audit-broken-install/plugin';

const PLUGIN_RESULT: ValidationResult = {
  path: PLUGIN_DIR,
  type: 'claude-plugin',
  status: 'ok',
  description: '0 errors, 0 warnings, 0 info',
  issues: [],
  summary: { errors: 0, warnings: 0, info: 0 },
};

const NO_POLICY: MarketplaceModule.EffectiveSettings = { permissions: { allow: [], ask: [], deny: [] } };

/** The failure a missing parse worker produces, from the real exported class. */
function brokenInstall(): ParserUnavailableError {
  return new ParserUnavailableError('markdown', 'parse-worker.js', Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }));
}

/** A read the OS refused, as `node:fs` raises it: the plugin's, not VAT's. */
function refusedRead(): Error {
  return Object.assign(new Error(`EACCES: permission denied, scandir '${PLUGIN_DIR}'`), { code: 'EACCES', syscall: 'scandir', path: PLUGIN_DIR });
}

const run = (settings?: MarketplaceModule.EffectiveSettings) => runCompatAnalysis([PLUGIN_RESULT], silentLogger, PLUGIN_DIR, settings);

afterEach(() => {
  armed.analyze = undefined;
  armed.settings = undefined;
});

describe('a broken parser install in the compat lanes of vat audit', () => {
  it('fails the audit when the compatibility analyzer meets it', async () => {
    const thrown = brokenInstall();
    armed.analyze = thrown;

    await expect(run()).rejects.toBe(thrown);
  });

  it('fails the audit when the settings checker meets it', async () => {
    const thrown = brokenInstall();
    armed.analyze = refusedRead();
    armed.settings = thrown;

    await expect(run(NO_POLICY)).rejects.toBe(thrown);
  });
});

/** The controls the rejections are read against: what is the plugin's still degrades. */
describe('a failure that is the plugin\'s, in the compat lanes of vat audit', () => {
  it('files a plugin whose root the OS refused as not analyzed, and as unchecked by the settings lane', async () => {
    armed.analyze = refusedRead();
    armed.settings = refusedRead();

    const entry = (await run(NO_POLICY)).get(PLUGIN_DIR);

    expect(entry?.compat).toMatchObject({ analyzed: false });
    expect(entry?.settings?.unchecked).toEqual([expect.objectContaining({ path: PLUGIN_DIR })]);
  });

  it('files a plugin whose manifest will not parse as not analyzed', async () => {
    armed.analyze = new SyntaxError('Unexpected token } in JSON');

    const entry = (await run()).get(PLUGIN_DIR);

    expect(entry?.compat).toMatchObject({ analyzed: false });
  });
});
