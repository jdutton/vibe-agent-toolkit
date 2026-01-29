/**
 * Demo: Conversational Assistant - Breed Selection Advisor (Multi-Runtime)
 *
 * This demo showcases a multi-turn conversational agent that helps users find
 * their perfect cat breed through natural dialogue. It demonstrates:
 * - Multi-turn conversation with session state management
 * - Natural language factor extraction
 * - Conversation phase transitions (gathering → ready → refining)
 * - Music-based breed matching (CRITICAL factor!)
 * - Personalized recommendations with scoring
 * - Interactive CLI using the transports package
 * - Runtime portability (works with all 4 runtimes)
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable (for OpenAI-based runtimes)
 * - ANTHROPIC_API_KEY environment variable (for Claude Agent SDK runtime)
 *
 * Run with:
 *   source ~/.secrets.env && bun run demo:conversation
 *   source ~/.secrets.env && bun run demo:conversation vercel
 *   source ~/.secrets.env && bun run demo:conversation openai
 *   source ~/.secrets.env && bun run demo:conversation langchain
 *   source ~/.secrets.env && bun run demo:conversation claude
 */

import { CLITransport, type TransportSessionContext } from '@vibe-agent-toolkit/transports';

import { breedAdvisorAgent } from '../src/conversational-assistant/breed-advisor.js';
import type { BreedAdvisorOutput, SelectionProfile } from '../src/types/schemas.js';

import { createClaudeAgentSDKAdapter } from './conversational-adapters/claude-agent-sdk-adapter.js';
import { createLangChainAdapter } from './conversational-adapters/langchain-adapter.js';
import { createOpenAIAdapter } from './conversational-adapters/openai-adapter.js';
import { createVercelAISDKAdapter } from './conversational-adapters/vercel-ai-sdk-adapter.js';
import type { ConversationalRuntimeAdapter } from './conversational-runtime-adapter.js';
import { colors, log, section } from './demo-helpers.js';

/**
 * Session state for breed advisor
 */
interface BreedAdvisorState {
  profile: SelectionProfile;
}

/**
 * Available runtime options
 */
type RuntimeType = 'vercel' | 'openai' | 'langchain' | 'claude';

/**
 * Get runtime adapter based on command line argument or environment
 */
function getRuntimeAdapter(runtimeType?: RuntimeType): ConversationalRuntimeAdapter<
  BreedAdvisorOutput,
  BreedAdvisorState
> {
  const runtime = runtimeType ?? (process.argv[2] as RuntimeType | undefined) ?? 'vercel';

  switch (runtime) {
    case 'vercel':
      return createVercelAISDKAdapter();
    case 'openai':
      return createOpenAIAdapter();
    case 'langchain':
      return createLangChainAdapter();
    case 'claude':
      return createClaudeAgentSDKAdapter();
    default:
      throw new Error(
        `Unknown runtime: ${runtime}. Valid options: vercel, openai, langchain, claude`,
      );
  }
}

/**
 * Display runtime usage instructions
 */
function showRuntimeUsage() {
  console.log(`${colors.yellow}Usage:${colors.reset}`);
  console.log(`  source ~/.secrets.env && bun run demo:conversation [runtime]`);
  console.log(`\n${colors.yellow}Available runtimes:${colors.reset}`);
  console.log(`  vercel    - Vercel AI SDK (default)`);
  console.log(`  openai    - OpenAI SDK`);
  console.log(`  langchain - LangChain`);
  console.log(`  claude    - Claude Agent SDK`);
}

/**
 * Display agent information
 */
function showAgentInfo() {
  section('Understanding the Breed Advisor Agent');

  log('Agent', breedAdvisorAgent.name, colors.cyan);
  console.log(`${colors.dim}  Archetype: ${breedAdvisorAgent.manifest.archetype}${colors.reset}`);
  console.log(
    `${colors.dim}  Description: ${breedAdvisorAgent.manifest.description}${colors.reset}`,
  );
  console.log(`${colors.dim}  Version: ${breedAdvisorAgent.manifest.version}${colors.reset}`);

  console.log(`\n${colors.yellow}Key Innovation:${colors.reset}`);
  console.log(
    `${colors.dim}  Music preference is a CRITICAL factor in breed selection!${colors.reset}`,
  );
  console.log(
    `${colors.dim}  Each genre aligns with specific breed temperaments through${colors.reset}`,
  );
  console.log(
    `${colors.dim}  vibrational frequency compatibility. This gets 30 points (2x weight).${colors.reset}`,
  );

  console.log(`\n${colors.yellow}Conversation Phases:${colors.reset}`);
  console.log(`${colors.dim}  gathering           → <4 factors, asking questions${colors.reset}`);
  console.log(
    `${colors.dim}  ready-to-recommend  → 4-6 factors, can provide initial recommendations${colors.reset}`,
  );
  console.log(
    `${colors.dim}  refining            → 6+ factors, exploring alternatives${colors.reset}`,
  );
}

/**
 * Check API keys and show warning if missing
 */
