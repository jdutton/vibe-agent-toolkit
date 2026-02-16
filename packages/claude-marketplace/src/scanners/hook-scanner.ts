import type { CompatibilityEvidence } from '../types.js';

import { classifyCommand } from './command-classifier.js';

/**
 * Scan a hooks config object for command handlers that indicate runtime requirements.
 * Expects the parsed JSON from a hooks.json file.
 */
export function scanHooksConfig(config: Record<string, unknown>, filePath: string): CompatibilityEvidence[] {
  const evidence: CompatibilityEvidence[] = [];

  const hooks = config['hooks'];
  if (!hooks || typeof hooks !== 'object') return evidence;

  for (const [eventName, handlers] of Object.entries(hooks as Record<string, unknown[]>)) {
    if (!Array.isArray(handlers)) continue;

    for (const handler of handlers) {
      if (!handler || typeof handler !== 'object') continue;
      const h = handler as Record<string, unknown>;
      if (h['type'] !== 'command' || typeof h['command'] !== 'string') continue;

      const command = h['command'];
      const classification = classifyCommand(command);
      if (classification) {
        evidence.push({
          source: 'hook',
          file: filePath,
          signal: `hook-command: ${classification.signal}`,
          detail: `Hook "${eventName}" runs command: ${command}`,
          impact: classification.impact,
        });
      }
    }
  }

  return evidence;
}
