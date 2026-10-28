import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ChatInstructions } from 'librechat-data-provider';
import { createPresetModel } from '~/models/preset';
import { createPresetMethods } from './preset';

const Preset = createPresetModel(mongoose);
const methods = createPresetMethods(mongoose);
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongoServer.getUri());
  await Preset.init();
});

afterEach(async () => {
  await Preset.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  mongoose.deleteModel('Preset');
  await mongoServer.stop();
});

describe('preset chat instructions', () => {
  const selections: ChatInstructions[] = [
    { mode: 'inherit' },
    { mode: 'none' },
    { mode: 'custom', text: '  Answer in Welsh.\n' },
  ];

  it.each(selections)('round trips $mode instructions through savePreset', async (selection) => {
    await methods.savePreset('user-1', {
      presetId: 'ordinary-chat',
      endpoint: 'openAI',
      chatInstructions: { mode: 'custom', text: 'Previous instructions' },
    });
    await methods.savePreset('user-1', {
      presetId: 'ordinary-chat',
      endpoint: 'openAI',
      chatInstructions: selection,
    });

    const presets = await methods.getPresets('user-1');
    if (!Array.isArray(presets)) {
      throw new Error('Could not reload saved presets');
    }

    expect(
      presets.map(({ presetId, chatInstructions }) => ({ presetId, chatInstructions })),
    ).toStrictEqual([{ presetId: 'ordinary-chat', chatInstructions: selection }]);
  });

  it('keeps legacy presets without an instruction selection', async () => {
    await methods.savePreset('user-1', {
      presetId: 'legacy-chat',
      endpoint: 'openAI',
      promptPrefix: 'Legacy instructions',
    });

    expect(
      await Preset.findOne({ presetId: 'legacy-chat', user: 'user-1' })
        .select({ _id: 0, promptPrefix: 1, chatInstructions: 1 })
        .lean(),
    ).toStrictEqual({ promptPrefix: 'Legacy instructions' });
  });
});
