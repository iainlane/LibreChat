import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { TPromptGroup, TCreatePromptResponse } from 'librechat-data-provider';
import type { MockEndpoint } from '../specs/mock/helpers';
import {
  MOCK_ENDPOINTS,
  escapeRegExp,
  getAccessToken,
  modelSelectorTrigger,
  sendMessageAndWaitForCompletion,
} from '../specs/mock/helpers';

async function selectMockEndpoint(page: Page, endpoint: MockEndpoint) {
  const trigger = modelSelectorTrigger(page);
  await trigger.click();
  await page.getByRole('option', { name: endpoint.label }).click();
  const model = page.getByRole('option', {
    name: new RegExp(`^${escapeRegExp(endpoint.model)}(?: selected)?$`),
  });
  await model.click();
  await expect(page.getByRole('dialog', { name: 'Select a model', exact: true })).toHaveCount(0);
  await expect(trigger).toContainText(endpoint.model);
}

async function headers(page: Page) {
  const token = await getAccessToken(page);
  return { Authorization: `Bearer ${token}` };
}

async function preferences(page: Page, request: APIRequestContext, mode: 'inherit' | 'none') {
  const response = await request.put('/api/prompts/default', {
    headers: await headers(page),
    data: { mode },
  });
  expect(response.status()).toBe(200);
}

async function openPanel(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') {
    await button.click();
  }
}

async function previewPrompt(page: Page, name: string) {
  await test.step(`Preview ${name} from the Prompt Library`, async () => {
    await openPanel(page, 'Prompts');
    await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/prompts/groups' && url.searchParams.get('name') === name;
      }),
      page.getByLabel('Filter prompts by name').fill(name),
    ]);
    const row = page.getByRole('button', { name: `${name} prompt`, exact: true }).locator('..');
    await row.hover();
    await row.getByRole('button', { name: 'Conversation Menu Options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Preview', exact: true })).toBeVisible();
  });
}

async function report(page: Page, system: string[], kind: 'Prompt' | 'Context' = 'Prompt') {
  await sendMessageAndWaitForCompletion(page, 'Report the instruction markers.');
  await expect(
    page
      .locator('.message-render')
      .getByText(`${kind} report: ${JSON.stringify({ system, user: [] })}`, { exact: true })
      .last(),
  ).toBeVisible();
}

test('managed prompts are read-only, duplicable, and defaults apply only to ordinary chats', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.goto('/c/new');
  await preferences(page, request, 'inherit');
  const auth = await headers(page);
  const response = await request.get('/api/prompts/all', { headers: auth });
  expect(response.status()).toBe(200);
  const groups: TPromptGroup[] = await response.json();
  const managed = groups.find(
    (group) => group.source === 'config' && group.name === 'General assistant',
  );
  if (!managed?._id) {
    throw new Error('The managed prompt is missing from the library.');
  }
  const managedId = managed._id;

  await previewPrompt(page, 'General assistant');
  await expect(page.getByRole('button', { name: 'Duplicate to edit', exact: true })).toBeVisible();
  const changed = await request.patch(`/api/prompts/groups/${managedId}`, {
    headers: auth,
    data: { name: 'Overwritten' },
  });
  expect(changed.status()).toBe(403);
  await page.getByRole('button', { name: 'Duplicate to edit', exact: true }).click();
  await expect(page).toHaveURL(/\/prompts\/[a-f0-9]{24}$/);
  expect(new URL(page.url()).pathname).not.toBe(`/prompts/${managedId}`);

  await page.goto('/c/new');
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await report(page, ['E2E_PROMPT_DEPLOYMENT']);
  await page.reload();
  await report(page, ['E2E_PROMPT_DEPLOYMENT']);

  const created = await request.post('/api/prompts', {
    headers: auth,
    data: {
      group: { name: 'My ordinary-chat default' },
      prompt: { type: 'text', prompt: 'E2E_PROMPT_USER' },
    },
  });
  expect(created.ok()).toBe(true);
  const native: TCreatePromptResponse = await created.json();
  expect(native.prompt.groupId).toBeTruthy();
  await page.goto('/c/new');
  await previewPrompt(page, 'My ordinary-chat default');
  await page
    .getByRole('button', { name: 'Set as default for ordinary chats', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Default instructions saved.' }),
  ).toBeVisible();

  for (const endpoint of MOCK_ENDPOINTS) {
    await page.goto('/c/new');
    await selectMockEndpoint(page, endpoint);
    await report(page, ['E2E_PROMPT_USER']);
  }

  await openPanel(page, 'Parameters');
  await page.getByRole('radio', { name: 'No instructions', exact: true }).check();
  await report(page, []);
  await page.reload();
  await report(page, []);
  await openPanel(page, 'Parameters');
  await page.getByRole('radio', { name: 'Custom instructions', exact: true }).check();
  await page
    .getByRole('textbox', { name: 'Custom instructions', exact: true })
    .fill('E2E_PROMPT_CUSTOM');
  await report(page, ['E2E_PROMPT_CUSTOM']);
  await page.goto('/c/new');
  const agentResponse = await request.post('/api/agents', {
    headers: auth,
    data: {
      name: 'Independent saved Agent',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      instructions: 'E2E_PROMPT_AGENT',
    },
  });
  expect(agentResponse.ok()).toBe(true);
  await page.reload();
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: 'My Agents', exact: true }).click();
  await page.getByRole('option', { name: 'Independent saved Agent', exact: true }).click();
  await report(page, ['E2E_PROMPT_AGENT']);
  await preferences(page, request, 'inherit');
});

