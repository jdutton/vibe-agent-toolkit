import * as readline from 'node:readline';

import { executeExternalEvent, validateAgentInput } from '@vibe-agent-toolkit/agent-runtime';
import type {
  Agent,
  ExternalEventError,
  OneShotAgentOutput,
} from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

/**
 * Constants for duplicated strings
 * @internal
 */
const EVENT_INVALID_RESPONSE: ExternalEventError = 'event-invalid-response';
const AUTO_APPROVED_MESSAGE = 'Auto-approved (test mode)';
const AUTO_REJECTED_MESSAGE = 'Auto-rejected (test mode)';
const AUTO_SELECTED_MESSAGE = 'Auto-selected (test mode)';
const APPROVAL_REQUEST_CONTEXT = 'Approval request';
const CHOICE_REQUEST_CONTEXT = 'Choice request';
const CUSTOM_APPROVAL_REQUEST_CONTEXT = 'Custom approval request';
const EXTERNAL_EVENT_INTEGRATOR_ARCHETYPE = 'external-event-integrator';
const TIMEOUT_MS_DESCRIPTION = 'Timeout in milliseconds';

/**
 * Input schema for approval requests
 */
export const ApprovalRequestInputSchema = z.object({
  prompt: z.string().describe('The question to ask the human'),
  context: z.record(z.unknown()).optional().describe('Additional context to display'),
  autoResponse: z.union([z.literal('approve'), z.literal('reject')]).optional().describe('Auto-response for testing'),
  timeoutMs: z.number().optional().describe(TIMEOUT_MS_DESCRIPTION),
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
  autoResponse: z.string().optional().describe('Auto-response for testing (option value)'),
  timeoutMs: z.number().optional().describe(TIMEOUT_MS_DESCRIPTION),
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
  autoResponse: z.string().optional().describe('Auto-response for testing'),
  timeoutMs: z.number().optional().describe(TIMEOUT_MS_DESCRIPTION),
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
      reason: autoResponse === 'approve' ? AUTO_APPROVED_MESSAGE : AUTO_REJECTED_MESSAGE,
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
      reason: validation.valid ? AUTO_APPROVED_MESSAGE : validation.error ?? AUTO_REJECTED_MESSAGE,
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
        reason: AUTO_SELECTED_MESSAGE,
      };
    }

    // Try case-insensitive match
    const match = options.find((opt) => opt.toLowerCase() === autoResponse.toLowerCase());
    if (match) {
      return {
        approved: true,
        choice: match,
        reason: AUTO_SELECTED_MESSAGE,
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
          return { valid: true, value: option };
        }
      }

      // Try to match text
      const match = options.find((opt) => opt.toLowerCase() === response.toLowerCase());
      if (match !== undefined) {
        return { valid: true, value: match };
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
export const requestApprovalAgent: Agent<
  ApprovalRequestInput,
  OneShotAgentOutput<ApprovalResult, ExternalEventError>
> = {
  name: 'request-approval',
  manifest: {
    name: 'request-approval',
    version: '1.0.0',
    description: 'Requests human approval for a yes/no decision',
    archetype: EXTERNAL_EVENT_INTEGRATOR_ARCHETYPE,
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
      timeoutMs: 60000,
    },
  },
  execute: async (input: ApprovalRequestInput) => {
    const validatedOrError = validateAgentInput<ApprovalRequestInput, ApprovalResult, ExternalEventError>(
      input,
      ApprovalRequestInputSchema,
      EVENT_INVALID_RESPONSE
    );
    if ('result' in validatedOrError) {
      return validatedOrError;
    }

    const { prompt, context, autoResponse, timeoutMs = 60000 } = validatedOrError;

    // Convert autoResponse to ApprovalResult for executeExternalEvent
    const autoResponseData: ApprovalResult = autoResponse
      ? {
          approved: autoResponse === 'approve',
          reason: autoResponse === 'approve' ? AUTO_APPROVED_MESSAGE : AUTO_REJECTED_MESSAGE,
        }
      : ({} as ApprovalResult); // Placeholder, will be handled by executeExternalEvent

    return executeExternalEvent<ApprovalResult>({
      ...(autoResponse && { autoResponse: autoResponseData }),
      handler: async () => requestApproval(prompt, context, autoResponse ? { autoResponse } : { timeoutMs }),
      timeoutMs,
      errorContext: APPROVAL_REQUEST_CONTEXT,
    });
  },
};

