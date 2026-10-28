import mongoose from 'mongoose';
import { PermissionBits } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMethods,
  createModels,
  getConfigPromptIds,
  tenantStorage,
} from '@librechat/data-schemas';
import type { PromptLibraryConfig } from 'librechat-data-provider';
import { createConfigPromptCatalog } from './catalog';
import { createChatPromptService } from './defaults';
import { createPromptService } from './service';

const entries = [{ id: 'general', name: 'General assistant', prompt: 'Be helpful.' }];

function setup() {
  const syncConfigPrompts = jest.fn(async () => [{ id: 'general', groupId: 'group' }]);
  const grantPublicViewer = jest.fn(async () => undefined);
  const invalidateAccess = jest.fn(async () => undefined);
  return {
    ensure: createConfigPromptCatalog({ syncConfigPrompts, grantPublicViewer, invalidateAccess }),
    syncConfigPrompts,
    grantPublicViewer,
    invalidateAccess,
  };
}

describe('configuration prompt catalog', () => {
  it('coalesces concurrent requests and reuses an unchanged catalog', async () => {
    const { ensure, syncConfigPrompts, grantPublicViewer } = setup();
    const expected = new Map([['general', 'group']]);
    await expect(
      Promise.all([ensure({ library: entries }), ensure({ library: entries })]),
    ).resolves.toEqual([expected, expected]);
    await expect(ensure({ library: entries })).resolves.toEqual(expected);
    expect(syncConfigPrompts).toHaveBeenCalledTimes(1);
    expect(grantPublicViewer).toHaveBeenCalledWith('group');
  });

  it('synchronizes new contents and removals', async () => {
    const { ensure, syncConfigPrompts } = setup();
    await ensure({ library: entries });
    await ensure({ library: [{ ...entries[0], prompt: 'New instructions.' }] });
    await ensure();
    expect(syncConfigPrompts.mock.calls).toEqual([
      [entries],
      [[{ ...entries[0], prompt: 'New instructions.' }]],
      [[]],
    ]);
  });

  it('keeps tenant synchronization independent', async () => {
    const { ensure, syncConfigPrompts } = setup();
    await tenantStorage.run({ tenantId: 'a' }, () => ensure({ library: entries }));
    await tenantStorage.run({ tenantId: 'b' }, () => ensure({ library: entries }));
    expect(syncConfigPrompts).toHaveBeenCalledTimes(2);
  });

  it('retries failed synchronization instead of caching success', async () => {
    const { ensure, grantPublicViewer, syncConfigPrompts } = setup();
    grantPublicViewer.mockRejectedValueOnce(new Error('ACL unavailable'));
    await expect(ensure({ library: entries })).rejects.toThrow('ACL unavailable');
    await expect(ensure({ library: entries })).resolves.toEqual(new Map([['general', 'group']]));
    expect(syncConfigPrompts).toHaveBeenCalledTimes(2);
  });
});

