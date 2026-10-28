import { useNavigate } from 'react-router-dom';
import { Button, useToastContext } from '@librechat/client';
import { Permissions, PermissionTypes, hasPromptInputVariables } from 'librechat-data-provider';
import type { TPromptGroup, TCreatePrompt } from 'librechat-data-provider';
import { useUpdateChatPromptPreferences } from '~/data-provider/chatPrompts';
import { useHasAccess, useLocalize } from '~/hooks';
import { useCreatePrompt } from '~/data-provider';

export default function Actions({
  group,
  promptText,
  promptId,
  disabled = false,
}: {
  group: TPromptGroup;
  promptText: string;
  promptId?: string;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.CREATE,
  });
  const mutation = useUpdateChatPromptPreferences();
  const duplicate = useCreatePrompt({
    onSuccess: (response) => {
      if (response.prompt.groupId) {
        navigate(`/prompts/${encodeURIComponent(response.prompt.groupId)}`);
      }
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_prompt_duplicate_error') });
    },
  });
  if (group.source === 'langfuse') {
    return null;
  }

  const blocked = disabled || !group._id || promptText.trim().length === 0;
  const hasVariables = hasPromptInputVariables(promptText);
  const duplicatePrompt = () => {
    const payload: TCreatePrompt = {
      prompt: { type: 'text', prompt: promptText },
      group: {
        name: localize('com_ui_prompt_copy', { 0: group.name }),
        category: group.category ?? '',
        oneliner: group.oneliner,
      },
    };
    duplicate.mutate(payload);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={blocked || mutation.isLoading || hasVariables}
        onClick={() =>
          mutation.mutate({
            mode: 'prompt',
            groupId: group._id ?? '',
            selection: promptId ? { type: 'exact', promptId } : { type: 'production' },
          })
        }
      >
        {localize('com_ui_chat_default_set')}
      </Button>
      {group.source === 'config' && hasCreateAccess && (
        <Button
          type="button"
          variant="outline"
          disabled={blocked || duplicate.isLoading}
          onClick={duplicatePrompt}
        >
          {localize('com_ui_prompt_duplicate')}
        </Button>
      )}
      {hasVariables && (
        <p className="text-text-secondary w-full text-sm">
          {localize('com_ui_chat_default_variables')}
        </p>
      )}
      {mutation.isSuccess && (
        <p role="status" className="text-text-secondary w-full text-sm">
          {localize('com_ui_chat_default_saved')}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-text-destructive w-full text-sm">
          {localize('com_ui_chat_default_save_error')}
        </p>
      )}
    </div>
  );
}
