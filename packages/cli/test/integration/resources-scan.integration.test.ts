import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '../../dist/bin.js');

describe('vat resources scan (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), 'vat-scan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should scan directory and output YAML', () => {
    // Create test markdown files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled in tests
    fs.writeFileSync(join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled in tests
    fs.writeFileSync(join(tempDir, 'other.md'), '# Other');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'scan', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    // Parse YAML output (use loadAll to handle document markers)
    const output = result.stdout;
    expect(output).toContain('---');

    const docs = yaml.loadAll(output) as Array<Record<string, unknown>>;
    const parsed = docs[0];
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('success');
    expect(parsed.filesScanned).toBeGreaterThan(0);
  });

  it('should exit 0 even if no files found', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'scan', tempDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
  });

  it('should use current directory if no path provided', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled in tests
    fs.writeFileSync(join(tempDir, 'test.md'), '# Test');

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'resources', 'scan'], {
      encoding: 'utf-8',
      cwd: tempDir,
    });

    expect(result.status).toBe(0);
  });
});
