/**
 * CLI transport for conversational agents.
 *
 * Provides an interactive command-line interface with:
 * - Conversation history
 * - Local session state
 * - Built-in commands (/quit, /state, /restart)
 * - Optional colored output
 */

import * as readline from 'node:readline';

import type { Message } from '@vibe-agent-toolkit/agent-runtime';

import type { ConversationalFunction, Transport, TransportSessionContext } from './types.js';

/**
 * Options for CLI transport.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CLITransportOptions<TState = any> {
  /** The conversational function to run */
  fn: ConversationalFunction<string, string, TState>;
  /** Session identifier (default: "cli-singleton") */
  sessionId?: string;
  /** Initial conversation history (default: []) */
  initialHistory?: Message[];
  /** Initial session state (default: undefined) */
  initialState?: TState;
  /** Enable colored output (default: true) */
  colors?: boolean;
  /** Show state after each interaction (default: false) */
  showState?: boolean;
  /** Prompt prefix (default: "You: ") */
  prompt?: string;
  /** Assistant prefix (default: "Assistant: ") */
  assistantPrefix?: string;
}

/**
 * CLI transport implementation.
 *
 * Manages a single local session and provides an interactive REPL.
 * Uses in-memory session management for MVP.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class CLITransport<TState = any> implements Transport {
  private readonly fn: ConversationalFunction<string, string, TState>;
  private readonly sessionId: string;
  private conversationHistory: Message[];
  private state: TState;
  private readonly colors: boolean;
  private readonly showState: boolean;
  private readonly prompt: string;
  private readonly assistantPrefix: string;
  private rl: readline.Interface | null = null;

  constructor(options: CLITransportOptions<TState>) {
    this.fn = options.fn;
    this.sessionId = options.sessionId ?? 'cli-singleton';
    this.conversationHistory = options.initialHistory ?? [];
    this.state = options.initialState ?? (undefined as TState);
    this.colors = options.colors ?? true;
    this.showState = options.showState ?? false;
    this.prompt = options.prompt ?? 'You: ';
    this.assistantPrefix = options.assistantPrefix ?? 'Assistant: ';
  }

  /**
   * Start the CLI transport.
   */
  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.colorize(this.prompt, 'cyan'),
    });

    this.printWelcome();

    this.rl.on('line', (line: string) => {
      void (async () => {
      const input = line.trim();

      if (!input) {
        this.rl?.prompt();
        return;
      }

      // Handle commands
      if (input.startsWith('/')) {
        await this.handleCommand(input);
        this.rl?.prompt();
        return;
      }

      // Process user input
      try {
        // Add user message to history
        this.conversationHistory.push({ role: 'user', content: input });

        // Pass session context (just ID and current state)
        const context: TransportSessionContext<TState> = {
          sessionId: this.sessionId,
          conversationHistory: this.conversationHistory,
          state: this.state,
        };

        const output = await this.fn(input, context);

        // Update session state (function may have mutated context.state)
        this.state = context.state;

        // Add assistant response to history
        this.conversationHistory.push({ role: 'assistant', content: output });

        console.log(this.colorize(this.assistantPrefix, 'green') + output);

        if (this.showState) {
          this.printState();
        }
      } catch (error) {
        console.error(this.colorize('Error: ', 'red') + (error instanceof Error ? error.message : String(error)));
      }

      this.rl?.prompt();
      })();
    });

    this.rl.on('close', () => {
      console.log(this.colorize('\nGoodbye!', 'yellow'));
      process.exit(0);
    });

    this.rl.prompt();
  }

  /**
   * Stop the CLI transport.
   */
  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  /**
   * Handle built-in commands.
   */
  private async handleCommand(cmd: string): Promise<void> {
    const command = cmd.toLowerCase();

    switch (command) {
      case '/quit':
      case '/exit':
        await this.stop();
        break;

      case '/state':
        this.printState();
        break;

      case '/restart':
        this.conversationHistory = [];
        this.state = undefined as TState;
        console.log(this.colorize('Session restarted.', 'yellow'));
        break;

      case '/help':
        this.printHelp();
        break;

      default:
        console.log(this.colorize(`Unknown command: ${cmd}`, 'red'));
        console.log(this.colorize('Type /help for available commands.', 'yellow'));
    }
  }

  /**
   * Print welcome message.
   */
  private printWelcome(): void {
    console.log(this.colorize('=== CLI Transport ===', 'cyan'));
    console.log(this.colorize('Type /help for commands, /quit to exit', 'gray'));
    console.log();
  }

  /**
   * Print help message.
   */
  private printHelp(): void {
    console.log(this.colorize('\nAvailable commands:', 'cyan'));
    console.log(this.colorize('  /help     ', 'yellow') + '- Show this help message');
    console.log(this.colorize('  /state    ', 'yellow') + '- Display current session state');
    console.log(this.colorize('  /restart  ', 'yellow') + '- Restart session (clear history and state)');
    console.log(this.colorize('  /quit     ', 'yellow') + '- Exit the CLI');
    console.log();
  }

  /**
   * Print current session state.
   */
  private printState(): void {
    console.log(this.colorize('\n--- Session State ---', 'cyan'));
    console.log(this.colorize('Session ID: ', 'yellow') + this.sessionId);
    console.log(this.colorize('History length: ', 'yellow') + this.conversationHistory.length);
    console.log(this.colorize('State: ', 'yellow') + JSON.stringify(this.state, null, 2));
    console.log();
  }

  /**
   * Colorize text if colors are enabled.
   */
  private colorize(text: string, color: 'cyan' | 'green' | 'yellow' | 'red' | 'gray'): string {
    if (!this.colors) {
      return text;
    }

    const colors = {
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      gray: '\x1b[90m',
    };

    const reset = '\x1b[0m';
    return colors[color] + text + reset;
  }
}
