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
  info(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
}

class NoOpSpan implements Span {
  setAttribute(): void {}
  recordException(): void {}
  setStatus(): void {}
  end(): void {}
}

class NoOpTracer implements Tracer {
  async startActiveSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = new NoOpSpan();
    return fn(span);
  }
}

class NoOpCounter implements Counter {
  add(): void {}
}

class NoOpHistogram implements Histogram {
  record(): void {}
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
