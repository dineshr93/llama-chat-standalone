#!/usr/bin/env node
// One runnable check for the parts of server.mjs that can break silently:
// the /props and /v1/models fallbacks, the static path guard, and the MCP
// CORS proxy.
// Run: node test.mjs

import assert from 'node:assert/strict';
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

target.close();
server.close();
upstream.close();
fs.rmSync(dist, { recursive: true, force: true });
console.log('ok');
