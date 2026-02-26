import { z } from 'zod';

export const McpServerPolicySchema = z
  .object({
    name: z.string(),
  })
  .passthrough();

export type McpServerPolicy = z.infer<typeof McpServerPolicySchema>;