function checkAPIKeys(adapter: ConversationalRuntimeAdapter<BreedAdvisorOutput, BreedAdvisorState>): boolean {
  const needsOpenAI = adapter.name !== 'Claude Agent SDK';
  const needsClaude = adapter.name === 'Claude Agent SDK';

  if (needsOpenAI && !process.env.OPENAI_API_KEY) {
    console.log(
      `${colors.yellow}⚠️  No OPENAI_API_KEY found. Set environment variable to run ${adapter.name}.${colors.reset}\n`,
    );
    console.log(
      `${colors.dim}   Example: source ~/.secrets.env && bun run demo:conversation${colors.reset}\n`,
    );
    return false;
  }

  if (needsClaude && !process.env.ANTHROPIC_API_KEY) {
    console.log(
      `${colors.yellow}⚠️  No ANTHROPIC_API_KEY found. Set environment variable to run ${adapter.name}.${colors.reset}\n`,
    );
    console.log(
      `${colors.dim}   Example: source ~/.secrets.env && bun run demo:conversation claude${colors.reset}\n`,
    );
    return false;
  }

  return true;
}

/**
 * Main demo function
 */
async function runDemo() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   Conversational Demo: Breed Selection Advisor (Multi-Runtime)      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // Get runtime adapter
  let adapter: ConversationalRuntimeAdapter<BreedAdvisorOutput, BreedAdvisorState>;
  try {
    adapter = getRuntimeAdapter();
  } catch (error) {
    console.log(
      `${colors.red}Error: ${error instanceof Error ? error.message : String(error)}${colors.reset}\n`,
    );
    showRuntimeUsage();
    return;
  }

  // Check for API keys
  if (!checkAPIKeys(adapter)) {
    return;
  }

  section(`Using Runtime: ${adapter.name}`);

  console.log(`${colors.green}✓ Runtime loaded successfully${colors.reset}`);
  console.log(
    `${colors.dim}  This demo uses ${adapter.name} to execute the breed advisor agent.${colors.reset}`,
  );
  console.log(
    `${colors.dim}  The same agent code works with all 4 runtimes - portability!${colors.reset}`,
  );

  showAgentInfo();

  section('Interactive Conversation Mode');

  console.log(`${colors.yellow}Starting interactive CLI...${colors.reset}`);
  console.log(`${colors.dim}  Type your messages to chat with the breed advisor${colors.reset}`);
  console.log(`${colors.dim}  Commands: /help, /state, /restart, /quit${colors.reset}`);
  console.log();

  // Store the last result for display after quit
  let lastResult: BreedAdvisorOutput | undefined;

  // Wrap adapter's convertToFunction to format output for CLI
  const breedAdvisorFn = async (userMessage: string, context: TransportSessionContext<BreedAdvisorState>) => {
    const result = await adapter.convertToFunction(userMessage, context);
    lastResult = result;

    // Check if conversation is complete (user selected a breed)
    const isComplete = result.sessionState.conversationPhase === 'completed' ||
                       result.result.status === 'success';

    if (isComplete) {
      // Show clear visual indicator that breed was selected
      const indicator = `\n${colors.green}${colors.bright}✨ BREED SELECTED! ✨${colors.reset}`;
      let selectedBreed = 'Unknown';

      if (result.result?.status === 'success' && result.result.data?.selectedBreed) {
        selectedBreed = result.result.data.selectedBreed;
      }

      const selectionInfo = `${colors.cyan}${colors.bright}Your choice: ${selectedBreed}${colors.reset}`;
      const quitPrompt = `${colors.dim}Type /quit to see full results and exit${colors.reset}\n`;

      return result.reply + '\n' + indicator + '\n' + selectionInfo + '\n' + quitPrompt;
    }

    // Normal conversation - agent presents recommendations conversationally
    return result.reply;
  };

  // Hook into process exit to show results before CLI transport kills process
  // Must use 'exit' event which fires when process.exit() is called
  const separator = '═══════════════════════════════════════════════════════════\n';

  process.once('exit', () => {
    if (lastResult) {
      // Synchronous output only in exit handler
      process.stdout.write('\n\n');
      process.stdout.write(separator);
      process.stdout.write('               FINAL RESULTS\n');
      process.stdout.write(separator + '\n');
      process.stdout.write(`Conversation Phase: ${lastResult.sessionState.conversationPhase}\n`);
      process.stdout.write(`Status: ${lastResult.result.status}\n`);

      if (lastResult.result.status === 'success' && lastResult.result.data?.selectedBreed) {
        process.stdout.write(`\nSelected Breed: ${lastResult.result.data.selectedBreed}\n`);
      }

      process.stdout.write('\nYour Profile:\n');
      if (lastResult.sessionState.livingSpace) process.stdout.write(`  🏠 Living Space: ${lastResult.sessionState.livingSpace}\n`);
      if (lastResult.sessionState.musicPreference) process.stdout.write(`  🎵 Music: ${lastResult.sessionState.musicPreference}\n`);
      if (lastResult.sessionState.activityLevel) process.stdout.write(`  ⚡ Activity Level: ${lastResult.sessionState.activityLevel}\n`);
      if (lastResult.sessionState.groomingTolerance) process.stdout.write(`  ✂️  Grooming: ${lastResult.sessionState.groomingTolerance}\n`);

      process.stdout.write('\nRaw JSON Output:\n');
      process.stdout.write(JSON.stringify(lastResult, null, 2) + '\n');
      process.stdout.write('\n' + separator + '\n');
    }
  });

  // Create CLI transport
  const transport = new CLITransport<BreedAdvisorState>({
    fn: breedAdvisorFn,
    sessionId: 'breed-advisor-demo',
    initialHistory: [],
    initialState: {
      profile: {
        conversationPhase: 'gathering',
      },
    },
    colors: true,
    showState: false,
    prompt: '🐱 You: ',
    assistantPrefix: `🤖 Breed Advisor (${adapter.name}): `,
  });

  // Start interactive session
  await transport.start();
}

// Run the demo
await runDemo();
