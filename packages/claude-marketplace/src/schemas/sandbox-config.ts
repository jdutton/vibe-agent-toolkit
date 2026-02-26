import { z } from 'zod';

export const SandboxConfigSchema = z
  .object({
    network: z.enum(['none', 'restricted', 'unrestricted']).optional(),
    allowedHosts: z.array(z.string()).optional(),
  })
  .passthrough();

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
