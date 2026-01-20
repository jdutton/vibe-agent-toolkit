/**
 * Runtime-Agnostic Demo for VAT Agents
 *
 * This demo can work with ANY runtime adapter (Vercel AI SDK, LangChain, OpenAI, etc.)
 * by accepting runtime-specific functions as parameters.
 */

import type { NameSuggestion } from '@vibe-agent-toolkit/vat-example-cat-agents';
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

import { colors, log, section } from './demo-helpers.js';

/**
 * Runtime adapter interface - each runtime must provide these functions
 *
 * Note: Uses `any` types for flexibility across different runtime implementations.
 * The underlying adapter functions have proper types; this interface is just for demo wiring.
 */
export interface RuntimeAdapter {
  /** Name of the runtime (e.g., "Vercel AI SDK", "LangChain", "OpenAI SDK") */
  name: string;

  /** Convert a pure function agent to runtime-specific tool */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  convertPureFunctionToTool: (...args: any[]) => {
    metadata: { name: string; description: string; version: string; archetype: string };
  } & Record<string, unknown>;

  /** Convert multiple pure function agents to tools */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  convertPureFunctionsToTools: (...args: any[]) => Record<string, unknown>;

  /** Convert LLM analyzer agent to executable function */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  convertLLMAnalyzerToFunction: <TInput, TOutput>(...args: any[]) => (input: TInput) => Promise<TOutput>;

  /** Create LLM config for primary provider (e.g., OpenAI GPT-4o-mini) */
  createPrimaryLLMConfig: () => unknown;

  /** Create LLM config for secondary provider (e.g., Anthropic Claude) */
  createSecondaryLLMConfig?: () => unknown;

  /** Optional: Demo tool calling with LLM (not all runtimes support this) */
  demoToolCalling?: (
    tool: unknown,
    prompt: string,
  ) => Promise<{ text: string; toolCalls?: unknown[]; toolResults?: unknown[] }>;
}

