import * as readline from 'node:readline';

import { defineExternalEventIntegrator, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

/**
 * Input schema for approval requests
 */
export const ApprovalRequestInputSchema = z.object({
  prompt: z.string().describe('The question to ask the human'),
  context: z.record(z.unknown()).optional().describe('Additional context to display'),
});

export type ApprovalRequestInput = z.infer<typeof ApprovalRequestInputSchema>;

/**
 * Output schema for approval results
 */
export const ApprovalResultSchema = z.object({
  approved: z.boolean().describe('Whether the request was approved'),
  reason: z.string().optional().describe('Reason for the decision'),
  timedOut: z.boolean().optional().describe('Whether the request timed out'),
});

export type ApprovalResult = z.infer<typeof ApprovalResultSchema>;

/**
 * Input schema for choice requests
 */
export const ChoiceRequestInputSchema = z.object({
  prompt: z.string().describe('The question to ask'),
  options: z.array(z.string()).describe('Array of options to choose from'),
});

export type ChoiceRequestInput = z.infer<typeof ChoiceRequestInputSchema>;

/**
 * Output schema for choice results
 */
export const ChoiceResultSchema = z.object({
  approved: z.boolean().describe('Whether a choice was made'),
  choice: z.string().optional().describe('The selected option'),
  reason: z.string().describe('Reason for result'),
});

export type ChoiceResult = z.infer<typeof ChoiceResultSchema>;

/**
 * Input schema for custom approval requests
 */
export const CustomApprovalRequestInputSchema = z.object({
  prompt: z.string().describe('The question to ask'),
});

export type CustomApprovalRequestInput = z.infer<typeof CustomApprovalRequestInputSchema>;

/**
 * Output schema for custom approval results
 */
export const CustomApprovalResultSchema = z.object({
  approved: z.boolean().describe('Whether the input was valid'),
  value: z.unknown().optional().describe('The validated value'),
  reason: z.string().describe('Reason for result'),
});

export type CustomApprovalResult = z.infer<typeof CustomApprovalResultSchema>;

/**
 * Configuration for human approval gate
 */
export interface HumanApprovalOptions {
  /**
   * Timeout in milliseconds (0 = no timeout)
   * @default 0
   */
  timeoutMs?: number;

  /**
   * What to do if timeout occurs
   * @default 'reject'
   */
  onTimeout?: 'approve' | 'reject';

  /**
   * For testing: auto-approve/reject without prompting
   */
  autoResponse?: 'approve' | 'reject';
}


/**
 * Requests human approval for a decision.
 *
 * Archetype: External Event Integrator
 *
 * This agent integrates with an external system (human input via CLI).
 * In production, this could be:
 * - A web UI approval workflow
 * - A Slack approval bot
 * - An email-based approval system
 * - A ticketing system integration
 *
 * For now, it prompts via CLI.
 *
 * @param prompt - The question to ask the human
 * @param context - Additional context to display (optional)
 * @param options - Configuration options
 * @returns Approval result
 */
export async function requestApproval(
  prompt: string,
  context?: Record<string, unknown>,
  options: HumanApprovalOptions = {},
): Promise<ApprovalResult> {
  const { timeoutMs = 0, onTimeout = 'reject', autoResponse } = options;

  // Auto-response for testing
  if (autoResponse) {
    return {
      approved: autoResponse === 'approve',
      reason: autoResponse === 'approve' ? 'Auto-approved (test mode)' : 'Auto-rejected (test mode)',
    };
  }

  // Display context if provided
  if (context) {
    console.log('\n=== Approval Request Context ===');
    for (const [key, value] of Object.entries(context)) {
      console.log(`${key}: ${JSON.stringify(value, null, 2)}`);
    }
    console.log('================================\n');
  }

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Wrap in promise with optional timeout
  const result = await new Promise<ApprovalResult>((resolve) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Set up timeout if specified
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        rl.close();
        resolve({
          approved: onTimeout === 'approve',
          reason: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        });
      }, timeoutMs);
    }

    // Ask the question
    rl.question(`${prompt} (yes/no): `, (answer) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      rl.close();

      const normalized = answer.trim().toLowerCase();
      const approved = normalized === 'yes' || normalized === 'y';

      resolve({
        approved,
        reason: approved ? 'Approved by user' : 'Rejected by user',
      });
    });
  });

  return result;
}

/**
 * Requests approval with custom validation logic.
 *
 * This variant allows for more complex approval flows where the human
 * can provide additional input beyond just yes/no.
 *
 * @param prompt - The question to ask
 * @param validator - Function to validate the response
 * @param options - Configuration options
 * @returns Validation result
 */
