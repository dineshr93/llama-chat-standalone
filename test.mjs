#!/usr/bin/env node
// One runnable check for the parts of server.mjs that can break silently:
// the /props and /v1/models fallbacks, the static path guard, and the MCP
// CORS proxy.
// Run: node test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// a model server that knows nothing about llama.cpp
const upstream = http.createServer((req, res) => {
	if (req.url.startsWith('/v1/models')) {
		res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
		return;
	}
	if (req.url.startsWith('/props')) {
		// llama.cpp without --ui-mcp-proxy reports the proxy as unavailable
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end('{"cors_proxy_enabled":false,"default_generation_settings":{"n_ctx":4096}}');
		return;
	}
	if (req.url.startsWith('/v1/chat/completions')) {
		if (req.headers['x-test-stream']) {
			res.writeHead(200, { 'content-type': 'text/event-stream' });

			if (req.headers['x-test-fresh']) {
				res.write('data: {"choices":[{"delta":{"content":"fresh"}}]}\n');
				res.write('data: [DONE]\n');
				res.end();
				return;
			}

			if (req.headers['x-test-nodone']) {
				res.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n');
				setTimeout(() => res.end(), 100);
				return;
			}

			res.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n');

			if (req.headers['x-test-slow']) {
				setTimeout(() => {
					res.write('data: {"choices":[{"delta":{"content":"later"}}]}\n');
					res.write('data: [DONE]\n');
					res.end();
				}, 50);
			} else {
				res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n');
				res.write('data: [DONE]\n');
				res.end();
			}
			return;
		}

		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(Buffer.concat(chunks).toString());
		});
		return;
	}
	res.writeHead(404).end('nope');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-chat-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');

// server.mjs reads its config at import time
process.env.MODEL_ID = 'test-model';
process.env.N_CTX = '4096';
process.env.MODALITIES = 'vision';
process.env.UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
process.env.UPSTREAMS = ''; // keep this check on one backend; multi-backend is tested separately
process.env.DIST = dist;

const { createServer, synthModels, synthProps } = await import('./server.mjs');

const props = synthProps();
assert.equal(props.default_generation_settings.n_ctx, 4096);
assert.equal(props.model_path, 'test-model');
assert.equal(props.modalities.vision, true);
assert.equal(props.modalities.audio, false);
assert.equal(props.role, 'model');
assert.equal(props.cors_proxy_enabled, true);
assert.equal(synthModels().data[0].id, 'test-model');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const propsRes = await fetch(`${base}/props?autoload=false`);
assert.equal(propsRes.status, 200);
const liveProps = await propsRes.json();
assert.equal(liveProps.default_generation_settings.n_ctx, 4096);
// the upstream said false; this server answers /cors-proxy itself
assert.equal(liveProps.cors_proxy_enabled, true);

const modelsRes = await fetch(`${base}/v1/models`);
assert.equal(modelsRes.status, 200);
assert.equal((await modelsRes.json()).data[0].id, 'test-model');

// engines like gufo require `model`; the llama.cpp UI omits it in MODEL mode.
// llama.cpp accepts max_tokens=-1, gufo rejects it. Both are normalized here.
const chatRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({
		max_tokens: -1,
		messages: [{ content: 'hello', role: 'user' }],
		stream: true
	}),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
assert.equal(chatRes.status, 200);
const forwarded = await chatRes.json();
assert.equal(forwarded.model, 'test-model');
assert.equal('max_tokens' in forwarded, false);
assert.equal(forwarded.messages[0].content, 'hello');

const explicitModelRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], model: 'other-model' }),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
assert.equal((await explicitModelRes.json()).model, 'other-model');

// server-owned stream replay: a segment started from the UI is captured and served back
const streamRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], stream: true }),
	headers: {
		'content-type': 'application/json',
		'x-conversation-id': 'test-conv::test-model',
		'x-test-stream': '1'
	},
	method: 'POST'
});
assert.equal(streamRes.status, 200);
const streamText = await streamRes.text();
assert.match(streamText, /hello/);
assert.match(streamText, /\[DONE\]/);

