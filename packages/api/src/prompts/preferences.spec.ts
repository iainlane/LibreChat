import { logger } from '@librechat/data-schemas';
import type { ChatPromptPreferences } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ChatPromptService } from './defaults';
import type { ServerRequest } from '~/types';
import { createChatPromptPreferencesHandlers } from './preferences';
import { ChatPromptUnavailableError } from './defaults';

function request(body: unknown = { mode: 'none' }): ServerRequest {
  return { user: { id: 'user-1' }, config: {}, body } as ServerRequest;
}

function response() {
  const result = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, result };
}

function setup() {
  const preferences = jest.fn<
    Promise<ChatPromptPreferences>,
    Parameters<ChatPromptService['preferences']>
  >();
  preferences.mockResolvedValue({ selection: { mode: 'none' } });
  const updateUserChatPrompt = jest.fn(async () => ({ id: 'user-1' }));
  const handlers = createChatPromptPreferencesHandlers({
    service: { preferences, resolveInstructions: jest.fn() },
    updateUserChatPrompt,
  });
  return { handlers, preferences, updateUserChatPrompt };
}

describe('chat prompt preference HTTP boundary', () => {
  it('persists a validated selection and returns its resolved representation', async () => {
    const { handlers, updateUserChatPrompt } = setup();
    const { res, result } = response();
    await handlers.put(request(), res);
    expect(updateUserChatPrompt.mock.calls).toStrictEqual([['user-1', { mode: 'none' }]]);
    expect(result).toStrictEqual({ status: 200, body: { selection: { mode: 'none' } } });
  });

  it('rejects malformed selections before resolving or changing the user', async () => {
    const { handlers, preferences, updateUserChatPrompt } = setup();
    const { res, result } = response();
    await handlers.put(request({ mode: 'none', groupId: 'conflicting' }), res);
    expect({
      resolveCalls: preferences.mock.calls,
      writes: updateUserChatPrompt.mock.calls,
      ...result,
    }).toStrictEqual({
      resolveCalls: [],
      writes: [],
      status: 400,
      body: { code: 'INVALID_CHAT_PROMPT_DEFAULT' },
    });
  });

  it.each(['get', 'put'] as const)(
    'returns an actionable missing-reference code on %s',
    async (method) => {
      const { handlers, preferences, updateUserChatPrompt } = setup();
      preferences.mockRejectedValue(new ChatPromptUnavailableError());
      const { res, result } = response();
      await handlers[method](request(), res);
      expect({ writes: updateUserChatPrompt.mock.calls, ...result }).toStrictEqual({
        writes: [],
        status: 409,
        body: { code: 'CHAT_PROMPT_UNAVAILABLE' },
      });
    },
  );

  it('does not disclose a database failure or report a successful preference update', async () => {
    const { handlers, updateUserChatPrompt } = setup();
    updateUserChatPrompt.mockRejectedValue(new Error('mongodb://private-user:password@internal'));
    const { res, result } = response();
    jest.spyOn(logger, 'error').mockReturnValue(logger);
    await handlers.put(request(), res);
    expect(result).toStrictEqual({ status: 500, body: { code: 'CHAT_PROMPT_PREFERENCES_FAILED' } });
  });
});
