/**
 * `resolveOsUser` recovers from `os.userInfo()` throwing — but only from the
 * one failure it documents: a `SystemError` (`ERR_SYSTEM_ERROR`) for a user
 * with no passwd entry, common in containers. The `no-blind-catch` split:
 * anything else is a bug, and a bug absorbed here silently re-scopes the
 * auth cache to whatever `USER` says, or to `default`.
 *
 * Its own file because the `node:os` mock is module-wide.
 */

import { mkdtempSync } from 'node:fs';
import type * as NodeOs from 'node:os';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalLinkValidator } from '../src/external-link-validator.js';

type UserInfoBehaviour = 'real' | { readonly throws: unknown };

const userInfoStub = vi.hoisted(() => ({ behaviour: 'real' as UserInfoBehaviour }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  const userInfo: typeof actual.userInfo = (...args) => {
    if (userInfoStub.behaviour !== 'real') throw userInfoStub.behaviour.throws;
    return actual.userInfo(...args);
  };
  return { ...actual, userInfo };
});

/** The shape Node throws from `os.userInfo()` for a user with no passwd entry. */
function noPasswdEntry(): Error {
  return Object.assign(new Error('A system error occurred: uv_os_get_passwd returned ENOENT'), {
    code: 'ERR_SYSTEM_ERROR',
    info: { code: 'ENOENT', syscall: 'uv_os_get_passwd' },
  });
}

function construct(): ExternalLinkValidator {
  const cacheDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-os-user-'));
  return new ExternalLinkValidator(cacheDir, {});
}

describe('resolveOsUser (via the ExternalLinkValidator constructor)', () => {
  afterEach(() => {
    userInfoStub.behaviour = 'real';
    vi.unstubAllEnvs();
  });

  it('recovers from a missing passwd entry through the USER env var (positive control)', () => {
    userInfoStub.behaviour = { throws: noPasswdEntry() };
    vi.stubEnv('USER', 'container-user');

    expect(() => construct()).not.toThrow();
  });

  it('propagates a userInfo() failure that is not the documented SystemError', () => {
    const bug = new TypeError('simulated defect inside userInfo');
    userInfoStub.behaviour = { throws: bug };

    expect(() => construct()).toThrow(bug);
  });
});
