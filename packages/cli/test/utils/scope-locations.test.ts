import os from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scopeLocationsFor,
  VALID_SCOPES,
  validateAndGetScopeLocation,
} from '../../src/utils/scope-locations.js';

describe('scope-locations', () => {
  const AGENT_SKILL = 'agent-skill';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('scopeLocationsFor', () => {
    it('should define agent-skill user scope', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      expect(scopeLocationsFor(AGENT_SKILL)?.user).toBe(
        safePath.join(os.homedir(), '.claude', 'skills')
      );
    });

    it('should define agent-skill project scope', () => {
      expect(scopeLocationsFor(AGENT_SKILL)?.project).toBe(
        safePath.join(process.cwd(), '.claude', 'skills')
      );
    });

    it('has no locations for a runtime it does not know', () => {
      expect(scopeLocationsFor('unknown-runtime')).toBeUndefined();
    });
  });

  // Resolved at call time, not at module load: `--cwd` changes the working
  // directory after every module is loaded, and the user scope belongs to the
  // one Claude-user-paths resolver that every other verb reads.
  describe('resolution at call time', () => {
    const CONFIG_DIR = safePath.resolve('vat-scope-config-dir');
    const MOVED_CWD = safePath.resolve('vat-scope-moved-cwd');

    it('puts the user scope under CLAUDE_CONFIG_DIR', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', CONFIG_DIR);
      expect(validateAndGetScopeLocation(AGENT_SKILL, 'user')).toBe(safePath.join(CONFIG_DIR, 'skills'));
    });

    it('puts the project scope under the working directory of the call', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(MOVED_CWD);
      expect(validateAndGetScopeLocation(AGENT_SKILL, 'project')).toBe(safePath.join(MOVED_CWD, '.claude', 'skills'));
    });
  });

  describe('VALID_SCOPES', () => {
    it('should define valid scopes for agent-skill', () => {
      expect(VALID_SCOPES[AGENT_SKILL]).toEqual(['user', 'project']);
    });

    it('should have agent-skill runtime defined', () => {
      expect(VALID_SCOPES[AGENT_SKILL]).toBeDefined();
      expect(Array.isArray(VALID_SCOPES[AGENT_SKILL])).toBe(true);
    });
  });

  describe('validateAndGetScopeLocation', () => {
    it('should return user scope location for agent-skill', () => {
      vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      const location = validateAndGetScopeLocation(AGENT_SKILL, 'user');
      expect(location).toBe(safePath.join(os.homedir(), '.claude', 'skills'));
    });

    it('should return project scope location for agent-skill', () => {
      const location = validateAndGetScopeLocation(AGENT_SKILL, 'project');
      expect(location).toBe(safePath.join(process.cwd(), '.claude', 'skills'));
    });

    it('should throw error for invalid scope', () => {
      expect(() => validateAndGetScopeLocation(AGENT_SKILL, 'invalid')).toThrow(
        "Invalid scope 'invalid' for runtime 'agent-skill'"
      );
    });

    // Coded at the cause: the command publishes the refusal the error carries.
    it('refuses an unknown scope or runtime as USAGE_INVALID', () => {
      expect(() => validateAndGetScopeLocation(AGENT_SKILL, 'invalid')).toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID' }));
      expect(() => validateAndGetScopeLocation('unknown', 'user')).toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID' }));
    });

    it('should throw error with available scopes in message', () => {
      expect(() => validateAndGetScopeLocation(AGENT_SKILL, 'global')).toThrow(
        'Valid scopes: user, project'
      );
    });

    it('should throw error for unknown runtime', () => {
      expect(() => validateAndGetScopeLocation('unknown-runtime', 'user')).toThrow(
        "Invalid scope 'user' for runtime 'unknown-runtime'"
      );
    });

    it('should throw error for unknown runtime with no valid scopes', () => {
      expect(() => validateAndGetScopeLocation('unknown', 'any')).toThrow(
        'Valid scopes: none'
      );
    });

    it('should throw error when scope location not implemented', () => {
      // A runtime can declare a scope as valid without a location being wired up
      // for it. That fallback must throw rather than return undefined, so
      // register such a runtime for the duration of this test.
      const unwiredRuntime = 'unwired-runtime';
      VALID_SCOPES[unwiredRuntime] = ['user'];

      try {
        expect(scopeLocationsFor(unwiredRuntime)).toBeUndefined();
        expect(() => validateAndGetScopeLocation(unwiredRuntime, 'user')).toThrow(
          "Scope 'user' not implemented for runtime 'unwired-runtime'"
        );
        expect(() => validateAndGetScopeLocation(unwiredRuntime, 'user')).toThrow(expect.objectContaining({ refusal: 'NOT_IMPLEMENTED' }));
      } finally {
        delete VALID_SCOPES[unwiredRuntime];
      }
    });

    // `--runtime constructor` once read Object.prototype: INTERNAL_ERROR on install, a defect exit on installed.
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('refuses the inherited key %s as a runtime, USAGE_INVALID', (key) => {
      expect(() => validateAndGetScopeLocation(key, 'user')).toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID' }));
      expect(scopeLocationsFor(key)).toBeUndefined();
      expect(() => validateAndGetScopeLocation(AGENT_SKILL, key)).toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID' }));
    });

    it('should handle case-sensitive scope names', () => {
      // Scopes are case-sensitive
      expect(() => validateAndGetScopeLocation(AGENT_SKILL, 'User')).toThrow(
        "Invalid scope 'User'"
      );
    });

    it('should handle case-sensitive runtime names', () => {
      // Runtimes are case-sensitive
      expect(() => validateAndGetScopeLocation('Agent-Skill', 'user')).toThrow(
        "Invalid scope 'user' for runtime 'Agent-Skill'"
      );
    });
  });
});
