import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  QueryKeys,
  dataService,
  encodeEphemeralAgentId,
  replaceSpecialVars,
} from 'librechat-data-provider';
import type { Agent, TReasoningOverride } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { useAuthContext } from '~/hooks/AuthContext';
import useSubmitMessage from '../useSubmitMessage';

const mockSetActivePrompt = jest.fn();
const mockShowToast = jest.fn();
let mockAgentsMap: Record<string, Agent | undefined> = {};
let queryClient: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  );
}
function savedAgent(model = 'saved-model'): Agent {
  return {
    id: 'agent_saved',
    name: 'Saved',
    provider: 'openAI',
    model,
    description: null,
    created_at: 0,
    avatar: null,
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
  };
}
jest.mock('~/Providers/AgentsMapContext', () => ({ useAgentsMapContext: () => mockAgentsMap }));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(),
  useSetRecoilState: jest.fn(),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    replaceSpecialVars: jest.fn(actual.replaceSpecialVars),
    dataService: { ...actual.dataService, getAgentById: jest.fn() },
  };
});

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
  useChatFormContext: jest.fn(),
  useAddedChatContext: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: jest.fn(),
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useGetLatestMessage: jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    autoSendPrompts: 'autoSendPrompts',
    activePromptByIndex: jest.fn(() => 'activePromptByIndex'),
  },
}));

const mockUseRecoilValue = useRecoilValue as jest.Mock;
const mockUseSetRecoilState = useSetRecoilState as jest.Mock;
const mockUseChatContext = useChatContext as jest.Mock;
const mockUseChatFormContext = useChatFormContext as jest.Mock;
const mockUseAddedChatContext = useAddedChatContext as jest.Mock;
const mockUseAuthContext = useAuthContext as jest.Mock;
const mockUseGetLatestMessage = useGetLatestMessage as jest.Mock;

