import { useId } from 'react';
import { Label, TextareaAutosize } from '@librechat/client';
import type { ChatInstructions } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export default function Instructions({
  instructions,
  legacyText,
  onChange,
}: {
  instructions?: ChatInstructions;
  legacyText?: string | null;
  onChange: (instructions: ChatInstructions) => void;
}) {
  const id = useId();
  const localize = useLocalize();
  const current: ChatInstructions =
    instructions ??
    (legacyText?.trim() ? { mode: 'custom', text: legacyText } : { mode: 'inherit' });
  const text = current.mode === 'custom' ? current.text : (legacyText ?? '');

  return (
    <fieldset className="border-border-medium mb-4 flex flex-col gap-3 border-b pb-4">
      <legend className="text-text-primary mb-2 text-sm font-semibold">
        {localize('com_ui_chat_instructions')}
      </legend>
      {(
        [
          { mode: 'inherit', label: 'com_ui_chat_instructions_inherit' },
          { mode: 'custom', label: 'com_ui_chat_instructions_custom' },
          { mode: 'none', label: 'com_ui_chat_instructions_none' },
        ] as const
      ).map(({ mode, label }) => (
        <div key={mode} className="flex items-center gap-2">
          <input
            type="radio"
            id={`${id}-${mode}`}
            name={`${id}-mode`}
            checked={current.mode === mode}
            onChange={() => onChange(mode === 'custom' ? { mode, text } : { mode })}
          />
          <Label htmlFor={`${id}-${mode}`}>{localize(label)}</Label>
        </div>
      ))}
      {current.mode === 'custom' && (
        <TextareaAutosize
          aria-label={localize('com_ui_chat_instructions_custom')}
          value={current.text}
          onChange={(event) => onChange({ mode: 'custom', text: event.target.value })}
          minRows={4}
          maxRows={12}
          variant="field"
          className="w-full"
        />
      )}
    </fieldset>
  );
}
