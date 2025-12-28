import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '../../dist/bin.js');

describe('vat resources validate (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), 'vat-validate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should validate valid resources and exit 0', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file with temp dir
    fs.writeFileSync(join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file with temp dir
    fs.writeFileSync(join(tempDir, 'other.md'), '# Other');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'validate', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const docs = yaml.loadAll(result.stdout) as Array<Record<string, unknown>>;
    const parsed = docs[0];
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('success');
  });

  it('should detect broken links and exit 1', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file with temp dir
    fs.writeFileSync(join(tempDir, 'README.md'), '[broken](./missing.md)');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'validate', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);

    const docs = yaml.loadAll(result.stdout) as Array<Record<string, unknown>>;
    const parsed = docs[0];
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('failed');
    expect(parsed.errorsFound).toBeGreaterThan(0);
  });

  it('should output test-format errors to stderr', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file with temp dir
    fs.writeFileSync(join(tempDir, 'test.md'), '[broken](./missing.md)');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'validate', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.stderr).toMatch(/test\.md:\d+:\d+: /);
    expect(result.stderr).toContain('missing.md');
  });

  it('should detect broken anchors', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test file with temp dir
    fs.writeFileSync(join(tempDir, 'test.md'), '# Test\n[link](#missing)');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'validate', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('#missing');
  });
});
