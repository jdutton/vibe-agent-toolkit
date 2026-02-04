/**
 * Pattern Analyzer Agent
 * LLM Analyzer that identifies appropriate agent archetypes
 */

import * as CorePrinciples from '../../generated/resources/prompts/core-principles.js';
import * as LLMSelection from '../../generated/resources/prompts/llm-selection.js';
import * as PatternRecognition from '../../generated/resources/prompts/pattern-recognition.js';

export interface PatternAnalyzerConfig {
  name: string;
  version: string;
}

export interface DesignRequest {
  agentPurpose: string;
  successCriteria: string[];
  constraints?: string[];
}

export interface PatternAnalysis {
  recommendedArchetype: 'pure-function-tool' | 'llm-analyzer' | 'conversational-assistant' | 'agentic-workflow';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  recommendedLLM?: string;
  alternativePatterns?: string[];
}

export interface PatternAnalyzerAgent {
  metadata: {
    name: string;
    version: string;
    archetype: 'llm-analyzer';
  };
  systemPrompt: string;
  analyze: (request: DesignRequest) => Promise<PatternAnalysis>;
}

/**
 * Create a pattern analyzer agent with resource-based prompts
 */
export function createPatternAnalyzer(config: PatternAnalyzerConfig): PatternAnalyzerAgent {
  // Build system prompt from fragments
  const systemPrompt = `
You are an expert agent architect that analyzes requirements and recommends appropriate agent patterns.

${CorePrinciples.fragments.purposeDriven.text}

${CorePrinciples.fragments.simpleFirst.text}

${PatternRecognition.text}

${LLMSelection.text}

Your job: Analyze the design request and recommend the best agent archetype and LLM.

Output JSON matching this schema:
{
  "recommendedArchetype": "pure-function-tool | llm-analyzer | conversational-assistant | agentic-workflow",
  "confidence": "high | medium | low",
  "reasoning": "string - explain why this pattern fits",
  "recommendedLLM": "string - specific model recommendation",
  "alternativePatterns": ["string array - other viable options"]
}
  `.trim();

  return {
    metadata: {
      name: config.name,
      version: config.version,
      archetype: 'llm-analyzer' as const,
    },
    systemPrompt,

    /**
     * Analyze a design request and recommend pattern
     */
    async analyze(_request: DesignRequest): Promise<PatternAnalysis> {
      // This would integrate with an actual LLM in a real implementation
      // For now, demonstrate the structure

      return {
        recommendedArchetype: 'conversational-assistant',
        confidence: 'high',
        reasoning: 'Multi-turn dialogue with context accumulation',
        recommendedLLM: 'claude-3-5-sonnet-20241022',
        alternativePatterns: ['llm-analyzer'],
      };
    },
  };
}

// Example usage demonstrating resource composition
const analyzer = createPatternAnalyzer({
  name: 'pattern-analyzer',
  version: '1.0.0',
});

console.log('Pattern Analyzer Agent:');
console.log(`- System prompt length: ${analyzer.systemPrompt.length} chars`);
console.log(`- Resources used: ${Object.keys(CorePrinciples.fragments).length + Object.keys(PatternRecognition.fragments).length + Object.keys(LLMSelection.fragments).length} fragments`);
console.log(`- Archetype: ${analyzer.metadata.archetype}`);
console.log('\nPrompt composition:');
console.log(`  • Core principles: ${Object.keys(CorePrinciples.fragments).length} fragments`);
console.log(`  • Pattern recognition: ${Object.keys(PatternRecognition.fragments).length} fragments`);
console.log(`  • LLM selection: ${Object.keys(LLMSelection.fragments).length} fragments`);
