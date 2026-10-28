import { useCallback, useMemo, useRef } from 'react';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import {
  QueryKeys,
  dataService,
  isAgentsEndpoint,
  isEphemeralAgentId,
  replaceSpecialVars,
} from 'librechat-data-provider';
import type { Agent, TMessage, TReasoningOverride } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import useChatScopedRequest from '~/hooks/Prompts/useChatScopedRequest';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useAuthContext } from '~/hooks/AuthContext';
import { resolveAgentTarget } from '~/utils/agents';
import useLocalize from '~/hooks/useLocalize';
import { mainTextareaId } from '~/common';
import store from '~/store';

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const methods = useChatFormContext();
  const { conversation: addedConvo } = useAddedChatContext();
  const { ask, index, conversation, getMessages, setMessages } = useChatContext();
  const queryClient = useQueryClient();
  const agentsMap = useAgentsMapContext();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { begin, isCurrent, isMounted } = useChatScopedRequest(index);
  const target = useMemo(
    () => ({
      index,
      conversationId: conversation?.conversationId,
      endpoint: conversation?.endpoint,
      agentId: conversation?.agent_id,
      model: conversation?.model,
      userId: user?.id,
    }),
    [
      index,
      conversation?.conversationId,
      conversation?.endpoint,
      conversation?.agent_id,
      conversation?.model,
      user?.id,
    ],
  );
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const getLatestMessage = useGetLatestMessage(index);

  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const setActivePrompt = useSetRecoilState(store.activePromptByIndex(index));

  const submitMessage = useCallback(
    (data?: {
      text: string;
      overrideFiles?: TMessage['files'];
      overrideQuotes?: string[];
      overrideManualSkills?: string[];
      overrideReasoning?: TReasoningOverride | null;
      overrideClientRequestId?: string;
      overrideRecoverySteerId?: string;
      overrideExpectedPredecessorCreatedAt?: number;
      overrideQueuedMessageOrigin?: unknown;
    }) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }
      const latestMessage = getLatestMessage();
      const rootMessages = getMessages();
      const isLatestInRootMessages = rootMessages?.some(
        (message) => message.messageId === latestMessage?.messageId,
      );
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages || []), latestMessage]);
      }

      const submitted = ask(
        {
          text: data.text,
          ...(data.overrideRecoverySteerId != null && {
            overrideUserMessageId: data.overrideRecoverySteerId,
          }),
        },
        {
          addedConvo: addedConvo ?? undefined,
          // Queued during-run messages carry their own consumed attachments,
          // quote chips, and manual skill picks (undefined = drain composer).
          overrideFiles: data.overrideFiles,
          overrideQuotes: data.overrideQuotes,
          overrideManualSkills: data.overrideManualSkills,
          overrideReasoning: data.overrideReasoning,
          overrideClientRequestId: data.overrideClientRequestId,
          overrideRecoverySteerId: data.overrideRecoverySteerId,
          overrideExpectedPredecessorCreatedAt: data.overrideExpectedPredecessorCreatedAt,
          overrideQueuedMessageOrigin: data.overrideQueuedMessageOrigin,
        },
      );
      if (submitted === false) {
        return false;
      }
      methods.reset();
    },
    [ask, methods, addedConvo, setMessages, getMessages, getLatestMessage],
  );

  const submitPrompt = useCallback(
    async (text: string): Promise<boolean> => {
      const token = begin();
      const isActive = () => isMounted() && isCurrent(token) && currentTarget.current === target;
      let model = target.model ?? undefined;
      if (/\{\{\s*current_model\s*\}\}/i.test(text)) {
        if (isAgentsEndpoint(target.endpoint)) {
          const agentId = target.agentId;
          let agent = agentId
            ? (queryClient.getQueryData<Agent>([QueryKeys.agent, agentId]) ?? agentsMap?.[agentId])
            : undefined;
          model = resolveAgentTarget(agentId, agent)?.model;
          if (!model && agentId && !isEphemeralAgentId(agentId)) {
            try {
              agent = await queryClient.fetchQuery([QueryKeys.agent, agentId], () =>
                dataService.getAgentById({ agent_id: agentId }),
              );
              model = resolveAgentTarget(agentId, agent)?.model;
            } catch {
              if (isActive()) {
                showToast({ status: 'error', message: localize('com_ui_prompt_model_error') });
              }
              return false;
            }
          }
        }
        if (!isActive()) {
          return false;
        }
        if (!model) {
          showToast({ status: 'error', message: localize('com_ui_prompt_model_error') });
          return false;
        }
      }
      const parsedText = replaceSpecialVars({ text, user, model });
      if (autoSendPrompts && submitMessage({ text: parsedText }) !== false) {
        return true;
      }
      /** A refused auto-send still belongs to the user. Stage it exactly like
       * a non-auto-sent prompt so every picker, including variable dialogs,
       * preserves the text for the composer's guarded submit route. */

      const textarea = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
      const currentText = textarea?.value ?? methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
      return true;
    },
    [
      autoSendPrompts,
      submitMessage,
      setActivePrompt,
      methods,
      user,
      target,
      begin,
      isCurrent,
      isMounted,
      queryClient,
      agentsMap,
      showToast,
      localize,
    ],
  );

  return { submitMessage, submitPrompt };
}