export async function requestCustomApproval<T>(
  prompt: string,
  validator: (response: string) => { valid: boolean; value?: T; error?: string },
  options: Omit<HumanApprovalOptions, 'autoResponse'> & { autoResponse?: string } = {},
): Promise<{ approved: boolean; value?: T; reason: string }> {
  const { timeoutMs = 0, autoResponse } = options;

  // Auto-response for testing
  if (autoResponse) {
    const validation = validator(autoResponse);
    return {
      approved: validation.valid,
      ...(validation.value !== undefined && { value: validation.value }),
      reason: validation.valid ? 'Auto-approved (test mode)' : validation.error ?? 'Auto-rejected (test mode)',
    };
  }

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const result = await new Promise<{ approved: boolean; value?: T; reason: string }>((resolve) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        rl.close();
        resolve({
          approved: false,
          reason: `Timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }

    rl.question(`${prompt}: `, (answer) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      rl.close();

      const validation = validator(answer.trim());

      resolve({
        approved: validation.valid,
        ...(validation.value !== undefined && { value: validation.value }),
        reason: validation.valid
          ? 'Approved by user'
          : validation.error ?? 'Invalid response',
      });
    });
  });

  return result;
}

/**
 * Presents multiple options and asks human to choose one.
 *
 * @param prompt - The question to ask
 * @param options - Array of options to choose from
 * @param config - Configuration options
 * @returns Selected option (or undefined if rejected/timed out)
 */
export async function requestChoice<T extends string>(
  prompt: string,
  options: T[],
  config: Omit<HumanApprovalOptions, 'autoResponse'> & { autoResponse?: T } = {},
): Promise<{ approved: boolean; choice?: T; reason: string }> {
  const { timeoutMs = 0, autoResponse } = config;

  // Auto-response for testing
  if (autoResponse) {
    // Check for exact match first (case-sensitive)
    if (options.includes(autoResponse)) {
      return {
        approved: true,
        choice: autoResponse,
        reason: 'Auto-selected (test mode)',
      };
    }

    // Try case-insensitive match
    const match = options.find((opt) => opt.toLowerCase() === autoResponse.toLowerCase());
    if (match) {
      return {
        approved: true,
        choice: match,
        reason: 'Auto-selected (test mode)',
      };
    }

    // No match found
    return {
      approved: false,
      reason: `Invalid auto-response: ${autoResponse}`,
    };
  }

  // Display options
  console.log(`\n${prompt}`);
  for (const [index, option] of options.entries()) {
    console.log(`  ${index + 1}. ${option}`);
  }

  return requestCustomApproval<T>(
    'Enter your choice (number or text)',
    (response): { valid: boolean; value?: T; error?: string } => {
      // Try to parse as number
      const num = Number.parseInt(response, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
        const option = options[num - 1];
        if (option !== undefined) {
          return { valid: true, ...{ value: option } };
        }
      }

      // Try to match text
      const match = options.find((opt) => opt.toLowerCase() === response.toLowerCase());
      if (match !== undefined) {
        return { valid: true, ...{ value: match } };
      }

      return {
        valid: false,
        error: 'Invalid choice. Please enter a number or option text.',
      };
    },
    { timeoutMs },
  );
}

/**
 * Request approval agent
 *
 * Integrates with external human approval system (CLI in this implementation).
 * In production, this could integrate with Slack, email, web UI, or ticketing systems.
 */
export const requestApprovalAgent: Agent<ApprovalRequestInput, ApprovalResult> = defineExternalEventIntegrator(
  {
    name: 'request-approval',
    description: 'Requests human approval for a yes/no decision',
    version: '1.0.0',
    inputSchema: ApprovalRequestInputSchema,
    outputSchema: ApprovalResultSchema,
    timeoutMs: 60000, // 1 minute default
    onTimeout: 'reject',
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
    },
  },
  async (input, ctx) => {
    // In a real implementation, ctx.emit would send to external system
    // and ctx.waitFor would wait for response via webhooks/polling

    // For now, use the existing CLI implementation
    const options: HumanApprovalOptions = {
      ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
      onTimeout: (ctx.onTimeout as 'approve' | 'reject') ?? 'reject',
    };

    const result = await requestApproval(input.prompt, input.context, options);

    return result;
  },
);

/**
 * Request choice agent
 *
 * Presents multiple options and asks human to choose one.
 */
export const requestChoiceAgent: Agent<ChoiceRequestInput, ChoiceResult> = defineExternalEventIntegrator(
  {
    name: 'request-choice',
    description: 'Presents multiple options and asks human to choose one',
    version: '1.0.0',
    inputSchema: ChoiceRequestInputSchema,
    outputSchema: ChoiceResultSchema,
    timeoutMs: 60000,
    onTimeout: 'reject',
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
    },
  },
  async (input, ctx) => {
    const options: Omit<HumanApprovalOptions, 'autoResponse'> & { autoResponse?: string } = {
      ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
    };

    const result = await requestChoice(input.prompt, input.options as string[], options);

    return result;
  },
);

/**
 * Request custom approval agent
 *
 * Requests approval with custom validation logic.
 * Note: This is a simplified version - full implementation would need validator function.
 */
export const requestCustomApprovalAgent: Agent<CustomApprovalRequestInput, CustomApprovalResult> = defineExternalEventIntegrator(
  {
    name: 'request-custom-approval',
    description: 'Requests approval with custom validation logic',
    version: '1.0.0',
    inputSchema: CustomApprovalRequestInputSchema,
    outputSchema: CustomApprovalResultSchema,
    timeoutMs: 60000,
    onTimeout: 'error',
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
      requiresValidator: true,
    },
  },
  async (input, ctx) => {
    // Simplified implementation - just do yes/no approval
    // Full implementation would need validator function passed through context
    const options: HumanApprovalOptions = {
      ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
    };

    const result = await requestApproval(input.prompt, undefined, options);

    return {
      approved: result.approved,
      reason: result.reason ?? 'No reason provided',
      value: result.approved ? 'approved' : undefined,
    };
  },
);
