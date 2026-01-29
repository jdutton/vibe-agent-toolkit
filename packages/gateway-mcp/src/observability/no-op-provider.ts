/**
 * No-op observability provider
 *
 * This file implements the Null Object pattern for observability.
 * All methods are intentionally empty - they satisfy the interface
 * contract without performing any operations.
 *
 * SonarQube: Empty methods are intentional (no-op pattern)
 */

import type {
  Counter,
  Histogram,
  Logger,
  Meter,
  ObservabilityProvider,
  Span,
  Tracer,
} from '../types.js';

class NoOpLogger implements Logger {
  info(): void {} // NOSONAR - intentional no-op
  error(): void {} // NOSONAR - intentional no-op
  warn(): void {} // NOSONAR - intentional no-op
  debug(): void {} // NOSONAR - intentional no-op
}

class NoOpSpan implements Span {
  setAttribute(): void {} // NOSONAR - intentional no-op
  recordException(): void {} // NOSONAR - intentional no-op
  setStatus(): void {} // NOSONAR - intentional no-op
  end(): void {} // NOSONAR - intentional no-op
}

class NoOpTracer implements Tracer {
  async startActiveSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = new NoOpSpan();
    return fn(span);
  }
}

class NoOpCounter implements Counter {
  add(): void {} // NOSONAR - intentional no-op
}

class NoOpHistogram implements Histogram {
  record(): void {} // NOSONAR - intentional no-op
}

class NoOpMeter implements Meter {
  createCounter(): Counter {
    return new NoOpCounter();
  }

  createHistogram(): Histogram {
    return new NoOpHistogram();
  }
}

/**
 * No-op observability provider (default when observability not configured)
 */
export class NoOpObservabilityProvider implements ObservabilityProvider {
  private readonly logger = new NoOpLogger();
  private readonly tracer = new NoOpTracer();
  private readonly meter = new NoOpMeter();

  getLogger(): Logger {
    return this.logger;
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  getMeter(): Meter {
    return this.meter;
  }
}
