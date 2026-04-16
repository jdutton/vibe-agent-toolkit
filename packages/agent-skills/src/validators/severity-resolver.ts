import { CODE_REGISTRY, type IssueCode, type IssueSeverity } from './code-registry.js';

export interface SeverityConfig {
  severity?: Partial<Record<IssueCode, IssueSeverity>>;
}

export function resolveSeverity(code: IssueCode, config: SeverityConfig): IssueSeverity {
  const override = config.severity?.[code];
  if (override === 'error' || override === 'warning' || override === 'ignore') {
    return override;
  }
  return CODE_REGISTRY[code].defaultSeverity;
}