const lookupRes = await fetch(`${base}/v1/streams/lookup`, {
	body: JSON.stringify({ conversation_ids: ['test-conv::test-model'] }),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
const sessions = await lookupRes.json();
assert.equal(sessions.length, 1);
assert.equal(sessions[0].conversation_id, 'test-conv::test-model');
assert.equal(sessions[0].is_done, true);
assert.equal(sessions[0].total_bytes, Buffer.byteLength(streamText));

const replayRes = await fetch(
	`${base}/v1/stream?conv_id=${encodeURIComponent('test-conv::test-model')}&from=0`
);
assert.equal(replayRes.status, 200);
assert.equal(replayRes.headers.get('x-stream-done'), '1');
assert.equal(replayRes.headers.get('x-stream-continue'), '0');
assert.equal(await replayRes.text(), streamText);

// a new POST with the same conversation id replaces the done session, not appends to it
const secondRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({ messages: [{ content: 'again', role: 'user' }], stream: true }),
	headers: {
		'content-type': 'application/json',
		'x-conversation-id': 'test-conv::test-model',
		'x-test-stream': '1',
		'x-test-fresh': '1'
	},
	method: 'POST'
});
assert.equal(secondRes.status, 200);
const secondText = await secondRes.text();
assert.match(secondText, /fresh/);
assert.equal(secondText.includes('think'), false);

const secondLookup = await fetch(`${base}/v1/streams/lookup`, {
	body: JSON.stringify({ conversation_ids: ['test-conv::test-model'] }),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
const secondSession = (await secondLookup.json())[0];
assert.equal(secondSession.is_done, true);
assert.equal(secondSession.total_bytes, Buffer.byteLength(secondText));

const secondReplay = await fetch(
	`${base}/v1/stream?conv_id=${encodeURIComponent('test-conv::test-model')}&from=0`
);
assert.equal(await secondReplay.text(), secondText);

// continue mode is tagged so the UI preserves the prefix it already has
const continueRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({
		continue_final_message: true,
		messages: [{ content: 'hi', role: 'user' }],
		stream: true
	}),
	headers: {
		'content-type': 'application/json',
		'x-conversation-id': 'continue-conv::test-model',
		'x-test-stream': '1'
	},
	method: 'POST'
});
assert.equal(continueRes.status, 200);
await continueRes.text();

const continueReplay = await fetch(
	`${base}/v1/stream?conv_id=${encodeURIComponent('continue-conv::test-model')}&from=0`
);
assert.equal(continueReplay.headers.get('x-stream-continue'), '1');

// active session: replay returns the segment so far and tails the rest
const slowRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], stream: true }),
	headers: {
		'content-type': 'application/json',
		'x-conversation-id': 'slow-conv::test-model',
		'x-test-stream': '1',
		'x-test-slow': '1'
	},
	method: 'POST'
});
assert.equal(slowRes.status, 200);
const slowReader = slowRes.body.getReader();
const firstBytes = await slowReader.read();
assert.equal(firstBytes.done, false);

const liveReplayRes = await fetch(
	`${base}/v1/stream?conv_id=${encodeURIComponent('slow-conv::test-model')}&from=0`
);
assert.equal(liveReplayRes.status, 200);
const liveText = await liveReplayRes.text();
assert.match(liveText, /think/);
assert.match(liveText, /later/);
assert.match(liveText, /\[DONE\]/);
await slowReader.cancel();

// upstream can end a stream without [DONE]; a live replay must still learn the session ended
const nodoneRes = await fetch(`${base}/v1/chat/completions`, {
	body: JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], stream: true }),
	headers: {
		'content-type': 'application/json',
		'x-conversation-id': 'nodone-conv::test-model',
		'x-test-stream': '1',
		'x-test-nodone': '1'
	},
	method: 'POST'
});
assert.equal(nodoneRes.status, 200);
const nodoneReader = nodoneRes.body.getReader();
const nodoneFirst = await nodoneReader.read();
assert.equal(nodoneFirst.done, false);