describe('useSubmitMessage', () => {
  const ask = jest.fn();
  const reset = jest.fn();
  const setMessages = jest.fn();
  const getMessages = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    mockAgentsMap = {};
    jest.mocked(dataService.getAgentById).mockReset();
    mockUseRecoilValue.mockReturnValue(false);
    mockUseSetRecoilState.mockReturnValue(mockSetActivePrompt);
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-1' } });
    mockUseAddedChatContext.mockReturnValue({ conversation: null });
    mockUseChatFormContext.mockReturnValue({ reset, getValues: jest.fn(() => '') });
    mockUseGetLatestMessage.mockReturnValue(() => ({ messageId: 'assistant-message' }));
    getMessages.mockReturnValue([{ messageId: 'assistant-message' }]);
    mockUseChatContext.mockReturnValue({
      ask,
      index: 0,
      conversation: { model: 'provider/selected-model' },
      getMessages,
      setMessages,
    });
  });

  it('uses the selected model when inserting a library prompt', () => {
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    act(() => {
      void result.current.submitPrompt('You are {{current_model}}.');
    });
    expect(replaceSpecialVars).toHaveBeenCalledWith({
      text: 'You are {{current_model}}.',
      user: { id: 'user-1' },
      model: 'provider/selected-model',
    });
  });

  afterEach(() => queryClient.clear());

  it.each(['catalog', 'single-cache', 'ephemeral'])(
    'resolves a cleared Agent conversation model from %s without fetching',
    async (source) => {
      const agent = savedAgent();
      const agentId =
        source === 'ephemeral'
          ? encodeEphemeralAgentId({ endpoint: 'openAI', model: 'encoded-model' })
          : agent.id;
      mockUseChatContext.mockReturnValue({
        ...mockUseChatContext(),
        conversation: { conversationId: 'chat-1', endpoint: 'agents', agent_id: agentId },
      });
      if (source === 'catalog') mockAgentsMap[agent.id] = agent;
      if (source === 'single-cache') {
        mockAgentsMap[agent.id] = savedAgent('stale-model');
        queryClient.setQueryData([QueryKeys.agent, agent.id], agent);
      }
      const { result } = renderHook(() => useSubmitMessage(), { wrapper });
      const pending = result.current.submitPrompt('You are {{ CURRENT_MODEL }}.');
      expect(mockSetActivePrompt).toHaveBeenCalledWith(
        `You are ${source === 'ephemeral' ? 'encoded-model' : 'saved-model'}.`,
      );
      expect(await pending).toBe(true);
      expect(dataService.getAgentById).not.toHaveBeenCalled();
    },
  );

  it('fetches missing Agent metadata only for a model variable and deduplicates pending reads', async () => {
    mockUseChatContext.mockReturnValue({
      ...mockUseChatContext(),
      conversation: { conversationId: 'chat-1', endpoint: 'agents', agent_id: 'agent_saved' },
    });
    const pending = Promise.withResolvers<Agent>();
    jest.mocked(dataService.getAgentById).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    expect(await result.current.submitPrompt('Plain prompt.')).toBe(true);
    expect(dataService.getAgentById).not.toHaveBeenCalled();
    mockSetActivePrompt.mockClear();
    const first = result.current.submitPrompt('First {{current_model}}');
    const second = result.current.submitPrompt('Second {{current_model}}');
    expect(dataService.getAgentById).toHaveBeenCalledTimes(1);
    expect(mockSetActivePrompt).not.toHaveBeenCalled();
    pending.resolve(savedAgent());
    expect(await Promise.all([first, second])).toStrictEqual([false, true]);
    expect(mockSetActivePrompt.mock.calls).toStrictEqual([['Second saved-model']]);
  });

  it('shows a safe recoverable error without sending or staging an unresolved model', async () => {
    mockUseRecoilValue.mockReturnValue(true);
    mockUseChatContext.mockReturnValue({
      ...mockUseChatContext(),
      conversation: { endpoint: 'agents', agent_id: 'agent_saved' },
    });
    jest
      .mocked(dataService.getAgentById)
      .mockRejectedValue(new Error('private request diagnostic'));
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    expect(await result.current.submitPrompt('You are {{current_model}}.')).toBe(false);
    expect(mockShowToast.mock.calls).toStrictEqual([
      [{ status: 'error', message: 'com_ui_prompt_model_error' }],
    ]);
    expect(ask).not.toHaveBeenCalled();
    expect(mockSetActivePrompt).not.toHaveBeenCalled();
    jest.mocked(dataService.getAgentById).mockResolvedValue(savedAgent());
    expect(await result.current.submitPrompt('You are {{current_model}}.')).toBe(true);
    expect(ask).toHaveBeenCalledWith({ text: 'You are saved-model.' }, expect.any(Object));
  });

  it.each(['conversationId', 'agent_id', 'model', 'endpoint', 'unmount'])(
    'discards a model lookup after %s changes',
    async (field) => {
      mockUseRecoilValue.mockReturnValue(true);
      const conversation = {
        conversationId: 'chat-1',
        endpoint: 'agents',
        agent_id: 'agent_saved',
        model: undefined,
      };
      mockUseChatContext.mockReturnValue({ ...mockUseChatContext(), conversation });
      const pending = Promise.withResolvers<Agent>();
      jest.mocked(dataService.getAgentById).mockReturnValue(pending.promise);
      const { result, rerender, unmount } = renderHook(() => useSubmitMessage(), { wrapper });
      const submission = result.current.submitPrompt('You are {{current_model}}.');
      if (field === 'unmount') unmount();
      else {
        mockUseChatContext.mockReturnValue({
          ...mockUseChatContext(),
          conversation: { ...conversation, [field]: 'changed' },
        });
        rerender();
      }
      pending.resolve(savedAgent());
      expect(await submission).toBe(false);
      expect(ask).not.toHaveBeenCalled();
      expect(mockSetActivePrompt).not.toHaveBeenCalled();
      expect(mockShowToast).not.toHaveBeenCalled();
    },
  );

  it('propagates blocked submits so direct callers can preserve their text', () => {
    ask.mockReturnValue(false);

    const { result } = renderHook(() => useSubmitMessage(), { wrapper });

    let submitted: false | void = undefined;
    act(() => {
      submitted = result.current.submitMessage({ text: 'dictated follow-up' });
    });

    expect(submitted).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves a refused automatic prompt (accepted=%s)', (accepted) => {
    mockUseRecoilValue.mockReturnValue(true);
    ask.mockReturnValue(accepted);
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    act(() => {
      void result.current.submitPrompt('selected prompt');
    });
    expect(ask).toHaveBeenCalledWith({ text: 'selected prompt' }, expect.any(Object));
    if (accepted) {
      expect(mockSetActivePrompt).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalled();
    } else {
      expect(mockSetActivePrompt).toHaveBeenCalledWith('selected prompt');
      expect(reset).not.toHaveBeenCalled();
    }
  });

  it('reads the tail at call time and appends it to root when missing', () => {
    const rootMessages = [{ messageId: 'root-user' }];
    const latest = { messageId: 'assistant-tail', text: 'tail' };
    const reader = jest.fn(() => latest);
    mockUseGetLatestMessage.mockReturnValue(reader);
    getMessages.mockReturnValue(rootMessages);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(reader).toHaveBeenCalled();
    expect(setMessages).toHaveBeenCalledWith([...rootMessages, latest]);
    expect(ask).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });

  it('does not append when the latest message is already in root', () => {
    const latest = { messageId: 'assistant-tail' };
    mockUseGetLatestMessage.mockReturnValue(() => latest);
    getMessages.mockReturnValue([latest]);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
  });

  it('does not append when there is no latest message', () => {
    mockUseGetLatestMessage.mockReturnValue(() => null);
    getMessages.mockReturnValue([{ messageId: 'root-user' }]);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
  });

  it('uses the recovery source as the stable user row and forwards the attempt fields', () => {
    ask.mockReturnValue(true);
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });

    act(() => {
      result.current.submitMessage({
        text: 'recover once',
        overrideClientRequestId: 'attempt-uuid',
        overrideRecoverySteerId: 'source-steer',
      });
    });

    expect(ask).toHaveBeenCalledWith(
      { text: 'recover once', overrideUserMessageId: 'source-steer' },
      expect.objectContaining({
        overrideClientRequestId: 'attempt-uuid',
        overrideRecoverySteerId: 'source-steer',
      }),
    );
  });

  it('forwards a queued reasoning override without resetting it on refusal', () => {
    ask.mockReturnValue(false);
    const { result } = renderHook(() => useSubmitMessage(), { wrapper });
    const override = { key: 'thinkingLevel', value: 'high' } as TReasoningOverride;

    act(() => {
      result.current.submitMessage({ text: 'queued thought', overrideReasoning: override });
    });

    expect(ask).toHaveBeenCalledWith(
      { text: 'queued thought' },
      expect.objectContaining({ overrideReasoning: override }),
    );
    expect(reset).not.toHaveBeenCalled();
  });
});