/**
 * Request choice agent
 *
 * Presents multiple options and asks human to choose one.
 */
export const requestChoiceAgent: Agent<
  ChoiceRequestInput,
  OneShotAgentOutput<ChoiceResult, ExternalEventError>
> = {
  name: 'request-choice',
  manifest: {
    name: 'request-choice',
    version: '1.0.0',
    description: 'Presents multiple options and asks human to choose one',
    archetype: EXTERNAL_EVENT_INTEGRATOR_ARCHETYPE,
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
      timeoutMs: 60000,
    },
  },
  execute: async (input: ChoiceRequestInput) => {
    const validatedOrError = validateAgentInput<ChoiceRequestInput, ChoiceResult, ExternalEventError>(
      input,
      ChoiceRequestInputSchema,
      EVENT_INVALID_RESPONSE
    );
    if ('result' in validatedOrError) {
      return validatedOrError;
    }

    const { prompt, options, autoResponse, timeoutMs = 60000 } = validatedOrError;

    // Convert autoResponse to ChoiceResult for executeExternalEvent
    const autoResponseData: ChoiceResult = autoResponse
      ? {
          approved: options.includes(autoResponse),
          choice: autoResponse,
          reason: options.includes(autoResponse)
            ? AUTO_SELECTED_MESSAGE
            : `Invalid auto-response: ${autoResponse}`,
        }
      : ({} as ChoiceResult); // Placeholder, will be handled by executeExternalEvent

    return executeExternalEvent<ChoiceResult>({
      ...(autoResponse && { autoResponse: autoResponseData }),
      handler: async () => requestChoice(prompt, options, autoResponse ? { autoResponse } : { timeoutMs }),
      timeoutMs,
      errorContext: CHOICE_REQUEST_CONTEXT,
    });
  },
};

/**
 * Request custom approval agent
 *
 * Requests approval with custom validation logic.
 * Note: This is a simplified version - full implementation would need validator function.
 */
export const requestCustomApprovalAgent: Agent<
  CustomApprovalRequestInput,
  OneShotAgentOutput<CustomApprovalResult, ExternalEventError>
> = {
  name: 'request-custom-approval',
  manifest: {
    name: 'request-custom-approval',
    version: '1.0.0',
    description: 'Requests approval with custom validation logic',
    archetype: EXTERNAL_EVENT_INTEGRATOR_ARCHETYPE,
    metadata: {
      integrationTypes: ['CLI', 'Slack', 'Email', 'Web UI'],
      blocking: true,
      requiresValidator: true,
      timeoutMs: 60000,
    },
  },
  execute: async (input: CustomApprovalRequestInput) => {
    const validatedOrError = validateAgentInput<CustomApprovalRequestInput, CustomApprovalResult, ExternalEventError>(
      input,
      CustomApprovalRequestInputSchema,
      EVENT_INVALID_RESPONSE
    );
    if ('result' in validatedOrError) {
      return validatedOrError;
    }

    const { prompt, autoResponse, timeoutMs = 60000 } = validatedOrError;

    // Simplified implementation - just do yes/no approval
    // Full implementation would need validator function passed through context
    const autoResponseData: CustomApprovalResult = autoResponse
      ? {
          approved: autoResponse.toLowerCase() === 'yes' || autoResponse.toLowerCase() === 'y',
          value: autoResponse,
          reason: autoResponse.toLowerCase() === 'yes' || autoResponse.toLowerCase() === 'y'
            ? AUTO_APPROVED_MESSAGE
            : AUTO_REJECTED_MESSAGE,
        }
      : ({} as CustomApprovalResult); // Placeholder

    return executeExternalEvent<CustomApprovalResult>({
      ...(autoResponse && { autoResponse: autoResponseData }),
      handler: async () => {
        const result = await requestApproval(prompt, undefined, autoResponse ? { autoResponse: autoResponse as 'approve' | 'reject' } : { timeoutMs });
        return {
          approved: result.approved,
          reason: result.reason ?? 'No reason provided',
          value: result.approved ? 'approved' : undefined,
        };
      },
      timeoutMs,
      errorContext: CUSTOM_APPROVAL_REQUEST_CONTEXT,
    });
  },
};
