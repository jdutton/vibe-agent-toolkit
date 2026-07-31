/**
 * Unit tests for declared-env — the agent-skills-specific assembly of the
 * declared test environment (Features A + B) for the experimenter spawn.
 *
 * Feature A (passEnv): forward named host env vars if present.
 * Feature B (env): inject explicit key→value pairs whose values support
 * stage-time `${token}` interpolation. An unknown token is a hard preflight error.
 *
 * Path comparisons are DERIVED via safePath (never hardcoded POSIX literals) so
 * the assertions hold on Windows where `path.resolve('/x')` becomes `D:/x`. The
 * opaque literal env VALUES (`/usr/bin`, `/staged/...`) are not resolved paths,
 * just strings, so they are written directly.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  assembleChildEnv,
  computeEnvTokens,
  interpolateEnvValue,
  resolveInjectEnv,
  UnknownEnvTokenError,
  UnresolvableEnvTokenError,
  type EnvInterpolationTokens,
} from '../../src/skill-test/declared-env.js';

/** Synthetic harness-root base used to DERIVE every compared path. */
const HARNESS_BASE = safePath.join('/tmp', 'vat-harness');

interface TokenInputs {
  subjectStagedDir: string;
  harnessRoot: string;
  resultsDir: string;
  evalsSubpath: string;
}

/** Module-scope helper: build a synthetic, derived set of token inputs + the computed tokens. */
function makeTokens(): { inputs: TokenInputs; tokens: EnvInterpolationTokens } {
  const base = HARNESS_BASE;
  const inputs: TokenInputs = {
    subjectStagedDir: safePath.join(base, 'staged', 'my-skill'),
    harnessRoot: base,
    resultsDir: safePath.join(base, 'results'),
    evalsSubpath: 'evals/evals.json',
  };
  return { inputs, tokens: computeEnvTokens({ ...inputs, workspaceDir: safePath.join(base, 'workspaces', 'e1') }) };
}

describe('computeEnvTokens', () => {
  it('passes the non-fixture tokens through unchanged', () => {
    const { inputs, tokens } = makeTokens();
    expect(tokens.stagedSkillDir).toBe(inputs.subjectStagedDir);
    expect(tokens.harnessRoot).toBe(inputs.harnessRoot);
    expect(tokens.resultsDir).toBe(inputs.resultsDir);
  });

  /**
   * Eval-suite isolation removes `<staged>/evals/` (the answer key AND the
   * `fixtures/` beneath it) from the staged subject, and each eval's declared
   * input `files` are staged into its own per-eval workspace instead. So
   * `${fixturesDir}` must name THAT workspace's `fixtures/`, which is also the
   * executor's working directory — pointing it back at the staged suite dir would
   * hand the executor a sibling path to `evals.json` and reopen the leak.
   */
  it('resolves fixturesDir under the per-eval workspace when one exists', () => {
    const workspaceDir = safePath.join(HARNESS_BASE, 'workspaces', 'my-eval');
    const { inputs } = makeTokens();
    const tokens = computeEnvTokens({ ...inputs, workspaceDir });
    expect(tokens.fixturesDir).toBe(safePath.join(workspaceDir, 'fixtures'));
  });

  /**
   * An eval that declares no input `files` gets no workspace, so there is no
   * fixtures directory anywhere. The token is unresolvable rather than pointing at
   * a path that does not exist — silence is the whole defect being fixed here.
   */
  it('leaves fixturesDir unresolved when the eval declares no input files', () => {
    const { inputs } = makeTokens();
    expect(computeEnvTokens(inputs).fixturesDir).toBeUndefined();
  });
});

describe('${fixturesDir} with no per-eval workspace', () => {
  it('fails loud instead of interpolating a path that does not exist', () => {
    const { inputs } = makeTokens();
    const tokens = computeEnvTokens(inputs);
    expect(() => interpolateEnvValue('${fixturesDir}/snap.json', 'SNAP', tokens)).toThrow(
      UnresolvableEnvTokenError,
    );
  });
});

