import type { ParsedServerConfig } from './types';
import { createMCPInitializationPolicy } from './initialization';

const tools = {
  read_mcp_remote: {
    type: 'function' as const,
    function: { name: 'read_mcp_remote', description: 'Read a document', parameters: {} },
  },
};

function fixture(authorizationMode: 'eager' | 'nonblocking' = 'nonblocking') {
  const dependencies = {
    getServerConfig: jest
      .fn()
      .mockResolvedValue({ type: 'streamable-http', url: 'https://mcp.example' }),
    loadPassiveCatalogs: jest.fn().mockResolvedValue({
      serverTools: new Map(),
      reauthRequiredServers: new Set(['remote']),
    }),
    getEagerTools: jest.fn().mockResolvedValue(tools),
    refreshEagerTools: jest.fn().mockResolvedValue(tools),
    captureServer: jest.fn(),
    rememberAvailableTools: jest.fn(),
  };
  const policy = createMCPInitializationPolicy({ authorizationMode }, dependencies);
  return { dependencies, policy };
}

describe('nonblocking MCP initialization', () => {
  it.each(['deadline', 'cancellation'] as const)(
    'bounds the first registry read by %s',
    async (termination) => {
      let release: (config: ParsedServerConfig) => void = () => {};
      try {
        const { dependencies } = fixture();
        dependencies.getServerConfig.mockReturnValue(
          new Promise<ParsedServerConfig>((resolve) => {
            release = resolve;
          }),
        );
        const controller = new AbortController();
        const reason = new Error('turn cancelled');
        const policy = createMCPInitializationPolicy(
          {
            authorizationMode: 'nonblocking',
            initializationTimeoutMs: 10,
            signal: controller.signal,
          },
          dependencies,
        );
        const pending = policy.getTools('user', 'remote');
        if (termination === 'cancellation') {
          controller.abort(reason);
          await expect(pending).rejects.toBe(reason);
          return;
        }
        await expect(pending).resolves.toBeNull();
        expect(dependencies.loadPassiveCatalogs).not.toHaveBeenCalled();
      } finally {
        release({ type: 'streamable-http', url: 'https://mcp.example' });
      }
    },
  );

  it.each(['fast', 'slow'])(
    'retains ready peers when %s registry lookup is requested first',
    async (first) => {
      let release: (config: ParsedServerConfig) => void = () => {};
      const pendingConfig = new Promise<ParsedServerConfig>((resolve) => {
        release = resolve;
      });
      const { dependencies } = fixture();
      dependencies.getServerConfig.mockImplementation((serverName: string) =>
        serverName === 'slow'
          ? pendingConfig
          : Promise.resolve({ type: 'streamable-http', url: 'https://fast.example/mcp' }),
      );
      dependencies.loadPassiveCatalogs.mockResolvedValue({
        serverTools: new Map([['fast', tools]]),
        reauthRequiredServers: new Set(),
      });
      const policy = createMCPInitializationPolicy(
        {
          authorizationMode: 'nonblocking',
          initializationTimeoutMs: 20,
          selectedTools: ['sys__all__sys_mcp_slow', 'sys__all__sys_mcp_fast'],
          knownServerNames: ['slow', 'fast'],
        },
        dependencies,
      );
      try {
        await policy.getTools('user', first);
        expect(await policy.getTools('user', 'fast')).toStrictEqual(tools);
        expect(dependencies.loadPassiveCatalogs).toHaveBeenCalledTimes(1);
      } finally {
        release({ type: 'streamable-http', url: 'https://slow.example/mcp' });
      }
    },
  );

  it('batches selected servers under one deadline and keeps confirmed fast results', async () => {
    jest.useFakeTimers();
    try {
      const { dependencies } = fixture();
      let finishDiscovery = () => {};
      dependencies.loadPassiveCatalogs.mockImplementation(async (_servers, options) => {
        options.onServerResult('fast', tools, false);
        await new Promise<void>((resolve) => {
          finishDiscovery = resolve;
        });
        return { serverTools: new Map([['fast', tools]]), reauthRequiredServers: new Set() };
      });
      const policy = createMCPInitializationPolicy(
        {
          authorizationMode: 'nonblocking',
          initializationTimeoutMs: 50,
          selectedTools: [
            'sys__all__sys_mcp_slow1',
            'sys__all__sys_mcp_slow2',
            'sys__all__sys_mcp_fast',
          ],
          knownServerNames: ['slow1', 'slow2', 'fast'],
        },
        dependencies,
      );
      const pending = policy.getTools('user', 'slow1');
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(50);
      expect(await pending).toBeNull();
      expect(await policy.getTools('user', 'slow2')).toBeNull();
      expect(await policy.getTools('user', 'fast')).toStrictEqual(tools);
      expect(dependencies.loadPassiveCatalogs).toHaveBeenCalledTimes(1);
      expect(
        dependencies.loadPassiveCatalogs.mock.calls[0][0].map(
          ({ serverName }: { serverName: string }) => serverName,
        ),
      ).toStrictEqual(['slow1', 'slow2', 'fast']);
      finishDiscovery();
      await jest.runAllTimersAsync();
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues ordinary inference when all selected MCPs require authentication', async () => {
    const { dependencies, policy } = fixture();
    expect(await policy.getTools('user', 'remote')).toBeNull();
    expect(dependencies.getEagerTools).not.toHaveBeenCalled();
    expect(() =>
      policy.assertToolsAvailable({
        hasExpectedTools: true,
        resolvedToolCount: 0,
        selectedTools: ['sys__all__sys_mcp_remote'],
        knownServerNames: ['remote'],
        unavailableError: new Error('unavailable'),
      }),
    ).not.toThrow();
  });

  it('does not hide missing or forbidden server selections behind an OAuth-pending server', async () => {
    const { dependencies, policy } = fixture();
    dependencies.getServerConfig.mockImplementation(async (serverName: string) =>
      serverName === 'remote' ? { type: 'streamable-http', url: 'https://mcp.example' } : null,
    );
    await policy.getTools('user', 'remote');
    await policy.getTools('user', 'missing');
    expect(() =>
      policy.assertToolsAvailable({
        hasExpectedTools: true,
        resolvedToolCount: 0,
        selectedTools: ['sys__all__sys_mcp_remote', 'sys__all__sys_mcp_missing'],
        knownServerNames: ['remote', 'missing'],
        unavailableError: new Error('unavailable'),
      }),
    ).toThrow('unavailable');
  });

  it('uses automatically discovered tools without an operator catalogue', async () => {
    const { dependencies, policy } = fixture();
    dependencies.loadPassiveCatalogs.mockResolvedValue({
      serverTools: new Map([['remote', tools]]),
      reauthRequiredServers: new Set(),
    });
    expect(await policy.getTools('user', 'remote')).toStrictEqual(tools);
    expect(await policy.getTools('user', 'remote')).toStrictEqual(tools);
    expect(dependencies.loadPassiveCatalogs).toHaveBeenCalledTimes(1);
  });

  it('retains eager mode and the request-scoped local connection owner', async () => {
    const eager = fixture('eager');
    expect(await eager.policy.getTools('user', 'remote')).toStrictEqual(tools);
    expect(eager.dependencies.loadPassiveCatalogs).not.toHaveBeenCalled();
    const scoped = fixture();
    scoped.dependencies.getServerConfig.mockResolvedValue({
      command: 'runtime-mcp',
      args: ['{{LIBRECHAT_BODY_CONVERSATIONID}}'],
    });
    expect(await scoped.policy.getTools('user', 'remote')).toStrictEqual(tools);
    expect(scoped.dependencies.loadPassiveCatalogs).not.toHaveBeenCalled();
  });
});
