import { z } from 'zod';

export const TrustCheckStateSchema = z.enum(['ok', 'warn', 'blocked']);

export const TrustCheckSchema = z.object({
  state: TrustCheckStateSchema,
  label: z.string().min(1),
  detail: z.string().min(1),
  action: z.string().min(1),
});

export type TrustCheck = z.infer<typeof TrustCheckSchema>;
