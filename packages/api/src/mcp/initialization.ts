import {
  Constants,
  isActionTool,
  splitMCPToolKey,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { MCPServerCatalogObserver, MCPInitializationServer } from './catalog/recovery';
import type { LCAvailableTools, ParsedServerConfig } from './types';
import { createDeadlineAbortSignal, waitUntilDeadline } from './utils';
import { getMCPServerNamesFromTools } from './oauth/events';

interface InitializationOptions {
  authorizationMode?: 'eager' | 'nonblocking';
  initializationTimeoutMs?: number;
  selectedTools?: readonly string[];
  knownServerNames?: readonly string[];
  accessibleServerNames?: readonly string[];
  signal?: AbortSignal;
}

interface PassiveCatalogs {
  serverTools: Map<string, LCAvailableTools>;
  reauthRequiredServers: Set<string>;
}

interface PassiveDiscoveryOptions {
  refresh: boolean;
  signal?: AbortSignal;
  onServerResult: MCPServerCatalogObserver;
}

interface InitializationDependencies {
  getServerConfig: (
    serverName: string,
    userId: string,
  ) => Promise<ParsedServerConfig | null | undefined>;
  loadPassiveCatalogs: (
    servers: readonly MCPInitializationServer[],
    options: PassiveDiscoveryOptions,
  ) => Promise<PassiveCatalogs>;
  getEagerTools: (userId: string, serverName: string) => Promise<LCAvailableTools | null>;
  refreshEagerTools: (userId: string, serverName: string) => Promise<LCAvailableTools | null>;
  captureServer: (serverName: string, config: ParsedServerConfig) => void;
  rememberAvailableTools: (serverName: string, tools: LCAvailableTools) => void;
}

interface ToolAvailability {
  hasExpectedTools: boolean;
  resolvedToolCount?: number;
  selectedTools: readonly string[];
  knownServerNames: readonly string[];
  unavailableError: Error;
}

interface MCPInitializationPolicy {
  getTools: InitializationDependencies['getEagerTools'];
  refreshTools: InitializationDependencies['refreshEagerTools'];
  assertToolsAvailable: (availability: ToolAvailability) => void;
}

type DiscoveryCompletion = { ok: true } | { ok: false; error: unknown };

async function observeDiscovery(work: Promise<void>): Promise<DiscoveryCompletion> {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

type DiscoveryState =
  | { status: 'available'; tools: LCAvailableTools }
  | { status: 'authentication_required' }
  | { status: 'unavailable' };

function isExpectedMCPSelection(tool: string): boolean {
  return (
    tool.includes(Constants.mcp_delimiter) &&
    !tool.startsWith(`${Constants.mcp_server}${Constants.mcp_delimiter}`) &&
    !isActionTool(tool)
  );
}

/** Resolves turn-local tool availability without starting interactive authorization in passive mode. */
export function createMCPInitializationPolicy(
  options: InitializationOptions,
  dependencies: InitializationDependencies,
): MCPInitializationPolicy {
  const states = new Map<string, DiscoveryState>();
  const configurations = new Map<
    string,
    ReturnType<InitializationDependencies['getServerConfig']>
  >();
  const resolvedConfigurations = new Map<string, ParsedServerConfig | null | undefined>();
  let discovery: Promise<DiscoveryCompletion> | undefined;
  let deadlineMs: number | undefined;

  const getConfig = async (userId: string, serverName: string) => {
    options.signal?.throwIfAborted();
    if (resolvedConfigurations.has(serverName)) {
      return resolvedConfigurations.get(serverName);
    }
    if (deadlineMs != null && Date.now() >= deadlineMs) {
      return undefined;
    }
    let pending = configurations.get(serverName);
    if (!pending) {
      pending = dependencies.getServerConfig(serverName, userId);
      configurations.set(serverName, pending);
    }
    const result = await waitUntilDeadline(pending, deadlineMs, options.signal);
    options.signal?.throwIfAborted();
    if (result.settled) {
      resolvedConfigurations.set(serverName, result.value);
      return result.value;
    }
    return undefined;
  };

  const observe: MCPServerCatalogObserver = (serverName, tools, authenticationRequired) => {
    if (options.signal?.aborted || (deadlineMs != null && Date.now() >= deadlineMs)) {
      return;
    }
    if (tools != null && Object.keys(tools).length > 0) {
      states.set(serverName, { status: 'available', tools });
      dependencies.rememberAvailableTools(serverName, tools);
      return;
    }
    states.set(serverName, {
      status: authenticationRequired ? 'authentication_required' : 'unavailable',
    });
  };

  const load = async (
    servers: readonly MCPInitializationServer[],
    refresh: boolean,
  ): Promise<void> => {
    const result = await dependencies.loadPassiveCatalogs(servers, {
      refresh,
      signal: createDeadlineAbortSignal(deadlineMs, options.signal),
      onServerResult: observe,
    });
    for (const { serverName } of servers) {
      observe(
        serverName,
        result.serverTools.get(serverName) ?? null,
        result.reauthRequiredServers.has(serverName),
      );
    }
  };

  const discoverSelected = async (userId: string, requestedServer: string): Promise<void> => {
    const selectedNames = getMCPServerNamesFromTools(
      (options.selectedTools ?? []).filter(isExpectedMCPSelection),
      options.knownServerNames,
    );
    selectedNames.add(requestedServer);
    const aliases = buildServerNameAliases(options.knownServerNames ?? []);
    for (const serverName of [...selectedNames]) {
      const alias = aliases.get(serverName);
      if (alias && options.accessibleServerNames?.includes(serverName) !== true) {
        selectedNames.add(alias);
      }
    }
    const servers: MCPInitializationServer[] = [...selectedNames].map((serverName) => ({
      serverName,
      resolveServerConfig: async () => {
        const serverConfig = await getConfig(userId, serverName);
        if (!serverConfig || 'command' in serverConfig) {
          states.set(serverName, { status: 'unavailable' });
          return null;
        }
        dependencies.captureServer(serverName, serverConfig);
        return serverConfig;
      },
    }));
    let loaded: Promise<DiscoveryCompletion> | undefined;
    await Promise.all(
      [...selectedNames].map(async (serverName) => {
        const config = await getConfig(userId, serverName);
        if (config && !('command' in config) && loaded == null) {
          loaded = observeDiscovery(load(servers, false));
        }
      }),
    );
    if (loaded) {
      const result = await loaded;
      if (!result.ok) {
        throw result.error;
      }
    }
  };

  const discover = async (
    userId: string,
    serverName: string,
    refresh = false,
  ): Promise<LCAvailableTools | null> => {
    if (options.authorizationMode !== 'nonblocking') {
      return refresh
        ? dependencies.refreshEagerTools(userId, serverName)
        : dependencies.getEagerTools(userId, serverName);
    }

    options.signal?.throwIfAborted();
    deadlineMs ??= Date.now() + (options.initializationTimeoutMs ?? 3_000);
    discovery ??= observeDiscovery(discoverSelected(userId, serverName));
    const config = await getConfig(userId, serverName);
    if (!config) {
      states.set(serverName, { status: 'unavailable' });
      return null;
    }
    if ('command' in config) {
      return refresh
        ? dependencies.refreshEagerTools(userId, serverName)
        : dependencies.getEagerTools(userId, serverName);
    }

    if (Date.now() < deadlineMs) {
      const completed = await waitUntilDeadline(discovery, deadlineMs, options.signal);
      if (completed.settled && !completed.value.ok) {
        throw completed.value.error;
      }
    }
    options.signal?.throwIfAborted();
    if (refresh && states.get(serverName)?.status === 'available' && Date.now() < deadlineMs) {
      await waitUntilDeadline(
        load([{ serverName, serverConfig: config }], true),
        deadlineMs,
        options.signal,
      );
    }
    options.signal?.throwIfAborted();
    const state = states.get(serverName);
    return state?.status === 'available' ? state.tools : null;
  };

  return {
    getTools: (userId, serverName) => discover(userId, serverName),
    refreshTools: (userId, serverName) => discover(userId, serverName, true),
    assertToolsAvailable: ({
      hasExpectedTools,
      resolvedToolCount,
      selectedTools,
      knownServerNames,
      unavailableError,
    }): void => {
      if (!hasExpectedTools || resolvedToolCount !== 0) {
        return;
      }
      const aliases = buildServerNameAliases(knownServerNames);
      const expected = selectedTools.filter(isExpectedMCPSelection);
      const onlyAuthenticationPending =
        options.authorizationMode === 'nonblocking' &&
        expected.length > 0 &&
        expected.every((tool) => {
          const [, parsed] = splitMCPToolKey(tool, knownServerNames);
          if (!parsed) {
            return false;
          }
          const direct = states.get(parsed);
          if (direct?.status === 'authentication_required') {
            return true;
          }
          if (options.accessibleServerNames?.includes(parsed)) {
            return false;
          }
          return states.get(aliases.get(parsed) ?? parsed)?.status === 'authentication_required';
        });
      if (onlyAuthenticationPending) {
        return;
      }
      throw unavailableError;
    },
  };
}
