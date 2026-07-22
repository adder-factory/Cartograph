import { z } from 'zod';
import { assertValidCartographConfig } from '../config/schema.js';
import { parseZodBoundary } from '../errors.js';
import type { SyncResult } from '../extraction/index.js';
import type { CartographConfig } from '../types.js';

const hookWorkerConfigSchema = z.custom<CartographConfig>(
  (value) => {
    try {
      assertValidCartographConfig('hook-worker IPC config', value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected valid CartographConfig' },
);

const syncResultSchema = z
  .strictObject({
    filesChecked: z.number().int().nonnegative(),
    filesAdded: z.number().int().nonnegative(),
    filesModified: z.number().int().nonnegative(),
    filesRemoved: z.number().int().nonnegative(),
    nodesUpdated: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    changedFilePaths: z.array(z.string()).optional(),
    lockContention: z.boolean().optional(),
  })
  .transform((value): SyncResult => {
    const result: SyncResult = {
      filesChecked: value.filesChecked,
      filesAdded: value.filesAdded,
      filesModified: value.filesModified,
      filesRemoved: value.filesRemoved,
      nodesUpdated: value.nodesUpdated,
      durationMs: value.durationMs,
    };
    if (value.changedFilePaths !== undefined) result.changedFilePaths = value.changedFilePaths;
    if (value.lockContention !== undefined) result.lockContention = value.lockContention;
    return result;
  });

const hookWorkerCommandBaseSchema = {
  type: z.literal('run-hooks'),
  id: z.number().int().nonnegative(),
  projectRoot: z.string().min(1),
  dbPath: z.string().min(1),
  config: hookWorkerConfigSchema,
};

const hookWorkerCommandSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    ...hookWorkerCommandBaseSchema,
    phase: z.literal('sync'),
    syncResult: syncResultSchema,
  }),
  z.strictObject({
    ...hookWorkerCommandBaseSchema,
    phase: z.literal('indexAll'),
  }),
]);

const hookWorkerWireOutcomeSchema = z.strictObject({
  name: z.string().min(1),
  phase: z.enum(['sync', 'indexAll']),
  durationMs: z.number().nonnegative(),
  mutated: z.boolean().optional(),
  error: z.string().optional(),
});

const hookWorkerReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({
    type: z.literal('hooks-done'),
    id: z.number().int().nonnegative(),
    outcomes: z.array(hookWorkerWireOutcomeSchema),
  }),
  z.strictObject({
    type: z.literal('hooks-error'),
    id: z.number().int().nonnegative(),
    message: z.string(),
  }),
]);

export type HookWorkerCommand = z.infer<typeof hookWorkerCommandSchema>;
export type HookWorkerReply = z.infer<typeof hookWorkerReplySchema>;
export type HookWorkerDoneReply = Extract<HookWorkerReply, { readonly type: 'hooks-done' }>;
export type HookWorkerErrorReply = Extract<HookWorkerReply, { readonly type: 'hooks-error' }>;
export type HookWorkerWireOutcome = z.infer<typeof hookWorkerWireOutcomeSchema>;

export function parseHookWorkerCommand(value: unknown): HookWorkerCommand {
  return parseZodBoundary(hookWorkerCommandSchema, value, 'Invalid hook worker command');
}

export function parseHookWorkerReply(value: unknown): HookWorkerReply {
  return parseZodBoundary(hookWorkerReplySchema, value, 'Invalid hook worker reply');
}
