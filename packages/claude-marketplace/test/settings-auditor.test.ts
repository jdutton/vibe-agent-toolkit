/**
 * Unit tests for the settings auditor's answer shapes.
 *
 * Every assertion here is about one thing: a lane must not spell "I could not
 * tell" with the same bytes it uses for "I looked and it is fine".
 */

import * as fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir , refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getSettingsFileFields,
  getSettingsPaths,
  probePathAccess,
  resolveSettingsPaths,
  validateSettingsFile,
} from '../src/settings/settings-auditor.js';


const NUL = String.fromCodePoint(0);
const A_MODEL = 'claude-sonnet-4-5';

describe('settings auditor answer shapes', () => {
  let dir: string;
  let validUserFile: string;
  let managedFile: string;
  let invalidFile: string;
  let emptyObjectFile: string;
  let missingFile: string;
  let notJsonFile: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-settings-auditor-'));
    validUserFile = safePath.join(dir, 'settings.json');
    managedFile = safePath.join(dir, 'managed-settings.json');
    invalidFile = safePath.join(dir, 'invalid.json');
    emptyObjectFile = safePath.join(dir, 'empty.json');
    missingFile = safePath.join(dir, 'nope.json');
    notJsonFile = safePath.join(dir, 'not-json.json');

    await fs.writeFile(
      validUserFile,
      JSON.stringify({ model: A_MODEL, permissions: { allow: ['Bash(ls)'] } }),
    );
    await fs.writeFile(
      managedFile,
      JSON.stringify({ availableModels: [A_MODEL], model: A_MODEL }),
    );
    await fs.writeFile(invalidFile, JSON.stringify({ model: 42 }));
    await fs.writeFile(emptyObjectFile, JSON.stringify({}));
    await fs.writeFile(notJsonFile, '{ "model": ');
  });

  afterAll(async () => {
    await removeScratchDir(dir);
  });

  describe('validateSettingsFile', () => {
    it('publishes per-severity counts beside the status', async () => {
      const result = await validateSettingsFile(validUserFile);

      // The ambiguity note is an info finding, so a valid file is `findings`.
      expect(result.status).toBe('findings');
      expect(result.summary).toEqual({
        errors: 0,
        warnings: 0,
        info: result.summary.info,
      });
      expect(result.summary.errors).toBe(0);
    });

    it('reports schema violations as error-severity findings, and counts them', async () => {
      const result = await validateSettingsFile(invalidFile);

      expect(result.summary.errors).toBeGreaterThan(0);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.summary.errors).toBe(
        result.findings.filter(f => f.severity === 'error').length,
      );
      for (const finding of result.findings) {
        expect(['error', 'warning', 'info']).toContain(finding.severity);
      }
    });

    it('publishes a registered code and the key path as field, and status findings for an error', async () => {
      const result = await validateSettingsFile(invalidFile);

      expect(result.status).toBe('findings');
      expect(result.summary.errors).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('issueCounts');
      const modelFinding = result.findings.find(f => f.severity === 'error');
      // `location` is the FILE to open — the caller's; the key path inside it is `field`.
      expect(modelFinding).toMatchObject({ code: 'SETTINGS_FILE_INVALID', field: 'model' });
      expect(modelFinding).not.toHaveProperty('location');
      expect(modelFinding).not.toHaveProperty('path');
    });

    // A settings file that is JSON and not an object violates the schema at its ROOT:
    // there is no key path, so the finding carries no `field` — never an empty one.
    it('omits field for a violation about the document as a whole', async () => {
      const arrayFile = safePath.join(dir, 'array.json');
      await fs.writeFile(arrayFile, JSON.stringify([1, 2]));

      const result = await validateSettingsFile(arrayFile);

      const invalid = result.findings.filter((f) => f.code === 'SETTINGS_FILE_INVALID');
      expect(invalid.length).toBeGreaterThan(0);
      for (const finding of invalid) expect(finding).not.toHaveProperty('field');
    });

    it('says the type was AMBIGUOUS rather than silently answering "user"', async () => {
      // user and project settings share one schema, so a file without
      // managed-only fields could be either. Reporting `user` as though it were
      // determined is a guess wearing an answer's clothes.
      const result = await validateSettingsFile(validUserFile);

      expect(result.typeConfidence).toBe('ambiguous');
      expect(result.summary.info).toBe(1);
      expect(result.findings).toContainEqual(expect.objectContaining({ code: 'SETTINGS_TYPE_AMBIGUOUS', severity: 'info' }));
    });

    it('reports a caller-declared type as declared, with no ambiguity note', async () => {
      const result = await validateSettingsFile(validUserFile, 'project');

      expect(result.detectedType).toBe('project');
      expect(result.typeConfidence).toBe('declared');
      expect(result.summary.info).toBe(0);
    });

    it('reports an inferred managed type as inferred', async () => {
      const result = await validateSettingsFile(managedFile);

      expect(result.detectedType).toBe('managed');
      expect(result.typeConfidence).toBe('inferred');
      expect(result.summary.info).toBe(0);
    });

    it('reports content that is not JSON as an undetermined type, not as a user file', async () => {
      const result = await validateSettingsFile(notJsonFile);

      expect(result.findings.map((f) => f.code)).toEqual(['SETTINGS_FILE_INVALID']);
      expect(result.detectedType).toBe('unknown');
      expect(result.typeConfidence).toBe('undetermined');
    });

    it('throws for a file that is not there — nothing was read, so it is not a finding about the file', async () => {
      await expect(validateSettingsFile(missingFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('getSettingsFileFields', () => {
    it('returns null when the file is not there — NOT an empty field list', async () => {
      await expect(getSettingsFileFields(missingFile)).resolves.toBeNull();
    });

    it('returns null when the file is not JSON', async () => {
      await expect(getSettingsFileFields(notJsonFile)).resolves.toBeNull();
    });

    /**
     * `null` stands for "there is nothing here to list" — absent, or not JSON.
     * A file that IS there and the OS refuses is neither, and reading it as
     * `null` reports a permission bit as an empty settings file.
     */
    it('propagates a file the OS refuses to read rather than reporting it as null', async () => {
      const restore = refuseAsyncFs('readFile', validUserFile, 'EACCES');
      try {
        await expect(getSettingsFileFields(validUserFile)).rejects.toThrow(/EACCES/);
      } finally {
        restore();
      }
    });

    /**
     * The distinguishing fixture: a settings file that parses fine and genuinely
     * declares no fields. Without it, `[]` for "unreadable" and `[]` for "no
     * fields" are the same bytes and no test can tell them apart.
     */
    it('returns [] when the file parses and genuinely has no fields', async () => {
      await expect(getSettingsFileFields(emptyObjectFile)).resolves.toEqual([]);
    });

    it('lists the fields of a real settings file', async () => {
      const fields = await getSettingsFileFields(validUserFile);

      expect(fields).not.toBeNull();
      expect(fields?.map(f => f.key).sort()).toEqual(['model', 'permissions.allow']);
    });
  });

  describe('getSettingsPaths', () => {
    it('returns candidates that make no claim about existence', async () => {
      const { paths } = getSettingsPaths(dir);

      expect(paths.length).toBeGreaterThan(0);
      for (const candidate of paths) {
        // A synchronous enumeration cannot know. It must not publish a
        // placeholder `exists: false`, which reads as a determination.
        expect(candidate).not.toHaveProperty('exists');
        expect(candidate).not.toHaveProperty('readable');
        expect(typeof candidate.path).toBe('string');
        expect(typeof candidate.level).toBe('string');
      }
    });
  });

  describe('resolveSettingsPaths', () => {
    it('resolves every candidate to a determined access answer', async () => {
      const { paths } = await resolveSettingsPaths(dir);

      expect(paths.length).toBeGreaterThan(0);
      for (const entry of paths) {
        expect(['boolean', 'string']).toContain(typeof entry.exists);
        expect(['boolean', 'string']).toContain(typeof entry.readable);
      }
    });

    it('finds a project settings file that is actually there', async () => {
      const projectDir = safePath.join(dir, 'proj');
      await fs.mkdir(safePath.join(projectDir, '.claude'), { recursive: true });
      await fs.writeFile(safePath.join(projectDir, '.claude/settings.json'), '{}');

      const { paths } = await resolveSettingsPaths(projectDir);
      // Select by `level`, never by path suffix: the USER candidate is also
      // `<something>/.claude/settings.json` and comes first in the list, so a
      // suffix match silently answers about the developer's own home settings
      // instead of the project file this test just wrote. That made the test
      // pass or fail on ambient environment (`CLAUDE_CONFIG_DIR`, whether
      // `~/.claude/settings.json` exists) rather than on the code — and on
      // Windows the backslash path matches no forward-slash suffix at all.
      const projectEntry = paths.find(p => p.level === 'project');

      expect(projectEntry?.exists).toBe(true);
      expect(projectEntry?.readable).toBe(true);
      expect(projectEntry?.accessError).toBeUndefined();
    });
  });

  describe('probePathAccess', () => {
    it('answers false for a path that is genuinely absent', async () => {
      const access = await probePathAccess(missingFile);

      expect(access.exists).toBe(false);
      expect(access.readable).toBe(false);
      expect(access.accessError).toBeUndefined();
    });

    it('answers true for a readable file', async () => {
      const access = await probePathAccess(validUserFile);

      expect(access).toEqual({ exists: true, readable: true });
    });

    it('answers UNDETERMINED when the probe itself fails', async () => {
      // A non-ENOENT failure means we could not look. Reporting `exists: false`
      // would claim we looked and it was not there.
      const access = await probePathAccess(`${dir}/x${NUL}y`);

      expect(access.exists).toBe('undetermined');
      expect(access.readable).toBe('undetermined');
      expect(access.accessError).toContain('ERR_INVALID_ARG_VALUE');
    });
  });
});
