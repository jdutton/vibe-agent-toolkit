import { describe, expect, it } from 'vitest';

import { NoOpObservabilityProvider } from '../../src/observability/no-op-provider.js';

describe('NoOpObservabilityProvider', () => {
  it('should provide no-op logger', () => {
    const provider = new NoOpObservabilityProvider();
    const logger = provider.getLogger();

    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });

  it('should provide no-op tracer', async () => {
    const provider = new NoOpObservabilityProvider();
    const tracer = provider.getTracer();

    const result = await tracer.startActiveSpan('test', async (span) => {
      span.setAttribute('test', 'value');
      span.end();
      return 'result';
    });

    expect(result).toBe('result');
  });

  it('should provide no-op meter', () => {
    const provider = new NoOpObservabilityProvider();
    const meter = provider.getMeter();
    const counter = meter.createCounter('test');

    expect(() => counter.add(1)).not.toThrow();
  });
});
