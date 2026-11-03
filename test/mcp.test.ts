import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, it, mock } from 'node:test';
import { build } from 'rolldown';
import WebSocket, { type RawData } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { startBridge as StartBridge } from '../src/mcp/bridge';

let startBridge: typeof StartBridge;
let bridge: Awaited<ReturnType<typeof StartBridge>> | undefined;
let origin: string;
let browser: WebSocket | undefined;
let client: Client | undefined;

function messageText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw).toString('utf8');
}

before(async () => {
  // The interactive banner contains a short-lived connection token; keep it out of test logs.
  mock.method(console, 'log', () => {});
  const output = resolve('coverage/fixtures/mcp-api.mjs');
  mkdirSync(resolve('coverage/fixtures'), { recursive: true });
  await build({
    input: resolve('test/mcp-entry.ts'),
    platform: 'node',
    moduleTypes: { '.md': 'text' },
    output: { file: output, format: 'esm', sourcemap: 'inline' },
  });
  const api = (await import(pathToFileURL(output).href)) as { startBridge: typeof StartBridge };
  startBridge = api.startBridge;
  bridge = await startBridge({ port: 0, host: '127.0.0.1', openBrowser: false });
  origin = `http://127.0.0.1:${(bridge.httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  await client?.close();
  if (browser?.readyState === WebSocket.OPEN) {
    browser.close();
    await once(browser, 'close');
  }
  bridge?.close();
  mock.restoreAll();
});

it('refuses invalid bodies and missing browser/session connections through real HTTP', async () => {
  const refused = await fetch(`${origin}/evaluate/loan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: 1 }),
  });
  assert.equal(refused.status, 400);
  const disconnected = await fetch(`${origin}/evaluate/loan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: {} }),
  });
  assert.equal(disconnected.status, 400);
  assert.match(await disconnected.text(), /Browser not connected/);
  assert.equal((await fetch(`${origin}/file/loan`)).status, 400);
  for (const method of ['GET', 'DELETE', 'POST']) {
    assert.equal((await fetch(`${origin}/mcp`, { method, headers: { 'mcp-session-id': 'unknown' } })).status, 404);
  }
  assert.equal((await fetch(`${origin}/mcp`, { method: 'PUT' })).status, 405);
});

it('requires the socket token and exposes the connected browser manifest through an MCP session', async () => {
  const rejected = new WebSocket(origin.replace('http:', 'ws:'));
  await new Promise<void>((done, fail) => {
    rejected.on('open', () => {
      fail(new Error('An unauthenticated browser connected'));
    });
    rejected.on('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 401);
      response.resume();
      rejected.terminate();
      done();
    });
    rejected.on('error', () => {});
  });
  assert.ok(bridge);
  browser = new WebSocket(`${origin.replace('http:', 'ws:')}?token=${bridge.token}`);
  const hello = once(browser, 'message');
  await once(browser, 'open');
  const greeting = JSON.parse(messageText((await hello)[0] as RawData)) as { type: string };
  assert.equal(greeting.type, 'hello');
  browser.on('message', (raw) => {
    const message = JSON.parse(messageText(raw)) as {
      type: string;
      requestId: string;
      toolName?: string;
      input?: unknown;
      request?: { context?: { fail?: boolean }; path?: string };
    };
    if (message.type === 'tool-call') {
      const failed = message.toolName === 'fail';
      browser?.send(
        JSON.stringify({
          type: failed ? 'tool-error' : 'tool-result',
          requestId: message.requestId,
          ...(failed ? { error: 'refused by editor' } : { result: message.input }),
        }),
      );
    } else if (message.type === 'evaluate') {
      browser?.send(
        JSON.stringify({
          type: 'evaluate-result',
          requestId: message.requestId,
          response: message.request?.context?.fail
            ? { success: false, error: '{"code":"BAD_INPUT"}' }
            : { success: true, result: { decision: 'approve' } },
        }),
      );
    } else if (message.type === 'get-file') {
      browser?.send(
        JSON.stringify({
          type: 'get-file-result',
          requestId: message.requestId,
          response: { path: message.request?.path, content: {} },
        }),
      );
    }
  });
  browser.send(
    JSON.stringify({
      type: 'manifest',
      project: { id: 'p-1', name: 'Synthetic project' },
      tools: [
        { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: {} } },
        { name: 'fail', description: 'Refuse input', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
  );
  client = new Client({ name: 'donka-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['echo', 'fail'],
  );
  const echo = await client.callTool({ name: 'echo', arguments: { value: 7 } });
  assert.deepEqual(echo.content, [{ type: 'text', text: '{"value":7}' }]);
  assert.equal((await client.callTool({ name: 'fail', arguments: {} })).isError, true);
});

it('routes evaluation and file responses, and retains a structured editor failure', async () => {
  const evaluate = (context: object) =>
    fetch(`${origin}/evaluate/folder/loan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context }),
    });
  assert.deepEqual(await (await evaluate({})).json(), { result: { decision: 'approve' } });
  const refused = await evaluate({ fail: true });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: { code: 'BAD_INPUT' } });
  assert.deepEqual(await (await fetch(`${origin}/file/folder/loan`)).json(), { path: 'folder/loan', content: {} });
});

it('clears the manifest when the browser disconnects and refuses further evaluations', async () => {
  assert.ok(browser);
  browser.close();
  await once(browser, 'close');
  const result = await fetch(`${origin}/evaluate/loan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: {} }),
  });
  assert.equal(result.status, 400);
  assert.match(await result.text(), /Browser not connected/);
  assert.deepEqual((await client?.listTools())?.tools, []);
});
