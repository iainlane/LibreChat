import { z } from 'zod';
import type { TPromptGroupSource } from './types';
import { getSpecialVariable } from './variables';

const recordId = z.string().regex(/^[a-f\d]{24}$/);

export function hasPromptInputVariables(prompt: string): boolean {
  for (const [, variable] of prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (getSpecialVariable(variable) === undefined) {
      return true;
    }
  }
  return false;
}

export const promptReferenceSchema = z
  .object({
    groupId: recordId,
    selection: z.discriminatedUnion('type', [
      z.object({ type: z.literal('production') }).strict(),
      z.object({ type: z.literal('exact'), promptId: recordId }).strict(),
    ]),
  })
  .strict();

export type ChatPromptReference = z.infer<typeof promptReferenceSchema>;

export const chatPromptDefaultSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  promptReferenceSchema.extend({ mode: z.literal('prompt') }).strict(),
]);

export type ChatPromptDefault = z.infer<typeof chatPromptDefaultSchema>;

export const chatInstructionsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('custom'), text: z.string() }).strict(),
]);

export type ChatInstructions = z.infer<typeof chatInstructionsSchema>;

export interface ChatPromptPreferences {
  selection: ChatPromptDefault;
  effectivePrompt?: {
    groupId: string;
    name: string;
    source: TPromptGroupSource;
    promptId?: string;
  };
}

export const promptLibrarySchema = z
  .object({
    library: z.array(
      z
        .object({
          id: z.string().regex(/^[a-zA-Z\d][a-zA-Z\d_-]*$/),
          name: z.string().trim().min(1),
          description: z.string().optional(),
          prompt: z.string().refine((value) => value.trim().length > 0),
        })
        .strict(),
    ),
    defaultChatPrompt: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();

    for (const [index, prompt] of value.library.entries()) {
      if (ids.has(prompt.id)) {
        context.addIssue({
          code: 'custom',
          path: ['library', index, 'id'],
          message: 'Each configured prompt must have a unique ID.',
        });
      }

      ids.add(prompt.id);
    }

    if (value.defaultChatPrompt !== undefined && !ids.has(value.defaultChatPrompt)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultChatPrompt'],
        message: 'The default chat prompt must refer to a configured library entry.',
      });
    }
  });

export type PromptLibraryConfig = z.infer<typeof promptLibrarySchema>;
