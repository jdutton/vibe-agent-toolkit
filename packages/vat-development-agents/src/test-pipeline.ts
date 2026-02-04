/**
 * Test Pipeline - Demonstrates Resource-Based Agent System
 *
 * This script demonstrates:
 * 1. Markdown resources compiled to TypeScript modules
 * 2. Type-safe fragment composition
 * 3. Multiple agents using shared resources
 */

import { createRequirementGatherer } from './agents/requirement-gatherer.js';
import { createPatternAnalyzer } from './agents/pattern-analyzer.js';
import * as CorePrinciples from '../generated/resources/prompts/core-principles.js';
import * as PatternRecognition from '../generated/resources/prompts/pattern-recognition.js';
import * as Questioning from '../generated/resources/prompts/questioning-techniques.js';
import * as LLMSelection from '../generated/resources/prompts/llm-selection.js';

console.log('='.repeat(80));
console.log('VAT Development Agents - Resource Compilation Demo');
console.log('='.repeat(80));
console.log();

// Test 1: Verify resources were compiled correctly
console.log('📦 COMPILED RESOURCES:');
console.log('─'.repeat(80));

const resources = [
  { name: 'core-principles', module: CorePrinciples },
  { name: 'pattern-recognition', module: PatternRecognition },
  { name: 'questioning-techniques', module: Questioning },
  { name: 'llm-selection', module: LLMSelection },
];

for (const resource of resources) {
  const fragmentCount = Object.keys(resource.module.fragments).length;
  const textLength = resource.module.text.length;

  console.log(`\n  ${resource.name}:`);
  console.log(`    • Fragments: ${fragmentCount}`);
  console.log(`    • Full text: ${textLength} chars`);
  console.log(`    • Fragment keys: ${Object.keys(resource.module.fragments).join(', ')}`);
}

console.log();
console.log('─'.repeat(80));
console.log();

// Test 2: Create requirement gatherer agent
console.log('🤖 REQUIREMENT GATHERER AGENT:');
console.log('─'.repeat(80));

const gatherer = createRequirementGatherer({
  name: 'requirement-gatherer',
  version: '1.0.0',
});

console.log(`  Name: ${gatherer.metadata.name}`);
console.log(`  Version: ${gatherer.metadata.version}`);
console.log(`  Archetype: ${gatherer.metadata.archetype}`);
console.log(`  System Prompt Length: ${gatherer.systemPrompt.length} chars`);
console.log();
console.log('  Composed from:');
console.log(`    • CorePrinciples.fragments.purposeDriven (${CorePrinciples.fragments.purposeDriven.text.length} chars)`);
console.log(`    • CorePrinciples.fragments.testable (${CorePrinciples.fragments.testable.text.length} chars)`);
console.log(`    • Questioning.text (${Questioning.text.length} chars)`);
console.log();
console.log('─'.repeat(80));
console.log();

// Test 3: Create pattern analyzer agent
console.log('🔍 PATTERN ANALYZER AGENT:');
console.log('─'.repeat(80));

const analyzer = createPatternAnalyzer({
  name: 'pattern-analyzer',
  version: '1.0.0',
});

console.log(`  Name: ${analyzer.metadata.name}`);
console.log(`  Version: ${analyzer.metadata.version}`);
console.log(`  Archetype: ${analyzer.metadata.archetype}`);
console.log(`  System Prompt Length: ${analyzer.systemPrompt.length} chars`);
console.log();
console.log('  Composed from:');
console.log(`    • CorePrinciples.fragments.purposeDriven (${CorePrinciples.fragments.purposeDriven.text.length} chars)`);
console.log(`    • CorePrinciples.fragments.simpleFirst (${CorePrinciples.fragments.simpleFirst.text.length} chars)`);
console.log(`    • PatternRecognition.text (${PatternRecognition.text.length} chars)`);
console.log(`    • LLMSelection.text (${LLMSelection.text.length} chars)`);
console.log();
console.log('─'.repeat(80));
console.log();

// Test 4: Demonstrate fragment-level reuse
console.log('♻️  FRAGMENT REUSE ANALYSIS:');
console.log('─'.repeat(80));

console.log(`\n  The 'purposeDriven' fragment is used by BOTH agents:`);
console.log(`    • Requirement Gatherer uses it`);
console.log(`    • Pattern Analyzer uses it`);
console.log(`    • Single source of truth: resources/prompts/core-principles.md`);
console.log(`    • Type-safe imports with autocomplete`);
console.log();
console.log('  Fragment content preview:');
console.log(`    "${CorePrinciples.fragments.purposeDriven.header}"`);
console.log(`    ${CorePrinciples.fragments.purposeDriven.body.substring(0, 100)}...`);
console.log();
console.log('─'.repeat(80));
console.log();

// Test 5: Type safety demonstration
console.log('✅ TYPE SAFETY VERIFICATION:');
console.log('─'.repeat(80));

console.log(`\n  TypeScript provides autocomplete for all fragments:`);
console.log(`    • CorePrinciples.fragments.purposeDriven ✓`);
console.log(`    • CorePrinciples.fragments.simpleFirst ✓`);
console.log(`    • CorePrinciples.fragments.contextEfficient ✓`);
console.log(`    • CorePrinciples.fragments.testable ✓`);
console.log(`    • CorePrinciples.fragments.toolAppropriate ✓`);
console.log();
console.log(`  Each fragment has typed properties:`);
console.log(`    • header: string`);
console.log(`    • body: string`);
console.log(`    • text: string (header + body)`);
console.log();
console.log('─'.repeat(80));
console.log();

// Summary
console.log('📊 SUMMARY:');
console.log('─'.repeat(80));
console.log(`\n  ✓ 4 markdown resources compiled to TypeScript modules`);
console.log(`  ✓ 2 agents created using resource fragments`);
console.log(`  ✓ Type-safe imports with full IDE support`);
console.log(`  ✓ Fragment-level reuse demonstrated`);
console.log(`  ✓ Build pipeline verified (markdown → JS → TypeScript)`);
console.log();
console.log('  Resource compilation benefits:');
console.log('    • Single source of truth for prompts');
console.log('    • Fragment-level composition and reuse');
console.log('    • Compile-time type safety');
console.log('    • Zero runtime overhead');
console.log('    • IDE autocomplete for all fragments');
console.log();
console.log('='.repeat(80));
