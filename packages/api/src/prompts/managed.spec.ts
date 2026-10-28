import type { PromptGroupRecord, PromptStore } from './types';
import { createPromptServiceFromAdapters } from './service';
import { createNativePromptAdapter } from './native';

const groupId = '123456789012345678901234';
const promptId = '123456789012345678901235';
const group: PromptGroupRecord = {
  _id: groupId,
  name: 'Managed prompt',
  source: 'config',
  author: 'system',
  authorName: 'Deployment',
  productionId: promptId,
};

function setup() {
  const store = {
    getPromptGroup: jest.fn(async () => group),
    getPrompt: jest.fn(async () => ({
      _id: promptId,
      groupId,
      author: 'system',
      prompt: 'Managed instructions.',
      type: 'text' as const,
    })),
    getPrompts: jest.fn(async () => []),
    getListPromptGroupsByAccess: jest.fn(),
    updatePromptGroup: jest.fn(),
    incrementPromptGroupUsage: jest.fn(),
    deletePromptGroup: jest.fn(),
    createPromptGroup: jest.fn(),
    savePrompt: jest.fn(),
    makePromptProduction: jest.fn(),
    deletePrompt: jest.fn(),
    findSourceGroup: jest.fn(),
    createSourceGroup: jest.fn(),
  } satisfies PromptStore;
  const service = createPromptServiceFromAdapters({
    store,
    sources: {
      native: createNativePromptAdapter(store),
      config: createNativePromptAdapter(store, 'config'),
      langfuse: { resolvePrompt: jest.fn() },
    },
    grantCreatorOwnership: jest.fn(),
    grantPublicViewer: jest.fn(),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
  return { service, store };
}

describe('managed library prompts', () => {
  it.each([{ type: 'production' as const }, { type: 'exact' as const, promptId }])(
    'resolves %j with managed provenance',
    async (selection) => {
      const { service } = setup();
      await expect(service.resolvePrompt({ groupId, selection })).resolves.toEqual({
        ok: true,
        value: {
          source: 'config',
          groupId,
          promptId,
          prompt: 'Managed instructions.',
          type: 'text' as const,
        },
      });
    },
  );

  it('rejects every content and metadata mutation', async () => {
    const { service, store } = setup();
    const expected = { ok: false, error: { type: 'read_only', source: 'config' } };
    await expect(
      Promise.all([
        service.savePrompt({ groupId, prompt: { prompt: 'Edited', type: 'text' }, author: 'user' }),
        service.updatePromptGroup({ groupId, updates: { name: 'Edited' } }),
        service.makePromptProduction({ promptId }),
        service.deletePrompt({ groupId, promptId }),
        service.deletePromptGroup({ groupId }),
      ]),
    ).resolves.toEqual([expected, expected, expected, expected, expected]);
    expect(
      [
        store.savePrompt,
        store.updatePromptGroup,
        store.makePromptProduction,
        store.deletePrompt,
        store.deletePromptGroup,
      ].map((fn) => jest.mocked(fn).mock.calls),
    ).toEqual([[], [], [], [], []]);
  });
});
