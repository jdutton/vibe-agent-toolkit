/**
 * Demo: LLM Agents with Vercel AI SDK Runtime
 *
 * This demo focuses on how VAT LLM-based agents work with the Vercel AI SDK adapter.
 * It shows the flow from agent definition → adapter → real LLM calls → structured output.
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 *
 * Run with: source ~/.secrets.env && bun run llm-demo
 */

import { openai } from '@ai-sdk/openai';
import {
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  nameGeneratorAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';

import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';

import { colors, log, section } from './demo-helpers.js';

async function demo() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   LLM Agent Demo: VAT + Vercel AI SDK Runtime Adapter               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // ============================================================================
  // STEP 1: Understanding the VAT Agent
  // ============================================================================
  section('Step 1: Understanding the VAT LLM Analyzer Agent');

  log('Agent', 'nameGeneratorAgent', colors.cyan);
  console.log(`${colors.dim}  Archetype: ${nameGeneratorAgent.manifest.archetype}${colors.reset}`);
  console.log(`${colors.dim}  Description: ${nameGeneratorAgent.manifest.description}${colors.reset}`);
  console.log(`${colors.dim}  Version: ${nameGeneratorAgent.manifest.version}${colors.reset}`);

  console.log(`\n${colors.yellow}How it works:${colors.reset}`);
  console.log(`${colors.dim}  1. Agent defines input/output schemas (Zod)${colors.reset}`);
  console.log(`${colors.dim}  2. Agent has execute(input, context) method${colors.reset}`);
  console.log(`${colors.dim}  3. Context provides callLLM() function${colors.reset}`);
  console.log(`${colors.dim}  4. Agent constructs prompt and calls LLM${colors.reset}`);
  console.log(`${colors.dim}  5. Agent parses LLM response to structured output${colors.reset}`);

  console.log(`\n${colors.yellow}Agent Signature:${colors.reset}`);
  console.log(`${colors.dim}  Input: NameGeneratorInput${colors.reset}`);
  console.log(`${colors.dim}    - characteristics: CatCharacteristics${colors.reset}`);
  console.log(`${colors.dim}    - strategy?: 'safe' | 'risky' | 'mixed'${colors.reset}`);
  console.log(`${colors.dim}  Output: NameSuggestion${colors.reset}`);
  console.log(`${colors.dim}    - name: string${colors.reset}`);
  console.log(`${colors.dim}    - reasoning: string${colors.reset}`);
  console.log(`${colors.dim}    - alternatives: string[]${colors.reset}`);

  // ============================================================================
  // STEP 2: Converting to Vercel AI SDK Function
  // ============================================================================
  section('Step 2: Converting to Vercel AI SDK Function');

  log('Adapter', 'convertLLMAnalyzerToFunction()', colors.cyan);
  console.log(`${colors.dim}  Takes: VAT Agent + Schemas + LLM Config${colors.reset}`);
  console.log(`${colors.dim}  Returns: Async function with full type safety${colors.reset}`);

  console.log(`\n${colors.yellow}Configuration:${colors.reset}`);
  console.log(`${colors.dim}  Model: OpenAI GPT-4o-mini${colors.reset}`);
  console.log(`${colors.dim}  Temperature: 0.9 (high creativity)${colors.reset}`);

  const generateName = convertLLMAnalyzerToFunction(
    nameGeneratorAgent,
    NameGeneratorInputSchema,
    NameSuggestionSchema,
    {
      model: openai('gpt-4o-mini'),
      temperature: 0.9,
    },
  );

  log('Success', 'Created generateName() function', colors.green);
  console.log(`${colors.dim}  Type: (input: NameGeneratorInput) => Promise<NameSuggestion>${colors.reset}`);

  // ============================================================================
  // STEP 3: Using the Generated Function
  // ============================================================================
  section('Step 3: Making Real LLM Calls');

  log('Input', 'Preparing cat characteristics...', colors.cyan);

  const input = {
    characteristics: {
      physical: {
        furColor: 'Orange',
        size: 'medium' as const,
        breed: 'Tabby',
      },
      behavioral: {
        personality: ['Lazy', 'Food-obsessed', 'Entitled'],
        quirks: ['Yells for food at 5am', 'Knocks water bowls over', 'Sleeps 20 hours a day'],
      },
      description: 'A magnificently lazy orange tabby who believes humans exist solely to serve them food',
    },
  };

  console.log(`\n${colors.yellow}Cat Description:${colors.reset}`);
  console.log(`${colors.dim}  Color: ${input.characteristics.physical.furColor}${colors.reset}`);
  console.log(`${colors.dim}  Size: ${input.characteristics.physical.size}${colors.reset}`);
  console.log(`${colors.dim}  Personality: ${input.characteristics.behavioral.personality.join(', ')}${colors.reset}`);
  console.log(`${colors.dim}  Quirks:${colors.reset}`);
  for (const quirk of input.characteristics.behavioral.quirks) {
    console.log(`${colors.dim}    • ${quirk}${colors.reset}`);
  }

  log('LLM Call', 'Calling OpenAI GPT-4o-mini...', colors.yellow);
  console.log(`${colors.dim}  (This makes a real API call)${colors.reset}`);

  const result = await generateName(input);

  // ============================================================================
  // STEP 4: Structured Output from LLM
  // ============================================================================
  section('Step 4: Structured Output from LLM');

  log('Result', 'LLM response parsed to structured output', colors.green);

  console.log(`\n${colors.bright}Generated Name:${colors.reset} ${colors.green}${result.name}${colors.reset}`);

  console.log(`\n${colors.yellow}Reasoning:${colors.reset}`);
  console.log(`${colors.dim}${result.reasoning}${colors.reset}`);

  if (result.alternatives && result.alternatives.length > 0) {
    console.log(`\n${colors.yellow}Alternative Names:${colors.reset}`);
    for (const altName of result.alternatives) {
      console.log(`${colors.dim}  • ${altName}${colors.reset}`);
    }
  }

  console.log(`\n${colors.yellow}Type Safety:${colors.reset}`);
  console.log(`${colors.dim}  ✓ Input validated with Zod schema${colors.reset}`);
  console.log(`${colors.dim}  ✓ Output validated with Zod schema${colors.reset}`);
  console.log(`${colors.dim}  ✓ Full TypeScript type inference${colors.reset}`);

  // ============================================================================
  // STEP 5: What Happened Under the Hood
  // ============================================================================
  section('Step 5: What Happened Under the Hood');

  console.log(`${colors.yellow}1. Adapter created context:${colors.reset}`);
  console.log(`${colors.dim}   context = {${colors.reset}`);
  console.log(`${colors.dim}     mockable: false,${colors.reset}`);
  console.log(`${colors.dim}     model: 'gpt-4o-mini',${colors.reset}`);
  console.log(`${colors.dim}     temperature: 0.9,${colors.reset}`);
  console.log(`${colors.dim}     callLLM: async (prompt) => { /* uses generateText() */ }${colors.reset}`);
  console.log(`${colors.dim}   }${colors.reset}`);

  console.log(`\n${colors.yellow}2. Agent executed with context:${colors.reset}`);
  console.log(`${colors.dim}   const output = await agent.execute(input, context)${colors.reset}`);

  console.log(`\n${colors.yellow}3. Agent built prompt from input:${colors.reset}`);
  console.log(`${colors.dim}   prompt = \`Generate a noble name for a cat with...${colors.reset}`);
  console.log(`${colors.dim}             Personality: Lazy, Food-obsessed, Entitled${colors.reset}`);
  console.log(`${colors.dim}             Quirks: Yells for food at 5am...\`${colors.reset}`);

  console.log(`\n${colors.yellow}4. Agent called LLM via context.callLLM():${colors.reset}`);
  console.log(`${colors.dim}   const response = await context.callLLM(prompt)${colors.reset}`);

  console.log(`\n${colors.yellow}5. Adapter used Vercel AI SDK generateText():${colors.reset}`);
  console.log(`${colors.dim}   const result = await generateText({${colors.reset}`);
  console.log(`${colors.dim}     model: openai('gpt-4o-mini'),${colors.reset}`);
  console.log(`${colors.dim}     temperature: 0.9,${colors.reset}`);
  console.log(`${colors.dim}     prompt: prompt${colors.reset}`);
  console.log(`${colors.dim}   })${colors.reset}`);
  console.log(`${colors.dim}   return result.text${colors.reset}`);

  console.log(`\n${colors.yellow}6. Agent parsed LLM response:${colors.reset}`);
  console.log(`${colors.dim}   return {${colors.reset}`);
  console.log(`${colors.dim}     name: '${result.name}',${colors.reset}`);
  console.log(`${colors.dim}     reasoning: '...',${colors.reset}`);
  console.log(`${colors.dim}     alternatives: [...]${colors.reset}`);
  console.log(`${colors.dim}   }${colors.reset}`);

  console.log(`\n${colors.yellow}7. Adapter validated output:${colors.reset}`);
  console.log(`${colors.dim}   return outputSchema.parse(output) // Zod validation${colors.reset}`);

  // ============================================================================
  // Summary
  // ============================================================================
  section('Summary: The Full Flow');

  console.log(`${colors.green}VAT Agent (portable)${colors.reset}`);
  console.log(`${colors.dim}  ↓ defines prompt construction logic${colors.reset}`);
  console.log(`${colors.green}Runtime Adapter${colors.reset}`);
  console.log(`${colors.dim}  ↓ provides context.callLLM()${colors.reset}`);
  console.log(`${colors.green}Vercel AI SDK generateText()${colors.reset}`);
  console.log(`${colors.dim}  ↓ makes actual API call${colors.reset}`);
  console.log(`${colors.green}OpenAI GPT-4o-mini${colors.reset}`);
  console.log(`${colors.dim}  ↓ generates response${colors.reset}`);
  console.log(`${colors.green}Structured Output${colors.reset}`);
  console.log(`${colors.dim}  ↓ validated with Zod${colors.reset}`);
  console.log(`${colors.green}Type-safe Result${colors.reset}`);

  console.log(`\n${colors.yellow}Key Benefits:${colors.reset}`);
  console.log(`${colors.dim}  ✓ Agent code is portable (works with any runtime)${colors.reset}`);
  console.log(`${colors.dim}  ✓ Adapter handles LLM provider integration${colors.reset}`);
  console.log(`${colors.dim}  ✓ Full type safety from input to output${colors.reset}`);
  console.log(`${colors.dim}  ✓ Schema validation at runtime${colors.reset}`);
  console.log(`${colors.dim}  ✓ Easy to swap LLM providers (OpenAI → Anthropic → Google)${colors.reset}`);

  console.log('\n' + colors.dim + 'Source: packages/runtime-vercel-ai-sdk/examples/llm-agent-demo.ts' + colors.reset + '\n');
}

// Run the demo
await demo();
