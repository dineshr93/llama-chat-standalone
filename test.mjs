#!/usr/bin/env node
// One runnable check for the parts of server.mjs that can break silently:
// the /props and /v1/models fallbacks, and the static path guard.
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
assert.equal(synthModels().data[0].id, 'test-model');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const propsRes = await fetch(`${base}/props?autoload=false`);
assert.equal(propsRes.status, 200);
assert.equal((await propsRes.json()).default_generation_settings.n_ctx, 4096);

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

server.close();
upstream.close();
fs.rmSync(dist, { recursive: true, force: true });
console.log('ok');
