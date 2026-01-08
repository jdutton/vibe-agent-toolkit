import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


import { writeYamlOutput, flushStdout } from '../../src/utils/output.js';

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

  it('should flush stdout when not draining', async () => {
    // When writableNeedDrain is false, flushStdout should resolve immediately
    Object.defineProperty(process.stdout, 'writableNeedDrain', {
      value: false,
      configurable: true,
    });
    await expect(flushStdout()).resolves.toBeUndefined();
  });

  it('should wait for drain event when stdout needs draining', async () => {
    // When writableNeedDrain is true, flushStdout should wait for drain event
    Object.defineProperty(process.stdout, 'writableNeedDrain', {
      value: true,
      configurable: true,
    });
    
    // Simulate drain event after a short delay
    setTimeout(() => {
      process.stdout.emit('drain');
    }, 10);

    await expect(flushStdout()).resolves.toBeUndefined();
  });
});
