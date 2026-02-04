/**
 * Requirement Gatherer Agent
 * Conversational assistant that extracts agent design requirements
 */

import * as CorePrinciples from '../../generated/resources/prompts/core-principles.js';
import * as Questioning from '../../generated/resources/prompts/questioning-techniques.js';

export interface RequirementGathererConfig {
  name: string;
  version: string;
}

export interface DesignRequest {
  agentPurpose: string;
  successCriteria: string[];
  constraints?: string[];
}

export interface RequirementGathererAgent {
  metadata: {
    name: string;
    version: string;
    archetype: 'conversational-assistant';
  };
  systemPrompt: string;
  processMessage: (message: string) => Promise<{ response: string; extracted?: Partial<DesignRequest> }>;
}

/**
 * Create a requirement gatherer agent with resource-based prompts
 */
export function createRequirementGatherer(config: RequirementGathererConfig): RequirementGathererAgent {
  // Build system prompt from fragments
  const systemPrompt = `
You are an expert agent designer helping users define their AI agent requirements.

${CorePrinciples.fragments.purposeDriven.text}

${CorePrinciples.fragments.testable.text}

${Questioning.text}

Your job: Extract agentPurpose and successCriteria through focused questioning.

Output your final understanding as JSON matching this schema:
{
  "agentPurpose": "string - clear, specific problem statement",
  "successCriteria": ["string array - measurable outcomes"]
}
  `.trim();

  return {
    metadata: {
      name: config.name,
      version: config.version,
      archetype: 'conversational-assistant' as const,
    },
    systemPrompt,

    /**
     * Process a user message and extract requirements
     */
    async processMessage(_message: string): Promise<{ response: string; extracted?: Partial<DesignRequest> }> {
      // This would integrate with an actual LLM in a real implementation
      // For now, just demonstrate the structure

      return {
        response: 'Question based on core principles...',
      };
    },
  };
}

// Example usage
const gatherer = createRequirementGatherer({
  name: 'requirement-gatherer',
  version: '1.0.0',
});

console.log('System prompt uses resources:');
console.log(`- Core principles fragments: ${Object.keys(CorePrinciples.fragments).length}`);
console.log(`- Questioning techniques: ${Questioning.text.split('\n').length} lines`);
console.log('\nAgent metadata:', gatherer.metadata);
