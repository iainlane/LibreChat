import { createChatPromptService, ChatPromptUnavailableError } from './defaults';

const groupId = '123456789012345678901234';
const promptId = '123456789012345678901235';
const reference = { mode: 'prompt' as const, groupId, selection: { type: 'production' as const } };

function setup() {
  const group = {
    _id: groupId,
    name: 'General assistant',
    author: 'author',
    authorName: 'Author',
    source: 'native' as const,
  };
  const resolvePrompt = jest.fn(async () => ({
    ok: true as const,
    value: {
      source: 'native' as const,
      groupId,
      promptId,
      prompt: 'Be helpful.',
      type: 'text' as const,
    },
  }));
  const getEffectivePermissions = jest.fn(async () => 1);
  const ensureCatalog = jest.fn(async () => new Map([['general', groupId]]));
  const getPromptGroup = jest.fn(async () => ({ ok: true as const, value: group }));
  const service = createChatPromptService({
    promptService: { resolvePrompt, getPromptGroup },
    getEffectivePermissions,
    ensureCatalog,
    canUsePrompts: async () => true,
  });
  return { service, resolvePrompt, getEffectivePermissions, ensureCatalog, getPromptGroup };
}

const user = { id: 'user', role: 'USER' };

describe('ordinary chat instructions', () => {
  it.each([
    [{ mode: 'none' as const }, ''],
    [{ mode: 'custom' as const, text: 'Custom instructions.' }, 'Custom instructions.'],
  ])('respects explicit conversation selection %j', async (chatInstructions, expected) => {
    const { service, resolvePrompt } = setup();
    await expect(service.resolveInstructions({ user, config: {}, chatInstructions })).resolves.toBe(
      expected,
    );
    expect(resolvePrompt).not.toHaveBeenCalled();
  });

  it('resolves the deployment default as instructions', async () => {
    const { service, resolvePrompt } = setup();
    await expect(
      service.resolveInstructions({
        user,
        config: { prompts: { library: [], defaultChatPrompt: 'general' } },
      }),
    ).resolves.toBe('Be helpful.');
    expect(resolvePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ groupId, selection: { type: 'production' } }),
    );
  });

  it('uses the user default before the deployment default', async () => {
    const { service } = setup();
    await expect(
      service.resolveInstructions({
        user: { ...user, personalization: { defaultChatPrompt: { mode: 'none' } } },
        config: { prompts: { library: [], defaultChatPrompt: 'general' } },
      }),
    ).resolves.toBe('');
  });

  it('preserves legacy custom prompt prefixes', async () => {
    const { service, resolvePrompt } = setup();
    await expect(
      service.resolveInstructions({ user, config: {}, legacyInstructions: 'Legacy custom.' }),
    ).resolves.toBe('Legacy custom.');
    expect(resolvePrompt).not.toHaveBeenCalled();
  });

  it('fails closed when a configured default has disappeared', async () => {
    const { service, ensureCatalog } = setup();
    ensureCatalog.mockResolvedValue(new Map());
    await expect(
      service.resolveInstructions({
        user,
        config: { prompts: { library: [], defaultChatPrompt: 'missing' } },
      }),
    ).rejects.toBeInstanceOf(ChatPromptUnavailableError);
  });

  it('rechecks access before resolving a stored preference', async () => {
    const { service, getEffectivePermissions, resolvePrompt } = setup();
    getEffectivePermissions.mockResolvedValue(0);
    await expect(
      service.resolveInstructions({
        user: { ...user, personalization: { defaultChatPrompt: reference } },
        config: {},
      }),
    ).rejects.toBeInstanceOf(ChatPromptUnavailableError);
    expect(resolvePrompt).not.toHaveBeenCalled();
  });

  it.each(['topic', 'current_user', 'current_date', 'iso_datetime', 'current_datetime'])(
    'rejects a default prompt with the unresolved %s variable',
    async (variable) => {
      const { service, resolvePrompt } = setup();
      resolvePrompt.mockResolvedValue({
        ok: true,
        value: {
          source: 'native',
          groupId,
          promptId,
          prompt: `Help {{${variable}}}.`,
          type: 'text',
        },
      });
      await expect(
        service.resolveInstructions({
          user: { ...user, personalization: { defaultChatPrompt: reference } },
          config: {},
        }),
      ).rejects.toBeInstanceOf(ChatPromptUnavailableError);
    },
  );
});
