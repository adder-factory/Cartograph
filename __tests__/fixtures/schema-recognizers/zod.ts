/**
 * Fixture for the Zod schema-recognizer test — NOT a test file itself.
 * Consumed by `__tests__/schema-recognizers-zod.test.ts`.
 *
 * A realistic Zod module that exercises the recognizer end to end in
 * one file: a plain `z.object` schema, `z.enum`, a nested `z.object`
 * field, and the `z.infer<typeof …>` / `.pick({…})` consumers.
 */
import { z } from 'zod';

export const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
});

export const UserSchema = z.object({
  name: z.string(),
  age: z.number().int(),
  role: z.enum(['admin', 'editor', 'viewer']),
  home: z.object({
    label: z.string(),
  }),
});

export type User = z.infer<typeof UserSchema>;

export const PublicUser = UserSchema.pick({ name: true });