const nodoneReplayRes = await fetch(
	`${base}/v1/stream?conv_id=${encodeURIComponent('nodone-conv::test-model')}&from=0`
);
assert.equal(nodoneReplayRes.status, 200);
const nodoneText = await nodoneReplayRes.text();
assert.match(nodoneText, /think/);
assert.match(nodoneText, /\[DONE\]/);
await nodoneReader.cancel();

const indexRes = await fetch(`${base}/`);
assert.equal(indexRes.status, 200);
assert.equal(indexRes.headers.get('cross-origin-embedder-policy'), 'require-corp');

const missingRes = await fetch(`${base}/nope.js`);
assert.equal(missingRes.status, 404);

const traversalRes = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
assert.equal(traversalRes.status, 403);

// the MCP CORS proxy: only prefixed headers reach the target, response headers pass through
const target = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' });
		res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), headers: req.headers }));
	});
});
await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

const proxiedRes = await fetch(
	`${base}/cors-proxy?url=${encodeURIComponent(`http://127.0.0.1:${target.address().port}/mcp`)}`,
	{
		body: '{"jsonrpc":"2.0"}',
		headers: {
			'x-llama-server-proxy-header-authorization': 'Bearer target-token',
			'x-llama-server-proxy-header-content-type': 'application/json',
			'x-not-forwarded': 'nope'
		},
		method: 'POST'
	}
);
assert.equal(proxiedRes.status, 200);
assert.equal(proxiedRes.headers.get('mcp-session-id'), 'abc');
const echoed = await proxiedRes.json();
assert.equal(echoed.headers.authorization, 'Bearer target-token');
assert.equal(echoed.headers['content-type'], 'application/json');
assert.equal(echoed.headers['x-not-forwarded'], undefined);
assert.equal(echoed.body, '{"jsonrpc":"2.0"}');

const badProxyRes = await fetch(`${base}/cors-proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd`);
assert.equal(badProxyRes.status, 400);

// server-owned MCP: configure a fake streamable-HTTP MCP server, then call a tool
const sdkPath = new URL('./ui/apps/chat/node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url);
const { McpServer } = await import(new URL('server/mcp.js', sdkPath).href);
const { StreamableHTTPServerTransport } = await import(new URL('server/streamableHttp.js', sdkPath).href);

const fakeMcpServer = new McpServer({ name: 'fake', version: '1.0.0' });
fakeMcpServer.registerTool('echo', { description: 'echo' }, async () => ({
	content: [{ type: 'text', text: 'hello' }]
}));

const fakeTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
await fakeMcpServer.connect(fakeTransport);
const fakeMcp = http.createServer((req, res) => fakeTransport.handleRequest(req, res));
await new Promise((resolve) => fakeMcp.listen(0, '127.0.0.1', resolve));

const fakeUrl = `http://127.0.0.1:${fakeMcp.address().port}/mcp`;
const configRes = await fetch(`${base}/mcp/config`, {
	body: JSON.stringify({
		servers: {
			'fake-server': { transport: 'streamable_http', url: fakeUrl, useProxy: false }
		}
	}),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
assert.equal(configRes.status, 200);
const config = await configRes.json();
assert.equal(config.servers[0].connected, true);
assert.equal(config.servers[0].toolCount, 1);

const callRes = await fetch(`${base}/mcp/call`, {
	body: JSON.stringify({ arguments: {}, server: 'fake-server', tool: 'echo' }),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});
assert.equal(callRes.status, 200);
assert.deepEqual(await callRes.json(), { content: 'hello', isError: false });

await fakeMcpServer.close();
fakeMcp.close();

target.close();
server.close();
upstream.close();
fs.rmSync(dist, { recursive: true, force: true });
console.log('ok');
