/**
 * Demo: Vercel AI SDK Runtime with Cat Agents
 *
 * This demo shows how to use VAT agents with Vercel AI SDK with REAL LLM calls.
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 * - ANTHROPIC_API_KEY environment variable
 *
 * Run with: source ~/.secrets.env && bun run demo
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import {
  HaikuSchema,
  HaikuValidationResultSchema,
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  NameValidationInputSchema,
  NameValidationResultSchema,
  haikuValidatorAgent,
  nameGeneratorAgent,
  nameValidatorAgent,
  validateCatName,
  validateHaiku,
} from '@vibe-agent-toolkit/vat-example-cat-agents';
import { generateText, stepCountIs } from 'ai';

import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

import { colors, log, section } from './demo-helpers.js';

// Demo functions are allowed to be more complex for educational purposes
// eslint-disable-next-line sonarjs/cognitive-complexity
async function demo() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   VAT Runtime Adapter Demo: Vercel AI SDK + Cat Agents              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // ============================================================================
  // DEMO 1: Converting Pure Function Agents to Tools
  // ============================================================================
  section('Demo 1: Converting Pure Function Agents to Tools');

  log('Setup', 'Converting haiku validator to Vercel AI tool...', colors.cyan);

  const haikuTool = convertPureFunctionToTool(
    haikuValidatorAgent,
    HaikuSchema,
    HaikuValidationResultSchema,
  );

  log('Success', `Converted: ${haikuTool.metadata.name}`, colors.green);
  log('Info', `  Archetype: ${haikuTool.metadata.archetype}`, colors.dim);
  log('Info', `  Description: ${haikuTool.metadata.description}`, colors.dim);
  log('Info', `  Version: ${haikuTool.metadata.version}`, colors.dim);

  console.log('\n' + colors.bright + 'Tool Interface:' + colors.reset);
  console.log(`${colors.dim}  • description: ${haikuTool.tool.description}`);
  console.log(`  • parameters: Zod schema for validation`);
  console.log(`  • execute: async function${colors.reset}`);

  // Test the original agent function directly
  console.log('\n' + colors.yellow + 'Testing with valid haiku:' + colors.reset);
  const validHaiku = {
    line1: 'Orange fur ablaze',
    line2: 'Whiskers twitch in winter sun',
    line3: 'Cat dreams of dinner',
  };

  console.log(`  "${validHaiku.line1}"`);
  console.log(`  "${validHaiku.line2}"`);
  console.log(`  "${validHaiku.line3}"`);

  const validResult = validateHaiku(validHaiku);
  log('Result', `Valid: ${validResult.valid}`, colors.green);
  log('Result', `Syllables: ${validResult.syllables.line1}-${validResult.syllables.line2}-${validResult.syllables.line3}`, colors.green);
  if (validResult.hasKigo) {
    log('Result', '✓ Has seasonal reference (kigo)', colors.green);
  }
  if (validResult.hasKireji) {
    log('Result', '✓ Has cutting word (kireji)', colors.green);
  }

  console.log('\n' + colors.yellow + 'Testing with invalid haiku:' + colors.reset);
  const invalidHaiku = {
    line1: 'Cat',
    line2: 'Meow',
    line3: 'Purr',
  };

  console.log(`  "${invalidHaiku.line1}"`);
  console.log(`  "${invalidHaiku.line2}"`);
  console.log(`  "${invalidHaiku.line3}"`);

  const invalidResult = validateHaiku(invalidHaiku);
  log('Result', `Valid: ${invalidResult.valid}`, colors.yellow);
  log('Result', `Errors: ${invalidResult.errors.length}`, colors.yellow);
  for (const error of invalidResult.errors) {
    console.log(`  ${colors.dim}• ${error}${colors.reset}`);
  }

  // ============================================================================
  // DEMO 2: Batch Tool Conversion
  // ============================================================================
  section('Demo 2: Batch Tool Conversion');

  log('Setup', 'Converting multiple validators to tools...', colors.cyan);

  const tools = convertPureFunctionsToTools({
    validateHaiku: {
      agent: haikuValidatorAgent as never,
      inputSchema: HaikuSchema as never,
      outputSchema: HaikuValidationResultSchema as never,
    },
    validateName: {
      agent: nameValidatorAgent as never,
      inputSchema: NameValidationInputSchema as never,
      outputSchema: NameValidationResultSchema as never,
    },
  });

  log('Success', `Converted ${Object.keys(tools).length} tools`, colors.green);
  for (const name of Object.keys(tools)) {
    console.log(`  ${colors.dim}• ${name}${colors.reset}`);
  }

  console.log('\n' + colors.yellow + 'Testing name validator:' + colors.reset);
  const nameToValidate = 'Sir Whiskersworth III';
  console.log(`  Name: "${nameToValidate}"`);

  const nameResult = validateCatName(nameToValidate, {
    physical: { furColor: 'Orange', size: 'medium' },
    behavioral: { personality: ['Distinguished', 'Noble'] },
    description: 'A distinguished orange cat',
  });

  log('Result', `Status: ${nameResult.status}`, nameResult.status === 'valid' ? colors.green : colors.yellow);
  console.log(`  ${colors.dim}${nameResult.reason}${colors.reset}`);

  // ============================================================================
  // DEMO 3: Real LLM Tool Calling with OpenAI
  // ============================================================================
  section('Demo 3: Real LLM Tool Calling with OpenAI');

  log('Info', 'Using OpenAI GPT-4o-mini with haiku validator tool...', colors.cyan);

  const llmResult = await generateText({
    model: openai('gpt-4o-mini'),
    tools: {
      validateHaiku: haikuTool.tool,
    },
    stopWhen: stepCountIs(3),
    prompt: `Generate a haiku about an orange cat sitting in the sun.
After you generate it, validate it using the validateHaiku tool to check the syllable structure.
If it's not valid, explain what's wrong.`,
  });

  log('LLM Response', 'Tool calls made:', colors.green);
  console.log(`${colors.dim}  Text: ${llmResult.text}${colors.reset}`);

  if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
    console.log(`\n${colors.yellow}Tool Calls:${colors.reset}`);
    for (const toolCall of llmResult.toolCalls) {
      console.log(`${colors.dim}  • ${toolCall.toolName}${colors.reset}`);
      console.log(`${colors.dim}    Input: ${JSON.stringify(toolCall.input, null, 2).split('\n').join('\n    ')}${colors.reset}`);
    }
  }

  if (llmResult.toolResults && llmResult.toolResults.length > 0) {
    console.log(`\n${colors.yellow}Tool Results:${colors.reset}`);
    for (const toolResult of llmResult.toolResults) {
      console.log(`${colors.dim}  • ${toolResult.toolName}${colors.reset}`);
      console.log(`${colors.dim}    Output: ${JSON.stringify(toolResult.output, null, 2).split('\n').join('\n    ')}${colors.reset}`);
    }
  }

  // ============================================================================
  // DEMO 4: Real LLM Analyzer Functions with OpenAI
  // ============================================================================
  section('Demo 4: Real LLM Analyzer Functions with OpenAI');

  log('Info', 'Creating name generator function with OpenAI GPT-4o-mini...', colors.cyan);

  const generateName = convertLLMAnalyzerToFunction(
    nameGeneratorAgent,
    NameGeneratorInputSchema,
    NameSuggestionSchema,
    {
      model: openai('gpt-4o-mini'),
      temperature: 0.9,
    },
  );

  log('Info', 'Generating name for a mischievous orange cat...', colors.cyan);

  const mischievousCatInput = {
    characteristics: {
      physical: { furColor: 'Orange', size: 'medium' as const },
      behavioral: {
        personality: ['Mischievous', 'Energetic'],
        quirks: ['Knocks things off tables', 'Zooms at 3am'],
      },
      description: 'A mischievous orange cat who loves causing chaos',
    },
  };

  const nameResultOpenAI = await generateName(mischievousCatInput);

  log('Generated Name', nameResultOpenAI.name, colors.green);
  console.log(`\n${colors.yellow}Reasoning:${colors.reset}`);
  console.log(`${colors.dim}  ${nameResultOpenAI.reasoning}${colors.reset}`);
  if (nameResultOpenAI.alternatives && nameResultOpenAI.alternatives.length > 0) {
    console.log(`\n${colors.yellow}Alternative Names:${colors.reset}`);
    for (const altName of nameResultOpenAI.alternatives) {
      console.log(`${colors.dim}  • ${altName}${colors.reset}`);
    }
  }

  // ============================================================================
  // DEMO 5: Provider Comparison - OpenAI vs Anthropic
  // ============================================================================
  section('Demo 5: Provider Comparison - OpenAI vs Anthropic');

  log('Info', 'Same adapter works with any Vercel AI SDK provider', colors.cyan);
  console.log(`${colors.dim}  Testing with Anthropic Claude 4.5 Sonnet...${colors.reset}\n`);

  // Create name generator with Anthropic
  log('Setup', 'Creating name generator with Anthropic Claude 4.5 Sonnet...', colors.cyan);
  const generateNameAnthropic = convertLLMAnalyzerToFunction(
    nameGeneratorAgent,
    NameGeneratorInputSchema,
    NameSuggestionSchema,
    {
      model: anthropic('claude-sonnet-4-5-20250929'),
      temperature: 0.9,
    },
  );

  log('Info', 'Generating name for a distinguished orange cat...', colors.cyan);

  const distinguishedCatInput = {
    characteristics: {
      physical: { furColor: 'Orange', size: 'large' as const },
      behavioral: {
        personality: ['Distinguished', 'Noble', 'Regal'],
        quirks: ['Sits like royalty', 'Judges everyone'],
      },
      description: 'A distinguished orange cat with a regal bearing',
    },
  };

  const nameResultAnthropic = await generateNameAnthropic(distinguishedCatInput);

  console.log(`\n${colors.green}Anthropic Claude Result:${colors.reset}`);
  log('Generated Name', nameResultAnthropic.name, colors.green);
  console.log(`${colors.dim}  Reasoning: ${nameResultAnthropic.reasoning}${colors.reset}`);
  if (nameResultAnthropic.alternatives && nameResultAnthropic.alternatives.length > 0) {
    console.log(`${colors.dim}  Alternatives: ${nameResultAnthropic.alternatives.join(', ')}${colors.reset}`);
  }

  log('Key Point', 'Same VAT agent, same adapter code, different LLM provider!', colors.green);

  // ============================================================================
  // Summary
  // ============================================================================
  section('Summary');

  console.log(`${colors.green}✓ Pure Function Tools${colors.reset} - Converted VAT agents to Vercel AI SDK tools`);
  console.log(`${colors.green}✓ Batch Conversion${colors.reset} - Multiple tools in one call`);
  console.log(`${colors.green}✓ LLM Tool Calling${colors.reset} - Tools work with generateText() for function calling`);
  console.log(`${colors.green}✓ LLM Analyzers${colors.reset} - Direct function execution with structured I/O`);
  console.log(`${colors.green}✓ Provider Agnostic${colors.reset} - OpenAI, Anthropic, Google, or any LanguageModelV1`);

  console.log('\n' + colors.dim + 'Architecture:' + colors.reset);
  console.log(`${colors.dim}  VAT Agent (portable) → Runtime Adapter → Vercel AI SDK → Any LLM Provider${colors.reset}`);

  console.log('\n' + colors.dim + 'See README.md for complete API reference and more examples' + colors.reset);
  console.log(colors.dim + 'Source: packages/runtime-vercel-ai-sdk/' + colors.reset + '\n');
}

// Run the demo
demo().catch(console.error);
