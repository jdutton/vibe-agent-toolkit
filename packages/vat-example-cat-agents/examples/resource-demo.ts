/**
 * Resource Compilation Demo
 *
 * Demonstrates how to use compiled markdown resources in TypeScript
 */

import * as BreedAdvisor from '../generated/resources/agents/breed-advisor.js';
import * as NameGenerator from '../generated/resources/agents/name-generator.js';

console.log('='.repeat(80));
console.log('Resource Compilation Demo - Single File Per Agent Pattern');
console.log('='.repeat(80));
console.log();

// Demonstrate breed-advisor resource
console.log('📋 BREED ADVISOR RESOURCE:');
console.log('─'.repeat(80));
console.log(`  Total fragments: ${Object.keys(BreedAdvisor.fragments).length}`);
console.log(`  Fragment names: ${Object.keys(BreedAdvisor.fragments).join(', ')}`);
console.log();

// Show a specific fragment
console.log('  Example fragment: welcomeMessage');
console.log(`  Length: ${BreedAdvisor.fragments.welcomeMessage.text.length} chars`);
console.log();
console.log('  Content preview:');
console.log('  ' + BreedAdvisor.fragments.welcomeMessage.text.split('\n')[0].substring(0, 60) + '...');
console.log();

// Show music preference insight
console.log('  Music Preference Insight:');
console.log('  ' + BreedAdvisor.fragments.musicPreferenceInsight.text.split('\n').slice(0, 3).join('\n  '));
console.log();
console.log('─'.repeat(80));
console.log();

// Demonstrate name-generator resource
console.log('🎨 NAME GENERATOR RESOURCE:');
console.log('─'.repeat(80));
console.log(`  Total fragments: ${Object.keys(NameGenerator.fragments).length}`);
console.log(`  Fragment names: ${Object.keys(NameGenerator.fragments).join(', ')}`);
console.log();

// Show system prompt preview
console.log('  System Prompt preview:');
console.log('  ' + NameGenerator.fragments.systemPrompt.text.split('\n').slice(0, 3).join('\n  '));
console.log();
console.log('─'.repeat(80));
console.log();

// Demonstrate variable substitution
console.log('🔧 VARIABLE SUBSTITUTION:');
console.log('─'.repeat(80));

const conclusionTemplate = BreedAdvisor.fragments.conclusionPrompt.text;
const selectedBreed = 'Maine Coon';
const filledPrompt = conclusionTemplate.replace('{{selectedBreed}}', selectedBreed);

console.log('  Template has {{selectedBreed}} variable');
console.log('  Filled with: "Maine Coon"');
console.log();
console.log('  Result:');
console.log('  ' + filledPrompt.split('\n').slice(0, 2).join('\n  '));
console.log();
console.log('─'.repeat(80));
console.log();

// Show auditability benefit
console.log('✅ AUDITABILITY:');
console.log('─'.repeat(80));
console.log('  To audit breed-advisor prompts:');
console.log('  $ cat resources/agents/breed-advisor.md');
console.log();
console.log('  No TypeScript knowledge required!');
console.log('  All prompts visible in clean markdown format.');
console.log();
console.log('─'.repeat(80));
console.log();

console.log('📊 SUMMARY:');
console.log('─'.repeat(80));
console.log(`  ✓ 2 agent resources compiled`);
console.log(`  ✓ ${Object.keys(BreedAdvisor.fragments).length + Object.keys(NameGenerator.fragments).length} total fragments available`);
console.log(`  ✓ Type-safe imports with autocomplete`);
console.log(`  ✓ Markdown files are human-readable`);
console.log(`  ✓ Single file per agent (simple organization)`);
console.log();
console.log('='.repeat(80));
