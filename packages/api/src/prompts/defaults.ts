import {
  ErrorTypes,
  PermissionBits,
  ResourceType,
  hasChatPromptVariables,
} from 'librechat-data-provider';
import type {
  ChatInstructions,
  ChatPromptDefault,
  ChatPromptPreferences,
  ChatPromptReference,
  FiltersConfig,
  PromptLibraryConfig,
} from 'librechat-data-provider';
import type { EnsurePromptCatalog } from './catalog';
import type { PromptService } from './service';

export class ChatPromptUnavailableError extends Error {
  readonly code: ErrorTypes = ErrorTypes.CHAT_PROMPT_UNAVAILABLE;
  readonly status = 409;

  constructor() {
    super(
      'The default chat instructions are unavailable. Choose another prompt or disable instructions for this chat.',
    );
    this.name = 'ChatPromptUnavailableError';
  }
}

interface ChatPromptUser {
  id: string;
  role?: string;
  personalization?: { defaultChatPrompt?: ChatPromptDefault };
}

interface ChatPromptConfig {
  prompts?: PromptLibraryConfig;
  filters?: FiltersConfig;
}

interface ChatPromptInput {
  user: ChatPromptUser;
  config?: ChatPromptConfig;
}

export interface ChatPromptServiceDeps {
  promptService: Pick<PromptService, 'resolvePrompt' | 'getPromptGroup'>;
  ensureCatalog: EnsurePromptCatalog;
  getEffectivePermissions(input: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string;
  }): Promise<number>;
  canUsePrompts(user: ChatPromptUser): Promise<boolean>;
}

export function createChatPromptService(deps: ChatPromptServiceDeps) {
  async function resolveReference(input: ChatPromptInput, reference: ChatPromptReference) {
    const [canUse, permissions, group] = await Promise.all([
      deps.canUsePrompts(input.user),
      deps.getEffectivePermissions({
        userId: input.user.id,
        role: input.user.role,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: reference.groupId,
      }),
      deps.promptService.getPromptGroup({
        groupId: reference.groupId,
        filters: input.config?.filters,
      }),
    ]);
    if (
      !canUse ||
      (permissions & PermissionBits.VIEW) !== PermissionBits.VIEW ||
      group == null ||
      !group.ok ||
      group.value == null
    ) {
      throw new ChatPromptUnavailableError();
    }
    const resolved = await deps.promptService.resolvePrompt({
      ...reference,
      filters: input.config?.filters,
      allowedSources: ['native', 'config'],
    });
    if (
      !resolved.ok ||
      resolved.value.type !== 'text' ||
      hasChatPromptVariables(resolved.value.prompt)
    ) {
      throw new ChatPromptUnavailableError();
    }
    return {
      prompt: resolved.value.prompt,
      effectivePrompt: {
        groupId: reference.groupId,
        name: group.value.name,
        source: resolved.value.source,
        ...('promptId' in resolved.value ? { promptId: resolved.value.promptId } : {}),
      },
    };
  }

  async function getSelection(
    input: ChatPromptInput,
    override?: ChatPromptDefault,
  ): Promise<ChatPromptReference | null> {
    const selection = override ??
      input.user.personalization?.defaultChatPrompt ?? { mode: 'inherit' };
    if (selection.mode === 'none') {
      return null;
    }
    if (selection.mode === 'prompt') {
      return selection;
    }
    const defaultId = input.config?.prompts?.defaultChatPrompt;
    if (defaultId == null) {
      return null;
    }
    const groups = await deps.ensureCatalog(input.config?.prompts);
    const groupId = groups.get(defaultId);
    if (groupId == null) {
      throw new ChatPromptUnavailableError();
    }
    return { groupId, selection: { type: 'production' } };
  }

  return {
    async preferences(
      input: ChatPromptInput,
      selection?: ChatPromptDefault,
    ): Promise<ChatPromptPreferences> {
      await deps.ensureCatalog(input.config?.prompts);
      const chosen = selection ??
        input.user.personalization?.defaultChatPrompt ?? { mode: 'inherit' };
      const reference = await getSelection(input, chosen);
      if (reference == null) {
        return { selection: chosen };
      }
      const { effectivePrompt } = await resolveReference(input, reference);
      return { selection: chosen, effectivePrompt };
    },

    async resolveInstructions(
      input: ChatPromptInput & {
        chatInstructions?: ChatInstructions;
        legacyInstructions?: string | null;
      },
    ): Promise<string> {
      if (input.chatInstructions?.mode === 'none') {
        return '';
      }
      if (input.chatInstructions?.mode === 'custom') {
        return input.chatInstructions.text;
      }
      if (input.chatInstructions == null && input.legacyInstructions?.trim()) {
        return input.legacyInstructions;
      }
      await deps.ensureCatalog(input.config?.prompts);
      const reference = await getSelection(input);
      return reference == null ? '' : (await resolveReference(input, reference)).prompt;
    },
  };
}

export type ChatPromptService = ReturnType<typeof createChatPromptService>;
