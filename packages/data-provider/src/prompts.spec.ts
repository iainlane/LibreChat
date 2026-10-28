import {
  chatInstructionsSchema,
  chatPromptDefaultSchema,
  hasPromptInputVariables,
} from './prompts';
import { EModelEndpoint } from './schemas';
import { configSchema } from './config';
import { parseConvo } from './parsers';

const groupId = 'a'.repeat(24);
const promptId = 'b'.repeat(24);

describe('ordinary chat prompt contracts', () => {
  it.each([{ mode: 'inherit' }, { mode: 'none' }, { mode: 'custom', text: 'Explain clearly.' }])(
    'preserves the explicit instruction selection: %j',
    (selection) => {
      expect(chatInstructionsSchema.parse(selection)).toStrictEqual(selection);
    },
  );

  it.each([
    { mode: 'inherit' },
    { mode: 'none' },
    { mode: 'prompt', groupId, selection: { type: 'production' } },
    { mode: 'prompt', groupId, selection: { type: 'exact', promptId } },
  ])('preserves the user default selection: %j', (selection) => {
    expect(chatPromptDefaultSchema.parse(selection)).toStrictEqual(selection);
  });

  it.each([
    { mode: 'custom' },
    { mode: 'none', text: 'Conflicting instructions' },
    { mode: 'custom', text: 12 },
  ])('rejects malformed conversation instructions: %j', (selection) => {
    expect(chatInstructionsSchema.safeParse(selection).success).toBe(false);
  });

  it.each([
    {
      library: [{ id: 'general', name: 'General', prompt: 'Be helpful.' }],
      defaultChatPrompt: 'missing',
    },
    {
      library: [
        { id: 'general', name: 'First', prompt: 'First.' },
        { id: 'general', name: 'Second', prompt: 'Second.' },
      ],
    },
  ])('rejects an ambiguous or missing deployment prompt: %j', (prompts) => {
    expect(configSchema.safeParse({ version: '1.3.18', prompts }).success).toBe(false);
  });

  it('retains a configured library and ordinary-chat default', () => {
    const prompts = {
      library: [{ id: 'general', name: 'General assistant', prompt: 'Be helpful.\n' }],
      defaultChatPrompt: 'general',
    };
    expect(configSchema.parse({ version: '1.3.18', prompts }).prompts).toStrictEqual(prompts);
  });
});

describe('ordinary chat instruction persistence', () => {
  it.each([
    EModelEndpoint.openAI,
    EModelEndpoint.anthropic,
    EModelEndpoint.google,
    EModelEndpoint.bedrock,
  ])('retains an explicit opt-out while parsing %s parameters', (endpoint) => {
    const parsed = parseConvo({
      endpoint,
      conversation: { model: 'test-model', chatInstructions: { mode: 'none' } },
    });
    expect(parsed?.chatInstructions).toStrictEqual({ mode: 'none' });
  });
});

describe('chat default prompt variables', () => {
  it.each(['topic', 'tone:formal|casual', 'constructor', 'current_model:one|two'])(
    'recognises the unresolved %s variable',
    (variable) => {
      expect(hasPromptInputVariables(`Hello {{${variable}}}.`)).toBe(true);
    },
  );

  it.each([
    'Be helpful.',
    'Use {braces} in JSON examples.',
    ...[
      'current_user',
      'current_date',
      'iso_datetime',
      'current_datetime',
      'current_model',
    ].flatMap((variable) => [`Hello {{${variable}}}.`, `Hello {{  ${variable.toUpperCase()}\t}}.`]),
  ])('accepts text without interactive variables: %s', (prompt) => {
    expect(hasPromptInputVariables(prompt)).toBe(false);
  });
});
