import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import { writeStructuredOutput, writeYamlOutput } from '../../src/utils/output.js';

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

  describe('writeStructuredOutput', () => {
    const data = { status: 'ok', examined: 3 };

    it('writes one JSON document when the format is json', () => {
      writeStructuredOutput(data, 'json');

      const output = stdoutSpy.mock.calls.map((call) => call[0]).join('');
      expect(JSON.parse(output)).toEqual(data);
      expect(output).not.toContain('---');
    });

    it.each([['yaml'], [undefined]])('writes YAML for format %s', (format) => {
      writeStructuredOutput(data, format);

      const output = stdoutSpy.mock.calls.map((call) => call[0]).join('');
      expect(output.startsWith('---\n')).toBe(true);
      expect(output).toContain('examined: 3');
    });
  });
});