/**
 * Run the runtime-agnostic demo
 * Demo functions are allowed to be more complex for educational purposes
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function runCommonDemo(adapter: RuntimeAdapter): Promise<void> {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log(`║   VAT Runtime Adapter Demo: ${adapter.name.padEnd(39)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // ============================================================================
  // DEMO 1: Converting Pure Function Agents to Tools
  // ============================================================================
  section('Demo 1: Converting Pure Function Agents to Tools');

  log('Setup', `Converting haiku validator to ${adapter.name} tool...`, colors.cyan);

  const haikuTool = adapter.convertPureFunctionToTool(
    haikuValidatorAgent,
    HaikuSchema,
    HaikuValidationResultSchema,
  );

  log('Success', `Converted: ${haikuTool.metadata.name}`, colors.green);
  log('Info', `  Archetype: ${haikuTool.metadata.archetype}`, colors.dim);
  log('Info', `  Description: ${haikuTool.metadata.description}`, colors.dim);
  log('Info', `  Version: ${haikuTool.metadata.version}`, colors.dim);

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
  log(
    'Result',
    `Syllables: ${validResult.syllables.line1}-${validResult.syllables.line2}-${validResult.syllables.line3}`,
    colors.green,
  );
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

  const tools = adapter.convertPureFunctionsToTools({
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

  log(
    'Result',
    `Status: ${nameResult.status}`,
    nameResult.status === 'valid' ? colors.green : colors.yellow,
  );
  console.log(`  ${colors.dim}${nameResult.reason}${colors.reset}`);

  // ============================================================================
  // DEMO 3: LLM Tool Calling (if supported)
  // ============================================================================
  if (adapter.demoToolCalling) {
    section('Demo 3: LLM Tool Calling');

    log('Info', `Using ${adapter.name} with haiku validator tool...`, colors.cyan);

    const llmResult = await adapter.demoToolCalling(
      haikuTool,
      `Generate a haiku about an orange cat sitting in the sun.
After you generate it, validate it using the validateHaiku tool to check the syllable structure.
If it's not valid, explain what's wrong.`,
    );

    log('LLM Response', 'Tool calls made:', colors.green);
    console.log(`${colors.dim}  Text: ${llmResult.text}${colors.reset}`);

    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      console.log(`\n${colors.yellow}Tool Calls:${colors.reset}`);
      for (const toolCall of llmResult.toolCalls as Array<{
        toolName: string;
        input: unknown;
      }>) {
        console.log(`${colors.dim}  • ${toolCall.toolName}${colors.reset}`);
        console.log(
          `${colors.dim}    Input: ${JSON.stringify(toolCall.input, null, 2).split('\n').join('\n    ')}${colors.reset}`,
        );
      }
    }

    if (llmResult.toolResults && llmResult.toolResults.length > 0) {
      console.log(`\n${colors.yellow}Tool Results:${colors.reset}`);
      for (const toolResult of llmResult.toolResults as Array<{
        toolName: string;
        output: unknown;
      }>) {
        console.log(`${colors.dim}  • ${toolResult.toolName}${colors.reset}`);
        console.log(
          `${colors.dim}    Output: ${JSON.stringify(toolResult.output, null, 2).split('\n').join('\n    ')}${colors.reset}`,
        );
      }
    }
  }

  // ============================================================================
  // DEMO 4: LLM Analyzer Functions with Primary Provider
  // ============================================================================
  section('Demo 4: LLM Analyzer Functions with Primary Provider');

  log('Info', 'Creating name generator function...', colors.cyan);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateName = adapter.convertLLMAnalyzerToFunction<any, NameSuggestion>(
    nameGeneratorAgent,
    NameGeneratorInputSchema,
    NameSuggestionSchema,
    adapter.createPrimaryLLMConfig(),
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

  const nameResult1 = await generateName(mischievousCatInput);

  log('Generated Name', nameResult1.name, colors.green);
  console.log(`\n${colors.yellow}Reasoning:${colors.reset}`);
  console.log(`${colors.dim}  ${nameResult1.reasoning}${colors.reset}`);
  if (nameResult1.alternatives && nameResult1.alternatives.length > 0) {
    console.log(`\n${colors.yellow}Alternative Names:${colors.reset}`);
    for (const altName of nameResult1.alternatives) {
      console.log(`${colors.dim}  • ${altName}${colors.reset}`);
    }
  }

  // ============================================================================
  // DEMO 5: Provider Comparison (if secondary provider available)
  // ============================================================================
  if (adapter.createSecondaryLLMConfig) {
    section('Demo 5: Provider Comparison');

    log('Info', `Same adapter works with different LLM providers`, colors.cyan);
    console.log(`${colors.dim}  Testing with secondary provider...${colors.reset}\n`);

    log('Setup', 'Creating name generator with secondary provider...', colors.cyan);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generateNameSecondary = adapter.convertLLMAnalyzerToFunction<any, NameSuggestion>(
      nameGeneratorAgent,
      NameGeneratorInputSchema,
      NameSuggestionSchema,
      adapter.createSecondaryLLMConfig(),
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

    const nameResult2 = await generateNameSecondary(distinguishedCatInput);

    console.log(`\n${colors.green}Secondary Provider Result:${colors.reset}`);
    log('Generated Name', nameResult2.name, colors.green);
    console.log(`${colors.dim}  Reasoning: ${nameResult2.reasoning}${colors.reset}`);
    if (nameResult2.alternatives && nameResult2.alternatives.length > 0) {
      console.log(
        `${colors.dim}  Alternatives: ${nameResult2.alternatives.join(', ')}${colors.reset}`,
      );
    }

    log('Key Point', 'Same VAT agent, same adapter code, different LLM provider!', colors.green);
  }

  // ============================================================================
  // Summary
  // ============================================================================
  section('Summary');

  console.log(
    `${colors.green}✓ Pure Function Tools${colors.reset} - Converted VAT agents to ${adapter.name} tools`,
  );
  console.log(`${colors.green}✓ Batch Conversion${colors.reset} - Multiple tools in one call`);
  if (adapter.demoToolCalling) {
    console.log(
      `${colors.green}✓ LLM Tool Calling${colors.reset} - Tools work with LLM for function calling`,
    );
  }
  console.log(
    `${colors.green}✓ LLM Analyzers${colors.reset} - Direct function execution with structured I/O`,
  );
  if (adapter.createSecondaryLLMConfig) {
    console.log(`${colors.green}✓ Provider Agnostic${colors.reset} - Works with multiple LLM providers`);
  }

  console.log('\n' + colors.dim + 'Architecture:' + colors.reset);
  console.log(
    `${colors.dim}  VAT Agent (portable) → ${adapter.name} Adapter → ${adapter.name} → LLM Provider${colors.reset}`,
  );

  console.log(
    '\n' + colors.dim + 'See README.md for complete API reference and more examples' + colors.reset,
  );
}
