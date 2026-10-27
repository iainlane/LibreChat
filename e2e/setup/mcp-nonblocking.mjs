import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'ready-file': { type: 'string' },
    'package-root': { type: 'string', default: resolve(import.meta.dirname, '../..') },
    'base-url': { type: 'string' },
    'fixture-url': { type: 'string' },
    email: { type: 'string' },
    provider: { type: 'string', default: 'anthropic' },
    model: { type: 'string', default: 'claude-sonnet-4-5-20250929' },
  },
});
const serverName = 'oauth-fixture';
const userAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const reply = 'The model replied without waiting for MCP authentication.';
const toolReply = 'The authenticated MCP tool completed.';

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function serve() {
  assert(values['ready-file'], 'serve requires --ready-file');
  const require = createRequire(resolve(values['package-root'], 'package.json'));
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const {
    StreamableHTTPServerTransport,
  } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const sessions = new Map();
  const state = { modelRequests: [], authorizations: 0, grants: 0, toolCalls: 0, revoked: false };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === '/state') {
        return json(response, 200, state);
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        state.revoked = true;
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/authorize') {
        state.authorizations++;
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', 'fixture-code');
        callback.searchParams.set('state', url.searchParams.get('state'));
        response.writeHead(302, { Location: callback.toString() }).end();
        return;
      }
      if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        const form = new URLSearchParams(body);
        state.grants++;
        if (state.revoked && form.get('grant_type') === 'refresh_token') {
          return json(response, 400, { error: 'invalid_grant' });
        }
        state.revoked = false;
        return json(response, 200, {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname.startsWith('/.well-known/')) {
        return json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.pathname === '/mcp') {
        if (request.headers.authorization !== 'Bearer fixture-access' || state.revoked) {
          response.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          );
          return json(response, 401, { error: 'invalid_token' });
        }
        const sessionId = request.headers['mcp-session-id'];
        let transport = sessions.get(sessionId);
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
          const mcp = new McpServer({ name: 'nonblocking-fixture', version: '1.0.0' });
          mcp.registerTool(
            'echo',
            {
              description: 'Return the authenticated fixture result.',
              inputSchema: {},
            },
            async () => {
              state.toolCalls++;
              return { content: [{ type: 'text', text: toolReply }] };
            },
          );
          await mcp.connect(transport);
        }
        await transport.handleRequest(request, response);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, transport);
          transport.onclose = () => sessions.delete(transport.sessionId);
        }
        return;
      }
      if (
        (url.pathname === '/v1/messages' || url.pathname === '/messages') &&
        request.method === 'POST'
      ) {
        const body = await readJson(request);
        state.modelRequests.push(body);
        const text = JSON.stringify(body.messages);
        const calledEcho = text.includes(toolReply);
        const wantsTool = text.includes('CALL_AUTHENTICATED_MCP');
        const names = (body.tools ?? []).map((tool) => tool.name);
        const tool =
          wantsTool && !calledEcho
            ? (names.find((name) => name.startsWith('echo_mcp_')) ??
              names.find((name) => name === 'tool_search'))
            : undefined;
        const content = tool
          ? [
              {
                type: 'tool_use',
                id: `toolu_${randomUUID()}`,
                name: tool,
                input: tool === 'tool_search' ? { query: 'echo authenticated fixture' } : {},
              },
            ]
          : [{ type: 'text', text: calledEcho ? toolReply : reply }];
        const message = {
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content,
          stop_reason: tool ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        };
        if (!body.stream) {
          return json(response, 200, message);
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const event = (type, data) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('message_start', {
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        for (const [index, block] of content.entries()) {
          event('content_block_start', {
            index,
            content_block:
              block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
          });
          event('content_block_delta', {
            index,
            delta:
              block.type === 'text'
                ? { type: 'text_delta', text: block.text }
                : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          });
          event('content_block_stop', { index });
        }
        event('message_delta', {
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 10 },
        });
        event('message_stop', {});
        response.end();
        return;
      }
      json(response, 404, { error: 'Unknown fixture route' });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        json(response, 500, { error: 'Fixture request failed' });
      }
      response.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(
    values['ready-file'],
    JSON.stringify({
      origin,
      anthropicBaseURL: origin,
      serverName,
      model: values.model,
      mcpServer: {
        type: 'streamable-http',
        url: `${origin}/mcp`,
        startup: false,
        requiresOAuth: true,
        oauth: {
          authorization_url: `${origin}/authorize`,
          token_url: `${origin}/token`,
          client_id: 'fixture-client',
          token_endpoint_auth_methods_supported: ['none'],
        },
      },
    }),
  );
  const close = async () => {
    for (const transport of sessions.values()) {
      await transport.close();
    }
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

async function verify() {
  const base = values['base-url'];
  const fixture = values['fixture-url'];
  assert(
    base && fixture && values.email && process.env.LIBRECHAT_TEST_PASSWORD,
    'verify requires --base-url, --fixture-url, --email and LIBRECHAT_TEST_PASSWORD',
  );
  const readyDeadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const response = await fetch(new URL('/readyz', base), { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      ready = true;
      break;
    }
    assert.equal(response.status, 503, 'Unexpected application readiness response');
    await delay(250);
  }
  assert(ready, 'LibreChat did not finish startup before the readiness deadline');
  const cookies = new Map();
  let token;
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(new URL(path, base), {
      method,
      signal: AbortSignal.timeout(30000),
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        'x-librechat-generation-protocol': '2',
        ...(token && { Authorization: `Bearer ${token}` }),
        Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [assignment] = cookie.split(';');
      const split = assignment.indexOf('=');
      cookies.set(assignment.slice(0, split), assignment.slice(split + 1));
    }
    assert(
      response.ok ||
        response.status === 302 ||
        (method === 'GET' &&
          path.startsWith('/api/agents/chat/status/') &&
          response.status === 503 &&
          (await response.clone().json()).code === 'SERVER_NOT_READY'),
      `${method} ${path} returned ${response.status}: ${await response.clone().text()}`,
    );
    return response;
  };
  const api = async (path, body, method) => {
    const response = await call(path, body, method);
    const text = await response.text();
    assert(
      response.headers.get('content-type')?.includes('application/json'),
      `${path} did not return JSON: ${text.slice(0, 1500)}`,
    );
    return JSON.parse(text);
  };
  const snapshot = async () => (await fetch(`${fixture}/state`)).json();
  const login = await api('/api/auth/login', {
    email: values.email,
    password: process.env.LIBRECHAT_TEST_PASSWORD,
  });
  token = login.token;
  assert.equal(typeof token, 'string');
  const allowance = await api(
    '/api/admin/config/role/__base__',
    {
      expectedRevision: 'absent',
      overrides: {
        mcpSettings: {
          allowedDomains: [new URL(fixture).origin],
          allowedAddresses: [new URL(fixture).host],
        },
      },
    },
    'PUT',
  );
  assert(allowance.config, 'The admin API did not install the fixture address allowance');
  const effective = await api(
    `/api/admin/config/effective?userId=${encodeURIComponent(login.user.id ?? login.user._id)}`,
  );
  assert.equal(
    effective.resolved?.mcpSettings?.authorizationMode,
    'nonblocking',
    'The application did not preserve nonblocking authentication after the admin config write',
  );

  const agent = await api('/api/agents', {
    name: `Nonblocking regression ${randomUUID()}`,
    provider: values.provider,
    model: values.model,
    instructions: 'Reply to the user. Use a tool only when the user requests it.',
    tools: [`sys__all__sys_mcp_${serverName}`],
  });
  assert.equal(typeof agent.id, 'string');
  const startChat = async (text) => {
    const messageId = randomUUID();
    const start = await api('/api/agents/chat/agents', {
      text,
      sender: 'User',
      clientTimestamp: new Date().toISOString(),
      isCreatedByUser: true,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId: 'new',
      clientRequestId: randomUUID(),
      messageId,
      responseMessageId: `${messageId}_response`,
      endpoint: 'agents',
      endpointType: 'agents',
      agent_id: agent.id,
      files: [],
      isTemporary: false,
      isRegenerate: false,
      error: false,
      generationProtocolVersion: 2,
    });
    assert.equal(typeof start.conversationId, 'string');
    return start;
  };
  const subscribe = async (start) =>
    fetch(
      new URL(
        `/api/agents/chat/stream/${start.streamId}?resume=true&generationProtocolVersion=${start.generationProtocolVersion}&generationCreatedAt=${start.generationCreatedAt}`,
        base,
      ),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
          'x-librechat-generation-protocol': String(start.generationProtocolVersion),
        },
        signal: AbortSignal.timeout(25000),
      },
    );
  const chat = async (text, expected) => {
    const start = await startChat(text);
    const stream = await subscribe(start);
    assert.equal(stream.status, 200);
    const waitForCompletion = async () => {
      const deadline = Date.now() + 20000;
      let status;
      while (Date.now() < deadline) {
        status = await api(`/api/agents/chat/status/${start.conversationId}`);
        if (status.code === 'SERVER_NOT_READY') {
          await delay(100);
          continue;
        }
        assert.deepEqual(
          status.resumeState?.pendingOAuthPrompts ?? [],
          [],
          'Passive discovery started an OAuth prompt',
        );
        if (status.active === false) {
          return;
        }
        await delay(100);
      }
      assert.equal(
        status.active,
        false,
        'Conversation did not complete within the inference deadline',
      );
    };
    const [events] = await Promise.all([stream.text(), waitForCompletion()]);
    assert(!/"auth"\s*:\s*"https?:/.test(events), 'Inference emitted an interactive OAuth event');
    const messages = await api(`/api/messages/${start.conversationId}`);
    const assistant = messages.filter((message) => !message.isCreatedByUser);
    assert(
      assistant.some((message) => JSON.stringify(message).includes(expected)),
      'Expected persisted model response',
    );
    return start;
  };
  try {
    const before = await snapshot();
    await chat('Hello. Reply without using any tools.', reply);
    const cold = await snapshot();
    assert(
      cold.modelRequests.length > before.modelRequests.length,
      'No request reached the real model HTTP endpoint',
    );
    assert.deepEqual(
      { authorizations: cold.authorizations, grants: cold.grants, toolCalls: cold.toolCalls },
      { authorizations: 0, grants: 0, toolCalls: 0 },
    );
    const statuses = await api('/api/mcp/connection/status');
    const pending = statuses.connectionStatus[serverName];
    assert.deepEqual(
      {
        requiresOAuth: pending.requiresOAuth,
        connectionState: pending.connectionState,
        authorizationState: pending.authorizationState,
      },
      {
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      },
    );
    console.log(JSON.stringify({ event: 'cold_inference_passed' }));

    const cancelledConnection = await api(`/api/mcp/${serverName}/reinitialize`, {});
    assert.equal(cancelledConnection.oauthRequired, true);
    const cancellation = await api(`/api/mcp/oauth/cancel/${serverName}`, {});
    assert.equal(cancellation.success, true);
    await chat('Hello again after cancelling Connect. Do not use any tools.', reply);
    console.log(JSON.stringify({ event: 'cancelled_connection_inference_passed' }));

    const connect = await api(`/api/mcp/${serverName}/reinitialize`, {});
    assert.equal(connect.oauthRequired, true);
    assert.equal(typeof connect.oauthUrl, 'string');
    let next = connect.oauthUrl;
    for (let redirects = 0; next && redirects < 8; redirects++) {
      const current = new URL(next, base);
      assert(
        [new URL(base).origin, new URL(fixture).origin].includes(current.origin),
        `OAuth redirected outside the isolated fixture: ${current.origin}${current.pathname}`,
      );
      const response =
        current.origin === new URL(base).origin
          ? await call(current.href)
          : await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      next = response.headers.get('location');
      if (next) {
        next = new URL(next, current).href;
      }
    }
    const connectedDeadline = Date.now() + 15000;
    let connected;
    while (Date.now() < connectedDeadline) {
      connected = await api(`/api/mcp/connection/status/${serverName}`);
      if (connected.connectionStatus === 'connected') {
        break;
      }
      await delay(100);
    }
    assert.equal(connected.connectionStatus, 'connected');
    console.log(JSON.stringify({ event: 'explicit_connection_completed' }));
    await chat('CALL_AUTHENTICATED_MCP: discover and call the authenticated echo tool.', toolReply);
    const after = await snapshot();
    assert(after.toolCalls > 0, 'The discovered MCP tool was not invoked');
    assert.equal(after.authorizations, 1);
    console.log(JSON.stringify({ event: 'authenticated_tool_passed' }));

    const revoke = await fetch(`${fixture}/revoke`, { method: 'POST' });
    assert.equal(revoke.status, 200);
    await chat('Hello with expired MCP credentials. Do not use tools.', reply);
    const expiredIdle = await snapshot();
    assert.equal(expiredIdle.grants, after.grants, 'Ordinary inference attempted token refresh');
    assert.equal(expiredIdle.authorizations, after.authorizations);

    const started = await startChat('CALL_AUTHENTICATED_MCP: use the protected echo tool now.');
    const stream = await subscribe(started);
    const reader = stream.body.getReader();
    let events = '';
    const decoder = new TextDecoder();
    try {
      while (!/"auth"\s*:\s*"https?:/.test(events)) {
        const chunk = await reader.read();
        assert(!chunk.done, 'The tool call completed without requesting renewed authentication');
        events += decoder.decode(chunk.value, { stream: true });
      }
      assert(
        events.includes(`echo_mcp_${serverName}`),
        'Authentication preceded the actual MCP tool call',
      );
      const requested = await snapshot();
      assert(
        requested.modelRequests.length > expiredIdle.modelRequests.length,
        'Authentication preceded model execution',
      );
      assert.equal(
        requested.authorizations,
        after.authorizations,
        'The provider authorization endpoint opened without a user action',
      );
      console.log(JSON.stringify({ event: 'expired_tool_authentication_passed' }));
    } finally {
      await api(`/api/mcp/oauth/cancel/${serverName}`, {});
      await api('/api/agents/chat/abort', {
        streamId: started.streamId,
        conversationId: started.conversationId,
        generationCreatedAt: started.generationCreatedAt,
        generationProtocolVersion: 2,
      });
      await reader.cancel();
    }
    await chat('Hello after cancelling renewed authentication. Do not use tools.', reply);
    console.log(JSON.stringify({ event: 'expired_cancellation_inference_passed' }));
  } finally {
    await api(`/api/agents/${encodeURIComponent(agent.id)}`, undefined, 'DELETE');
  }
}

try {
  if (positionals[0] === 'serve') {
    await serve();
  } else if (positionals[0] === 'verify') {
    await verify();
  } else {
    throw new Error('Use serve or verify');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
