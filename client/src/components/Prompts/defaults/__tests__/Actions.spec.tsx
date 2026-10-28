import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TPromptGroup, ChatPromptPreferences } from 'librechat-data-provider';
import Actions from '../Actions';

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useLocalize: () => (key: string) => key,
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      updateChatPromptPreferences: jest.fn(),
    },
  };
});
const mockCreate = jest.fn();
jest.mock('~/data-provider', () => ({
  useCreatePrompt: () => ({ mutate: mockCreate, isLoading: false }),
}));
const group: TPromptGroup = {
  _id: 'managed-group',
  name: 'General assistant',
  author: 'deployment',
  authorName: 'Deployment',
  source: 'config',
};
const update = jest.mocked(dataService.updateChatPromptPreferences);
function setup(
  disabled = false,
  promptText = 'Be helpful.',
  source: TPromptGroup['source'] = 'config',
) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Actions group={{ ...group, source }} promptText={promptText} disabled={disabled} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

it('sets an ordinary-chat default through the API and updates preferences', async () => {
  const preferences: ChatPromptPreferences = {
    selection: { mode: 'prompt', groupId: 'managed-group', selection: { type: 'production' } },
    effectivePrompt: { groupId: 'managed-group', name: group.name, source: 'config' },
  };
  update.mockResolvedValue(preferences);
  const client = setup();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_chat_default_set' }));
  await screen.findByRole('status');
  expect(update).toHaveBeenCalledWith(preferences.selection);
  expect(client.getQueryData([QueryKeys.chatPromptPreferences])).toStrictEqual(preferences);
});

it('duplicates managed text as a new native prompt without the managed identity', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_prompt_duplicate' }));
  expect(mockCreate).toHaveBeenCalledWith({
    prompt: { type: 'text', prompt: 'Be helpful.' },
    group: { name: 'com_ui_prompt_copy', category: '', oneliner: undefined },
  });
});

it.each([
  [true, 'Be helpful.'],
  [false, ''],
])('blocks actions until content is available (%s)', (disabled, promptText) => {
  setup(disabled, promptText);
  expect(screen.getByRole('button', { name: 'com_ui_chat_default_set' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'com_ui_prompt_duplicate' })).toBeDisabled();
});

it('shows a safe failure and permits another attempt', async () => {
  update.mockRejectedValue(new Error('private server diagnostic'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_chat_default_set' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_chat_default_save_error');
  expect(screen.queryByText('private server diagnostic')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_chat_default_set' })).toBeEnabled();
});

it('does not advertise unsupported Langfuse chat defaults', () => {
  setup(false, 'Be helpful.', 'langfuse');
  expect(screen.queryByRole('button', { name: 'com_ui_chat_default_set' })).not.toBeInTheDocument();
});

it.each(['topic', 'current_user', 'current_date', 'iso_datetime', 'current_datetime'])(
  'explains why a prompt with the %s variable cannot become a chat default',
  (variable) => {
    setup(false, `Hello {{${variable}}}.`);
    expect(screen.getByRole('button', { name: 'com_ui_chat_default_set' })).toBeDisabled();
    expect(screen.getByText('com_ui_chat_default_variables')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_prompt_duplicate' })).toBeEnabled();
  },
);

it.each(['Be helpful.', 'Use {braces} in JSON examples.'])(
  'allows plain text without a variables warning: %s',
  (promptText) => {
    setup(false, promptText);
    expect(screen.getByRole('button', { name: 'com_ui_chat_default_set' })).toBeEnabled();
    expect(screen.queryByText('com_ui_chat_default_variables')).not.toBeInTheDocument();
  },
);