describe('configuration catalogs across replicas', () => {
  let mongo: MongoMemoryServer;
  let db: ReturnType<typeof createMethods>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    db = createMethods(mongoose);
  });

  afterEach(async () => {
    await mongoose.models.Prompt.deleteMany({});
    await mongoose.models.PromptGroup.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  function replica(config: PromptLibraryConfig) {
    const service = createPromptService({
      db,
      grantPermission: async () => undefined,
      getAppConfig: jest.fn().mockResolvedValue({ prompts: config }),
    });
    const ensure = createConfigPromptCatalog({
      syncConfigPrompts: db.syncConfigPrompts,
      grantPublicViewer: async () => undefined,
      invalidateAccess: async () => undefined,
    });
    const defaults = createChatPromptService({
      promptService: service,
      ensureCatalog: ensure,
      getEffectivePermissions: async () => PermissionBits.VIEW,
      canUsePrompts: async () => true,
    });
    return { service, ensure: () => ensure(config), defaults };
  }

  it("preserves each replica's active contents and defaults when an older replica restarts", async () => {
    const originalConfig = { library: entries, defaultChatPrompt: 'general' };
    const currentConfig = {
      library: [
        { ...entries[0], name: 'Updated assistant', prompt: 'Current instructions.' },
        { id: 'second', name: 'Second assistant', prompt: 'Second instructions.' },
      ],
      defaultChatPrompt: 'second',
    };
    const original = replica(originalConfig);
    const originalGroups = await original.ensure();
    const generalId = originalGroups.get('general');
    if (generalId === undefined) {
      throw new Error('The original catalog did not create its general prompt.');
    }
    const originalResolved = await original.service.resolvePrompt({
      groupId: generalId,
      selection: { type: 'production' },
    });
    const current = replica(currentConfig);
    const currentGroups = await current.ensure();
    const secondId = currentGroups.get('second');
    if (secondId === undefined) {
      throw new Error('The current catalog did not create its second prompt.');
    }
    const currentResolved = await current.service.resolvePrompt({
      groupId: generalId,
      selection: { type: 'production' },
    });

    const restartedOriginal = replica(originalConfig);
    await restartedOriginal.ensure();

    expect(currentResolved).toEqual({
      ok: true,
      value: {
        ...getConfigPromptIds(currentConfig.library[0]),
        source: 'config',
        prompt: 'Current instructions.',
        type: 'text',
      },
    });

    await expect(
      current.service.resolvePrompt({
        groupId: generalId,
        selection: { type: 'production' },
      }),
    ).resolves.toEqual(currentResolved);
    await expect(
      restartedOriginal.service.resolvePrompt({
        groupId: generalId,
        selection: { type: 'production' },
      }),
    ).resolves.toEqual(originalResolved);
    await expect(
      current.defaults.resolveInstructions({
        user: { id: 'user', role: 'USER' },
        config: { prompts: currentConfig },
      }),
    ).resolves.toBe('Second instructions.');
    await expect(
      restartedOriginal.service.getPromptGroup({ groupId: secondId }),
    ).resolves.toBeNull();
    const secondPromptId = getConfigPromptIds(currentConfig.library[1]).promptId;
    await expect(
      restartedOriginal.service.getPrompt({ promptId: secondPromptId }),
    ).resolves.toBeNull();
    await expect(restartedOriginal.service.getPrompts({ groupId: secondId })).resolves.toEqual([]);
    await expect(
      current.service.resolvePrompt({
        groupId: generalId,
        selection: { type: 'exact', promptId: getConfigPromptIds(entries[0]).promptId },
      }),
    ).resolves.toEqual(originalResolved);

    await mongoose.models.PromptGroup.updateOne({ _id: secondId }, { numberOfGenerations: 10 });
    const listInput = {
      accessibleIds: [...currentGroups.values()],
      publiclyAccessibleIds: [...currentGroups.values()],
      ownedPromptGroupIds: [],
      forReuse: false,
      limit: 1,
      after: null,
    };
    const visible = await restartedOriginal.service.getListPromptGroupsByAccess(listInput);
    expect({
      groups: visible.data.map(({ _id, name, productionId, productionPrompt }) => ({
        _id,
        name,
        productionId,
        prompt: productionPrompt?.prompt,
      })),
      has_more: visible.has_more,
    }).toEqual({
      groups: [
        {
          _id: generalId,
          name: 'General assistant',
          productionId: getConfigPromptIds(entries[0]).promptId,
          prompt: 'Be helpful.',
        },
      ],
      has_more: false,
    });
    const searched = await current.service.getListPromptGroupsByAccess({
      ...listInput,
      name: 'Updated',
    });
    expect({
      groups: searched.data.map(({ _id, name, productionId, productionPrompt }) => ({
        _id,
        name,
        productionId,
        prompt: productionPrompt?.prompt,
      })),
      has_more: searched.has_more,
    }).toEqual({
      groups: [
        {
          _id: generalId,
          name: 'Updated assistant',
          productionId: getConfigPromptIds(currentConfig.library[0]).promptId,
          prompt: 'Current instructions.',
        },
      ],
      has_more: false,
    });
    expect({
      groups: await mongoose.models.PromptGroup.countDocuments(),
      revisions: await mongoose.models.Prompt.countDocuments(),
    }).toEqual({ groups: 2, revisions: 3 });
  });
});
