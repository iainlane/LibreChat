import { EModelEndpoint, parseCompactConvo, parseEphemeralAgentId } from 'librechat-data-provider';
import type { AgentModelParameters, ChatInstructions, TModelSpec } from 'librechat-data-provider';
import type { LoadAgentDeps } from './load';
import { createChatPromptService } from '~/prompts/defaults';
import { applyModelSpecPreset } from '~/modelSpecs';
import { loadEphemeralAgent } from './load';
import { resolveSender } from './sender';

const deps: LoadAgentDeps = {
  getAgent: async () => null,
  getMCPServerTools: async () => null,
};

const baseReq = {
  user: { id: 'user-1' },
  config: {
    modelSpecs: { list: [{ name: 'my-opus-spec', label: 'Spec Label' }] },
  },
  body: {},
} as unknown as Parameters<typeof loadEphemeralAgent>[0]['req'];

async function idFor(modelParameters: Record<string, unknown>) {
  const agent = await loadEphemeralAgent(
    {
      req: baseReq,
      spec: 'my-opus-spec',
      endpoint: 'my-custom-endpoint',
      model_parameters: modelParameters as never,
    },
    deps,
  );
  return agent?.id;
}

/**
 * Documents the #14253 Bug 2 mechanism: the ephemeral agent id (LangGraph node /
 * HITL checkpoint namespace) is derived from `sender = modelLabel ?? modelSpec.label`.
 * When the resume drops `modelLabel`, the id drifts and the paused checkpoint can't be
 * re-entered. The fix keeps `modelLabel` across resume (RESUME_CONTEXT_KEYS), so the
 * original and resumed ids stay equal.
 */
describe('loadEphemeralAgent ephemeral id stability (#14253 Bug 2)', () => {
  test('id changes when modelLabel is lost vs preserved', async () => {
    const withLabel = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const withoutLabel = await idFor({ model: 'claude-opus-4' });
    expect(withLabel).toBeTruthy();
    expect(withoutLabel).toBeTruthy();
    // Original turn (has modelLabel) vs a resume that dropped it → different namespace.
    expect(withLabel).not.toEqual(withoutLabel);
  });

  test('id is stable when modelLabel is preserved across turns', async () => {
    const a = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const b = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    expect(a).toEqual(b);
  });
});

/** Custom endpoints carry their configured name in `endpoint` at runtime,
 *  which `TEndpointOption` types as `EModelEndpoint`. */
const customEndpointOption = {
  endpoint: 'my-custom-endpoint' as EModelEndpoint,
  model: 'claude-opus-4',
};

describe('loadEphemeralAgent → resolveSender parity', () => {
  test('the persisted sender matches the spec label encoded into the agent id', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4' } as never,
      },
      deps,
    );
    expect(agent?.id).toBeTruthy();
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: customEndpointOption,
    });
    expect(sender).toBe('Spec Label');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });

  test('a user modelLabel wins over the spec label in the persisted sender', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4', modelLabel: 'My Opus' } as never,
      },
      deps,
    );
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: { ...customEndpointOption, modelLabel: 'My Opus' },
    });
    expect(sender).toBe('My Opus');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });
});

describe.each([false, true])('ordinary-chat instruction policy (enforced: %s)', (enforced) => {
  const modelSpec: TModelSpec = {
    name: 'guarded-chat',
    label: 'Guarded chat',
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      promptPrefix: 'Administrator instructions.',
    },
  };
  const selections: { selection: ChatInstructions; expected: string }[] = [
    { selection: { mode: 'custom', text: 'User replacement.' }, expected: 'User replacement.' },
    { selection: { mode: 'none' }, expected: '' },
    { selection: { mode: 'inherit' }, expected: '' },
  ];

  it.each(selections)(
    'applies the validated selection: $selection.mode',
    async ({ selection, expected }) => {
      const body = {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        spec: modelSpec.name,
        chatInstructions: selection,
      };
      const parsedRequest = parseCompactConvo({
        endpoint: body.endpoint,
        conversation: body,
      });
      expect(parsedRequest).not.toBeNull();
      const { parsedBody } = applyModelSpecPreset({
        modelSpec,
        endpoint: body.endpoint,
        parsedBody: parsedRequest ?? {},
        includePresetDefaults: enforced,
      });
      const {
        spec,
        iconURL: _iconURL,
        agent_id: _agentId,
        chatProjectId: _chatProjectId,
        ...modelParameters
      } = parsedBody;
      const promptService = createChatPromptService({
        ensureCatalog: async () => new Map(),
        canUsePrompts: async () => true,
        getEffectivePermissions: async () => {
          throw new Error('No default prompt should be resolved.');
        },
        promptService: {
          getPromptGroup: async () => {
            throw new Error('No default prompt should be resolved.');
          },
          resolvePrompt: async () => {
            throw new Error('No default prompt should be resolved.');
          },
        },
      });
      const agent = await loadEphemeralAgent(
        {
          req: { user: { id: 'user-1' }, body },
          spec: typeof spec === 'string' ? spec : undefined,
          endpoint: body.endpoint,
          model_parameters: modelParameters as AgentModelParameters,
        },
        { ...deps, resolveChatInstructions: promptService.resolveInstructions },
      );

      expect({
        instructions: agent?.instructions,
        hasInstructionSelection: 'chatInstructions' in (agent?.model_parameters ?? {}),
      }).toStrictEqual({
        instructions: enforced ? modelSpec.preset.promptPrefix : expected,
        hasInstructionSelection: false,
      });
    },
  );
});
