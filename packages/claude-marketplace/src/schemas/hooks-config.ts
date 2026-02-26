import { z } from 'zod';

export const HooksConfigSchema = z
  .object({
    PreToolUse: z.array(z.unknown()).optional(),
    PostToolUse: z.array(z.unknown()).optional(),
    Notification: z.array(z.unknown()).optional(),
    Stop: z.array(z.unknown()).optional(),
    SubagentStop: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type HooksConfig = z.infer<typeof HooksConfigSchema>;
