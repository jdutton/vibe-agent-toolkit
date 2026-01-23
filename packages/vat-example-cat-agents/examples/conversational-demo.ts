/**
 * Demo: Conversational Assistant - Breed Selection Advisor
 *
 * This demo showcases a multi-turn conversational agent that helps users find
 * their perfect cat breed through natural dialogue. It demonstrates:
 * - Multi-turn conversation with session state management
 * - Natural language factor extraction
 * - Conversation phase transitions (gathering → ready → refining)
 * - Music-based breed matching (CRITICAL factor!)
 * - Personalized recommendations with scoring
 * - Interactive CLI using the transports package
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable (for real LLM calls)
 *
 * Run with: source ~/.secrets.env && bun run demo:conversation
 */

import { openai } from '@ai-sdk/openai';
import { createConversationalContext, type Message } from '@vibe-agent-toolkit/agent-runtime';
import { CLITransport, type Session } from '@vibe-agent-toolkit/transports';
import { streamText } from 'ai';

import { breedAdvisorAgent } from '../src/conversational-assistant/breed-advisor.js';
import type { BreedAdvisorInput, BreedAdvisorOutput, SelectionProfile } from '../src/types/schemas.js';

import { colors, log, section } from './demo-helpers.js';

/**
 * Session state for breed advisor
 */
interface BreedAdvisorState {
  profile: SelectionProfile;
}

/**
 * Wrap the breed advisor agent to work with CLI transport.
 * Converts between transport's Session format and agent's expected format.
 */
function createBreedAdvisorFunction() {
  return async (userMessage: string, session: Session<BreedAdvisorState>) => {
    // Create conversation context for the agent using helper
    const context = createConversationalContext(session.history, async (messages: Message[]) => {
      const vercelMessages = messages.map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      }));

      const result = streamText({
        model: openai('gpt-4o-mini'),
        temperature: 0.7,
        messages: vercelMessages,
      });

      return await result.text;
    });

    // Create agent input
    const agentInput: BreedAdvisorInput = {
      message: userMessage,
      sessionState: session.state ? { profile: session.state.profile } : undefined,
    };

    // Execute agent
    const agentOutput: BreedAdvisorOutput = await breedAdvisorAgent.execute(agentInput, context);

    // Update session state
    const updatedState: BreedAdvisorState = {
      profile: agentOutput.updatedProfile,
    };

    // Format output message
    let outputMessage = agentOutput.reply;

    // Add recommendations if present
    if (agentOutput.recommendations && agentOutput.recommendations.length > 0) {
      outputMessage += '\n\n🎯 Breed Recommendations:\n';
      for (const rec of agentOutput.recommendations) {
        outputMessage += `\n${rec.matchScore}/100 - ${rec.breed}\n`;
        outputMessage += `${rec.reasoning}\n`;
      }
    }

    return {
      output: outputMessage,
      session: {
        history: session.history,
        state: updatedState,
      },
    };
  };
}

/**
 * Main demo function
 */
async function runDemo() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   Conversational Demo: Breed Selection Advisor                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // Check for API key
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  if (!hasApiKey) {
    console.log(`${colors.yellow}⚠️  No OPENAI_API_KEY found. Set environment variable to run real LLM calls.${colors.reset}\n`);
    console.log(`${colors.dim}   Example: source ~/.secrets.env && bun run demo:conversation${colors.reset}\n`);
    return;
  }

  section('Understanding the Breed Advisor Agent');

  log('Agent', breedAdvisorAgent.name, colors.cyan);
  console.log(`${colors.dim}  Archetype: ${breedAdvisorAgent.manifest.archetype}${colors.reset}`);
  console.log(`${colors.dim}  Description: ${breedAdvisorAgent.manifest.description}${colors.reset}`);
  console.log(`${colors.dim}  Version: ${breedAdvisorAgent.manifest.version}${colors.reset}`);

  console.log(`\n${colors.yellow}Key Innovation:${colors.reset}`);
  console.log(`${colors.dim}  Music preference is a CRITICAL factor in breed selection!${colors.reset}`);
  console.log(`${colors.dim}  Each genre aligns with specific breed temperaments through${colors.reset}`);
  console.log(`${colors.dim}  vibrational frequency compatibility. This gets 30 points (2x weight).${colors.reset}`);

  console.log(`\n${colors.yellow}Conversation Phases:${colors.reset}`);
  console.log(`${colors.dim}  gathering           → <4 factors, asking questions${colors.reset}`);
  console.log(`${colors.dim}  ready-to-recommend  → 4-6 factors, can provide initial recommendations${colors.reset}`);
  console.log(`${colors.dim}  refining            → 6+ factors, exploring alternatives${colors.reset}`);

  section('Interactive Conversation Mode');

  console.log(`${colors.yellow}Starting interactive CLI...${colors.reset}`);
  console.log(`${colors.dim}  Type your messages to chat with the breed advisor${colors.reset}`);
  console.log(`${colors.dim}  Commands: /help, /state, /restart, /quit${colors.reset}`);
  console.log();

  // Create conversational function
  const breedAdvisorFn = createBreedAdvisorFunction();

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
    assistantPrefix: '🤖 Breed Advisor: ',
  });

  // Start interactive session
  await transport.start();
}

// Run the demo
await runDemo();
