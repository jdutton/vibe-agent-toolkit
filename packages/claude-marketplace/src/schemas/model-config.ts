import { z } from 'zod';

export const ClaudeModelConfigSchema = z
  .object({
    model: z.string().optional(),
    availableModels: z.array(z.string()).optional(),
  })
  .passthrough();

export type ClaudeModelConfig = z.infer<typeof ClaudeModelConfigSchema>;
