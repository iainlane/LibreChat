import { logger } from '@librechat/data-schemas';
import { chatPromptDefaultSchema } from 'librechat-data-provider';
import type { ChatPromptDefault } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ChatPromptService } from './defaults';
import type { ServerRequest } from '~/types';
import { ChatPromptUnavailableError } from './defaults';
import { getSafeErrorMetadata } from '~/utils';

interface ChatPromptPreferencesDeps {
  service: ChatPromptService;
  updateUserChatPrompt(userId: string, selection: ChatPromptDefault): Promise<unknown | null>;
}

export function createChatPromptPreferencesHandlers(deps: ChatPromptPreferencesDeps) {
  function failure(error: unknown, res: Response): Response {
    if (error instanceof ChatPromptUnavailableError) {
      return res.status(409).json({ code: 'CHAT_PROMPT_UNAVAILABLE' });
    }
    logger.error('[ChatPromptPreferences] Operation failed', getSafeErrorMetadata(error));
    return res.status(500).json({ code: 'CHAT_PROMPT_PREFERENCES_FAILED' });
  }

  return {
    async get(req: ServerRequest, res: Response): Promise<Response> {
      if (!req.user?.id) {
        return res.status(401).json({ code: 'UNAUTHORIZED' });
      }
      try {
        return res
          .status(200)
          .json(await deps.service.preferences({ user: req.user, config: req.config }));
      } catch (error) {
        return failure(error, res);
      }
    },

    async put(req: ServerRequest, res: Response): Promise<Response> {
      if (!req.user?.id) {
        return res.status(401).json({ code: 'UNAUTHORIZED' });
      }
      const parsed = chatPromptDefaultSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ code: 'INVALID_CHAT_PROMPT_DEFAULT' });
      }
      try {
        const preferences = await deps.service.preferences(
          { user: req.user, config: req.config },
          parsed.data,
        );
        const updated = await deps.updateUserChatPrompt(req.user.id, parsed.data);
        if (updated == null) {
          return res.status(404).json({ code: 'USER_NOT_FOUND' });
        }
        return res.status(200).json(preferences);
      } catch (error) {
        return failure(error, res);
      }
    },
  };
}