describe('interpolateEnvValue', () => {
  it('interpolates a single token into the surrounding literal', () => {
    const { tokens } = makeTokens();
    const result = interpolateEnvValue('${fixturesDir}/snapshot.json', 'CUSTOMER_SNAPSHOT_PATH', tokens);
    expect(result).toBe(tokens.fixturesDir + '/snapshot.json');
  });

  it('resolves two tokens in one value', () => {
    const { tokens } = makeTokens();
    const result = interpolateEnvValue('${harnessRoot}::${resultsDir}', 'ACME_PAIR', tokens);
    expect(result).toBe(tokens.harnessRoot + '::' + tokens.resultsDir);
  });

  it('returns a value with no token unchanged', () => {
    const { tokens } = makeTokens();
    expect(interpolateEnvValue('plain-value', 'ACME_PLAIN', tokens)).toBe('plain-value');
  });

  it('throws UnknownEnvTokenError on an unknown token', () => {
    const { tokens } = makeTokens();
    let caught: unknown;
    try {
      interpolateEnvValue('${bogus}/x', 'VENDOR_KEY', tokens);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownEnvTokenError);
    const typed = caught as UnknownEnvTokenError;
    expect(typed.token).toBe('bogus');
    expect(typed.key).toBe('VENDOR_KEY');
    expect(typed.exitCode).toBe(2);
  });
});

describe('resolveInjectEnv', () => {
  it('returns undefined when given undefined', () => {
    const { tokens } = makeTokens();
    expect(resolveInjectEnv(undefined, tokens)).toBeUndefined();
  });

  it('interpolates each value in the map', () => {
    const { tokens } = makeTokens();
    const out = resolveInjectEnv({ CUSTOMER_SNAPSHOT_PATH: '${fixturesDir}/snap.json' }, tokens);
    expect(out).toEqual({ CUSTOMER_SNAPSHOT_PATH: tokens.fixturesDir + '/snap.json' });
  });
});

describe('assembleChildEnv', () => {
  it('unions pass-through and injected vars, redacting secrets in the line', () => {
    const result = assembleChildEnv({
      base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret' },
      source: { VENDOR_LICENSE_KEY: 'lic-xyz' },
      passEnv: ['VENDOR_LICENSE_KEY'],
      injectEnv: { CUSTOMER_SNAPSHOT_PATH: '/staged/evals/fixtures/snap.json' },
      subjectPluginRoot: null,
    });

    expect(result.env.VENDOR_LICENSE_KEY).toBe('lic-xyz');
    expect(result.env.CUSTOMER_SNAPSHOT_PATH).toBe('/staged/evals/fixtures/snap.json');
    expect(result.warnings).toEqual([]);

    expect(result.line).toContain('ANTHROPIC_API_KEY(redacted)');
    expect(result.line).toContain('CUSTOMER_SNAPSHOT_PATH=/staged/evals/fixtures/snap.json');
    expect(result.line).toContain('VENDOR_LICENSE_KEY(passed-through, redacted)');
    // Secret VALUES never appear in the transparency line.
    expect(result.line).not.toContain('sk-secret');
    expect(result.line).not.toContain('lic-xyz');
  });

  it('exports CLAUDE_PLUGIN_ROOT when the subject is plugin-distributed', () => {
    const pluginRoot = safePath.join(HARNESS_BASE, 'staged', 'acme-plugin');
    const result = assembleChildEnv({
      base: { PATH: '/usr/bin' },
      source: {},
      subjectPluginRoot: pluginRoot,
    });
    expect(result.env.CLAUDE_PLUGIN_ROOT).toBe(pluginRoot);
  });

  it('lets the protected base value win on a collision and warns', () => {
    const result = assembleChildEnv({
      base: { PATH: '/usr/bin' },
      source: {},
      injectEnv: { PATH: '/evil' },
      subjectPluginRoot: null,
    });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
