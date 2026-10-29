const { FakeChatModel } = require('@librechat/agents');

class PromptReporter extends FakeChatModel {
  constructor(graph) {
    super({ responses: [''], sleep: 0 });
    this.graph = graph;
  }

  async *_streamResponseChunks(messages, options, runManager) {
    const agentId = runManager?.metadata?.agentId ?? options?.metadata?.agentId;
    let agentContext = this.graph.agentContexts.get(agentId);
    if (!agentContext && this.graph.agentContexts.size === 1) {
      agentContext = this.graph.agentContexts.values().next().value;
    }
    // Test overrides bypass the production model's systemRunnable pipe.
    const providerMessages = agentContext?.systemRunnable
      ? await agentContext.systemRunnable.invoke(messages)
      : messages;
    const tokens = (role) =>
      providerMessages
        .filter((message) => message._getType() === role)
        .flatMap((message) => JSON.stringify(message.content).match(/E2E_PROMPT_[A-Z]+/g) ?? []);
    const context = (role) =>
      providerMessages
        .filter((message) => message._getType() === role)
        .flatMap(
          (message) => JSON.stringify(message.content).match(/E2E_CONTEXT\[[^\]]*\]/g) ?? [],
        );
    const contextReport = { system: context('system'), user: context('human') };
    const lastHuman = [...messages].reverse().find((message) => message._getType() === 'human');
    if (lastHuman?.content === 'E2E_MCP_REPORT') {
      const active = (agentContext?.getToolsForBinding() ?? [])
        .map((tool) => tool.name)
        .filter((name) => name === 'tool_search' || name.includes('_mcp_'))
        .sort();
      const deferred = [...(agentContext?.toolRegistry?.values() ?? [])]
        .filter((tool) => tool.name.includes('_mcp_'))
        .map((tool) => ({ name: tool.name, deferred: tool.defer_loading === true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      this.responses = [`MCP report: \`${JSON.stringify({ active, deferred })}\``];
      yield* super._streamResponseChunks(messages, options, runManager);
      return;
    }
    this.responses = [
      contextReport.system.length + contextReport.user.length > 0
        ? `Context report: ${JSON.stringify(contextReport)}`
        : `Prompt report: ${JSON.stringify({ system: tokens('system'), user: tokens('human') })}`,
    ];
    yield* super._streamResponseChunks(messages, options, runManager);
  }
}

module.exports = function promptModelHook(run, context) {
  const model = new PromptReporter(run.Graph);
  model.callbacks = context.modelCallbacks;
  run.Graph.overrideModel = model;
};