test('model variables follow ordinary chats and saved Agents after reloads', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await page.goto('/c/new');
  await preferences(page, request, 'inherit');
  const created = await request.post('/api/prompts', {
    headers: await headers(page),
    data: {
      group: { name: 'Model context instructions' },
      prompt: { type: 'text', prompt: 'E2E_CONTEXT[model={{current_model}}]' },
    },
  });
  expect(created.ok()).toBe(true);
  await previewPrompt(page, 'Model context instructions');
  await page
    .getByRole('button', { name: 'Set as default for ordinary chats', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Default instructions saved.' }),
  ).toBeVisible();
  await page.goto('/c/new');

  for (const endpoint of MOCK_ENDPOINTS) {
    await selectMockEndpoint(page, endpoint);
    await report(page, [`E2E_CONTEXT[model=${endpoint.model}]`], 'Context');
  }

  await page.reload();
  await report(page, [`E2E_CONTEXT[model=${MOCK_ENDPOINTS[1].model}]`], 'Context');

  const agentResponse = await request.post('/api/agents', {
    headers: await headers(page),
    data: {
      name: 'Model context Agent',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      instructions: 'E2E_PROMPT_AGENT',
    },
  });
  expect(agentResponse.ok()).toBe(true);
  await page.goto('/c/new');
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: 'My Agents', exact: true }).click();
  await page.getByRole('option', { name: 'Model context Agent', exact: true }).click();
  await page.reload();
  await previewPrompt(page, 'Model context instructions');
  await page.getByRole('button', { name: 'Use Prompt', exact: true }).click();
  await expect(
    page
      .locator('.message-render')
      .getByText(
        `Context report: ${JSON.stringify({ system: [], user: [`E2E_CONTEXT[model=${MOCK_ENDPOINTS[0].model}]`] })}`,
        { exact: true },
      )
      .last(),
  ).toBeVisible();
  await preferences(page, request, 'inherit');
});

test('ordinary chats enable configured tools and preserve explicit choices', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await page.goto('/c/new');
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

  const enabledTools = page.getByTestId('composer-active-builtin');
  const code = enabledTools.filter({ hasText: 'Run Code' });
  await expect(enabledTools).toHaveText(['File Search', 'Run Code', 'Skills']);
  await code.getByRole('button', { name: 'Remove Run Code', exact: true }).click();
  await expect(enabledTools).toHaveText(['File Search', 'Skills']);
  const [chatRequest] = await Promise.all([
    page.waitForRequest(
      (sent) =>
        sent.method() === 'POST' &&
        new URL(sent.url()).pathname ===
          `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
    ),
    report(page, ['E2E_PROMPT_DEPLOYMENT']),
  ]);
  const payload: unknown = chatRequest.postDataJSON();
  expect(payload).toEqual(
    expect.objectContaining({
      ephemeralAgent: { execute_code: false, file_search: true, skills: true },
    }),
  );
  await page.reload();
  await expect(enabledTools).toHaveText(['File Search', 'Skills']);
  await page.getByTestId('new-chat-button').click();
  await expect(page).toHaveURL(/\/c\/new$/);
  await expect(enabledTools).toHaveText(['File Search', 'Skills']);
  await page.reload();
  await expect(enabledTools).toHaveText(['File Search', 'Skills']);

  const agentResponse = await request.post('/api/agents', {
    headers: await headers(page),
    data: {
      name: 'Independent tool Agent',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      instructions: 'E2E_PROMPT_AGENT',
    },
  });
  expect(agentResponse.ok()).toBe(true);
  await page.reload();
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: 'My Agents', exact: true }).click();
  await page.getByRole('option', { name: 'Independent tool Agent', exact: true }).click();
  await expect(enabledTools).toHaveCount(0);
  await report(page, ['E2E_PROMPT_AGENT']);
});
