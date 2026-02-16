import type { ImpactLevel, Target, Verdict } from '../src/types.js';

/** Build a markdown bash code block containing a single command */
export function bashCodeBlock(command: string): string {
  return ['```bash', command, '```'].join('\n');
}

/** Build an impact record with defaults of 'ok' for each target */
export function impact(
  desktop: ImpactLevel = 'ok',
  cowork: ImpactLevel = 'ok',
  code: ImpactLevel = 'ok',
): Record<Target, ImpactLevel> {
  return { 'claude-desktop': desktop, cowork, 'claude-code': code };
}

/** Build a verdicts record for assertion against CompatibilityResult.analyzed */
export function verdicts(
  desktop: Verdict,
  cowork: Verdict,
  code: Verdict,
): Record<Target, Verdict> {
  return { 'claude-desktop': desktop, cowork, 'claude-code': code };
}
