import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import { writeYamlOutput } from '../../src/utils/output.js';

describe('output utilities', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('should write YAML with document markers', () => {
    const data = { status: 'success', count: 42 };
    writeYamlOutput(data);

    const output = stdoutSpy.mock.calls.map(call => call[0]).join('');
    expect(output).toContain('---\n');
    expect(output).toContain('status: success');
    expect(output).toContain('count: 42');
  });

  it('should handle nested objects', () => {
    const data = {
      status: 'failed',
      errors: [
        { file: 'test.md', line: 10 }
      ]
    };
    writeYamlOutput(data);

    const output = stdoutSpy.mock.calls.map(call => call[0]).join('');
    expect(output).toContain('errors:');
    expect(output).toContain('file: test.md');
    expect(output).toContain('line: 10');
  });
});
