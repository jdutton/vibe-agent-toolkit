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

import { CLITransport, type Session } from '@vibe-agent-toolkit/transports';

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
    console.log(`${colors.yellow}Usage:${colors.reset}`);
    console.log(`  source ~/.secrets.env && bun run demo:conversation [runtime]`);
    console.log(`\n${colors.yellow}Available runtimes:${colors.reset}`);
    console.log(`  vercel    - Vercel AI SDK (default)`);
    console.log(`  openai    - OpenAI SDK`);
    console.log(`  langchain - LangChain`);
    console.log(`  claude    - Claude Agent SDK`);
    return;
  }

  // Check for API keys
  const needsOpenAI = adapter.name !== 'Claude Agent SDK';
  const needsClaude = adapter.name === 'Claude Agent SDK';

  if (needsOpenAI && !process.env.OPENAI_API_KEY) {
    console.log(
      `${colors.yellow}⚠️  No OPENAI_API_KEY found. Set environment variable to run ${adapter.name}.${colors.reset}\n`,
    );
    console.log(
      `${colors.dim}   Example: source ~/.secrets.env && bun run demo:conversation${colors.reset}\n`,
    );
    return;
  }

  if (needsClaude && !process.env.ANTHROPIC_API_KEY) {
    console.log(
      `${colors.yellow}⚠️  No ANTHROPIC_API_KEY found. Set environment variable to run ${adapter.name}.${colors.reset}\n`,
    );
    console.log(
      `${colors.dim}   Example: source ~/.secrets.env && bun run demo:conversation claude${colors.reset}\n`,
    );
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

  section('Interactive Conversation Mode');

  console.log(`${colors.yellow}Starting interactive CLI...${colors.reset}`);
  console.log(`${colors.dim}  Type your messages to chat with the breed advisor${colors.reset}`);
  console.log(`${colors.dim}  Commands: /help, /state, /restart, /quit${colors.reset}`);
  console.log();

  // Wrap adapter's convertToFunction to format output for CLI
  const breedAdvisorFn = async (userMessage: string, session: Session<BreedAdvisorState>) => {
    const result = await adapter.convertToFunction(userMessage, session);

    // Check if conversation is complete
    if (result.output.updatedProfile.conversationPhase === 'completed') {
      // Agent has concluded - add goodbye message and signal to exit
      const output = result.output.reply + '\n\n' + colors.yellow + 'Session complete. Thanks for using the breed advisor!' + colors.reset;

      // Return the output, then exit gracefully after a short delay
      setTimeout(() => {
        console.log(); // Empty line for spacing
        process.exit(0);
      }, 500);

      return {
        output,
        session: result.session,
      };
    }

    // Normal conversation - agent presents recommendations conversationally
    return {
      output: result.output.reply,
      session: result.session,
    };
  };

  // Create CLI transport
  const transport = new CLITransport<BreedAdvisorState>({
    fn: breedAdvisorFn,
    initialSession: {
      history: [],
      state: {
        profile: {
          conversationPhase: 'gathering',
        },
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
