import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { ChatPromptDefault } from 'librechat-data-provider';

export function useChatPromptPreferences() {
  return useQuery([QueryKeys.chatPromptPreferences], () => dataService.getChatPromptPreferences(), {
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdateChatPromptPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MutationKeys.updateChatPromptPreferences],
    mutationFn: (selection: ChatPromptDefault) =>
      dataService.updateChatPromptPreferences(selection),
    onSuccess: (preferences) => {
      queryClient.setQueryData([QueryKeys.chatPromptPreferences], preferences);
    },
  });
}
