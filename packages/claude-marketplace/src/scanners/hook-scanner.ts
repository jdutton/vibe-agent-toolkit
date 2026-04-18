import type { EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

import { classifyCommand } from './command-classifier.js';
import { buildEvidence } from './evidence-helpers.js';

/**
 * Scan a hooks config object for command handlers that indicate runtime
 * requirements. Each command handler that matches a known shell binary
 * yields a HOOK_COMMAND_INVOKES_BINARY evidence record.
 */
export function scanHooksConfig(config: Record<string, unknown>, filePath: string): EvidenceRecord[] {
  const evidence: EvidenceRecord[] = [];

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
        evidence.push(
          buildEvidence(
            'HOOK_COMMAND_INVOKES_BINARY',
            filePath,
            `${eventName} → ${classification.signal}: ${command}`,
          ),
        );
      }
    }
  }

  return evidence;
}
