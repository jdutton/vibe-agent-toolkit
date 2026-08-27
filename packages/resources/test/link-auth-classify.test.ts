import { describe, expect, it } from 'vitest';

import type { ProviderCheck } from '../src/link-auth/resolve.js';
import { classifyAuthenticatedResponse } from '../src/link-auth-classify.js';

const DEAD: ProviderCheck = {
  method: 'GET',
  aliveStatus: [200],
  notFoundMeaning: 'dead',
};

const AMBIGUOUS: ProviderCheck = {
  method: 'GET',
  aliveStatus: [200],
  notFoundMeaning: 'ambiguous',
};

describe('classifyAuthenticatedResponse — alive', () => {
  it('classifies a status listed in aliveStatus as alive (no code)', () => {
    expect(classifyAuthenticatedResponse(200, DEAD)).toEqual({ outcome: 'alive', code: null });
    expect(classifyAuthenticatedResponse(200, AMBIGUOUS)).toEqual({ outcome: 'alive', code: null });
  });

  it('honors a multi-value aliveStatus', () => {
    const check: ProviderCheck = { method: 'GET', aliveStatus: [200, 206], notFoundMeaning: 'dead' };
    expect(classifyAuthenticatedResponse(206, check)).toEqual({ outcome: 'alive', code: null });
  });

  it('an aliveStatus entry wins even when it would otherwise be 404 → dead', () => {
    // A provider could (in principle) declare 404 as alive — confirm the
    // aliveStatus check fires first, so the routing is purely config-driven.
    const check: ProviderCheck = { method: 'GET', aliveStatus: [404], notFoundMeaning: 'dead' };
    expect(classifyAuthenticatedResponse(404, check)).toEqual({ outcome: 'alive', code: null });
  });
});

describe('classifyAuthenticatedResponse — 401 / 403 are status-only, ignore notFoundMeaning', () => {
  it('401 → unauthorized + LINK_AUTH_UNAUTHORIZED', () => {
    expect(classifyAuthenticatedResponse(401, DEAD)).toEqual({
      outcome: 'unauthorized',
      code: 'LINK_AUTH_UNAUTHORIZED',
    });
    expect(classifyAuthenticatedResponse(401, AMBIGUOUS)).toEqual({
      outcome: 'unauthorized',
      code: 'LINK_AUTH_UNAUTHORIZED',
    });
  });

  it('403 → forbidden + LINK_AUTH_FORBIDDEN', () => {
    expect(classifyAuthenticatedResponse(403, DEAD)).toEqual({
      outcome: 'forbidden',
      code: 'LINK_AUTH_FORBIDDEN',
    });
    expect(classifyAuthenticatedResponse(403, AMBIGUOUS)).toEqual({
      outcome: 'forbidden',
      code: 'LINK_AUTH_FORBIDDEN',
    });
  });
});

describe('classifyAuthenticatedResponse — 404 / 410 split by notFoundMeaning', () => {
  it('404 + notFoundMeaning=dead → dead + LINK_AUTH_DEAD', () => {
    expect(classifyAuthenticatedResponse(404, DEAD)).toEqual({
      outcome: 'dead',
      code: 'LINK_AUTH_DEAD',
    });
  });

  it('410 + notFoundMeaning=dead → dead + LINK_AUTH_DEAD', () => {
    expect(classifyAuthenticatedResponse(410, DEAD)).toEqual({
      outcome: 'dead',
      code: 'LINK_AUTH_DEAD',
    });
  });

  it('404 + notFoundMeaning=ambiguous → dead_or_unauthorized + LINK_AUTH_DEAD_OR_UNAUTHORIZED', () => {
    expect(classifyAuthenticatedResponse(404, AMBIGUOUS)).toEqual({
      outcome: 'dead_or_unauthorized',
      code: 'LINK_AUTH_DEAD_OR_UNAUTHORIZED',
    });
  });

  it('410 + notFoundMeaning=ambiguous → dead_or_unauthorized + LINK_AUTH_DEAD_OR_UNAUTHORIZED', () => {
    expect(classifyAuthenticatedResponse(410, AMBIGUOUS)).toEqual({
      outcome: 'dead_or_unauthorized',
      code: 'LINK_AUTH_DEAD_OR_UNAUTHORIZED',
    });
  });
});

describe('classifyAuthenticatedResponse — unclassified status falls through', () => {
  it('500 → null (caller falls through to the anonymous EXTERNAL_URL_DEAD path)', () => {
    expect(classifyAuthenticatedResponse(500, DEAD)).toBeNull();
    expect(classifyAuthenticatedResponse(500, AMBIGUOUS)).toBeNull();
  });

  it('301 / 302 → null (redirects are caller concern, not a classified outcome)', () => {
    expect(classifyAuthenticatedResponse(301, DEAD)).toBeNull();
    expect(classifyAuthenticatedResponse(302, DEAD)).toBeNull();
  });

  it('429 → null (rate-limit handling is caller concern per §5.2 Retry-After)', () => {
    expect(classifyAuthenticatedResponse(429, DEAD)).toBeNull();
  });
});

describe('classifyAuthenticatedResponse — returned code is a real CODE_REGISTRY entry', () => {
  it('every non-null returned code matches a literal LINK_AUTH_* registry key', async () => {
    // External-constant cross-check: assert the classifier's outputs match the
    // exact registry keys, not via the classifier itself.
    const { CODE_REGISTRY } = await import('@vibe-agent-toolkit/schema');
    const codes = [
      classifyAuthenticatedResponse(401, DEAD).code,
      classifyAuthenticatedResponse(403, DEAD).code,
      classifyAuthenticatedResponse(404, DEAD).code,
      classifyAuthenticatedResponse(404, AMBIGUOUS).code,
    ];
    for (const code of codes) {
      expect(code).not.toBeNull();
      expect(Object.hasOwn(CODE_REGISTRY, code as string)).toBe(true);
    }
  });
});
