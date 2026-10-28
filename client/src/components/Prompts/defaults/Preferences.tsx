import { Button, Spinner } from '@librechat/client';
import {
  useChatPromptPreferences,
  useUpdateChatPromptPreferences,
} from '~/data-provider/chatPrompts';
import { useLocalize } from '~/hooks';

export default function Preferences() {
  const localize = useLocalize();
  const query = useChatPromptPreferences();
  const mutation = useUpdateChatPromptPreferences();
  if (query.isInitialLoading) {
    return (
      <div role="status" aria-label={localize('com_ui_loading')}>
        <Spinner className="size-4" />
      </div>
    );
  }
  return (
    <div className="border-border-medium mb-4 flex flex-col gap-2 border-b pb-4">
      <h3 className="text-text-primary text-sm font-semibold">
        {localize('com_ui_chat_default_heading')}
      </h3>
      {query.isError && (
        <div role="alert" className="text-text-secondary text-sm">
          <p>{localize('com_ui_chat_default_load_error')}</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {!query.isError && (
        <p className="text-text-secondary text-sm">
          {query.data?.effectivePrompt
            ? localize('com_ui_chat_instructions_using', { 0: query.data.effectivePrompt.name })
            : localize('com_ui_chat_default_none')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isLoading || query.data?.selection.mode === 'inherit'}
          onClick={() => mutation.mutate({ mode: 'inherit' })}
        >
          {localize('com_ui_chat_default_deployment')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isLoading || query.data?.selection.mode === 'none'}
          onClick={() => mutation.mutate({ mode: 'none' })}
        >
          {localize('com_ui_chat_default_disable')}
        </Button>
      </div>
      {mutation.isError && <p role="alert">{localize('com_ui_chat_default_save_error')}</p>}
    </div>
  );
}
