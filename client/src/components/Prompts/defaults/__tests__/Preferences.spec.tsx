import React from 'react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatPromptPreferences } from 'librechat-data-provider';
import Preferences from '../Preferences';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getChatPromptPreferences: jest.fn(),
      updateChatPromptPreferences: jest.fn(),
    },
  };
});
const getPreferences = jest.mocked(dataService.getChatPromptPreferences);
const updatePreferences = jest.mocked(dataService.updateChatPromptPreferences);

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  render(
    <QueryClientProvider client={client}>
      <Preferences />
    </QueryClientProvider>,
  );
  return client;
}

it('shows loading while the default is being resolved', () => {
  getPreferences.mockReturnValue(new Promise(() => {}));
  setup();
  expect(screen.getByLabelText('com_ui_loading')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('lets users recover from an unavailable default by selecting no default', async () => {
  getPreferences.mockRejectedValue(new Error('sensitive database failure'));
  const none: ChatPromptPreferences = { selection: { mode: 'none' } };
  updatePreferences.mockResolvedValue(none);
  const client = setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_chat_default_load_error');
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_chat_default_disable' }));
  await screen.findByText('com_ui_chat_default_none');
  expect(updatePreferences).toHaveBeenCalledWith({ mode: 'none' });
  expect(client.getQueryData([QueryKeys.chatPromptPreferences])).toStrictEqual(none);
  expect(screen.queryByText('sensitive database failure')).not.toBeInTheDocument();
});
