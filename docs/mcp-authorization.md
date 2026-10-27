# MCP authentication during chat

Set the deployment-wide authentication policy in `librechat.yaml`:

```yaml
mcpSettings:
  authorizationMode: nonblocking
  initializationTimeoutMs: 3000

endpoints:
  agents:
    capabilities:
      - tools
      - deferred_tools
```

`authorizationMode` defaults to `eager`, which preserves the existing MCP
initialization behavior, including per-server `oauthPrompt` settings.

## Nonblocking discovery

In `nonblocking` mode, tool discovery does not start an interactive OAuth flow
or wait for consent. LibreChat reuses eligible cached definitions or attempts
passive discovery with the current connection and credentials. A protected
server that needs authentication contributes no unknown tool definitions, but
the conversation can continue with its other tools. The MCP connection UI
provides the Connect action.

`initializationTimeoutMs` bounds the total remote discovery wait for a turn,
including catalog refreshes. It defaults to 3000 milliseconds and accepts
values from 1 to 60000. Tools discovered before the deadline remain available
when another server is slow. Existing catalog recovery manages discovery
cleanup and shared credential work after the caller stops waiting.

When a server's tool definitions are known, calling one of its tools can request
authentication through the existing in-run OAuth flow. Selecting an agent or
sending an unrelated message does not request that authentication.

Tool search uses the current discovered definitions. An operator does not need
to copy tool names or schemas into `oauthToolCatalog`. Whole-server selections
include the tools available through the current catalog. Explicit individual
selections remain individual selections.

With the `deferred_tools` capability enabled, MCP tools default to deferred
loading. An explicit `defer_loading: false` still loads that tool's schema up
front. Schema loading and authentication timing are separate policies.

## Connection and access failures

Authentication requirements are distinct from missing configuration or denied
access. The nonblocking policy does not grant access, change tool permissions,
or reuse another user's private tool catalog. Existing configuration,
credential and request-scope restrictions still apply to catalog reuse.

Use Connect to authenticate a protected server with no known tools. LibreChat
then discovers its tools and refreshes their availability. Request-scoped local
MCPs retain their conversation-specific connection lifecycle.
