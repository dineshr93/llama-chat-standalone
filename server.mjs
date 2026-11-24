#!/usr/bin/env node
// Serve the llama.cpp chat UI as a standalone webapp and proxy it to any
// OpenAI-compatible inference server.
//
// The UI calls its API on the same origin with relative paths, so this server
// is the only place that needs to know where the model server lives.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBackground } from './mcp-background.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST || path.join(ROOT, 'ui/apps/chat/dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:8888').replace(/\/+$/, '');
const UPSTREAMS_RAW = process.env.UPSTREAMS || '';
const BACKENDS = parseBackends(UPSTREAMS_RAW);
const MULTI = BACKENDS.length > 1;
const MODEL_ID = process.env.MODEL_ID || 'local-model';
const N_CTX = Number(process.env.N_CTX || 65556);
const CHAT_TEMPLATE = process.env.CHAT_TEMPLATE || '';
const API_KEY = process.env.API_KEY || '';
const MODALITIES = new Set(
	(process.env.MODALITIES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Paths the UI sends to the model server. Everything else is a static asset.
const PROXY_PREFIXES = ['/v1', '/props', '/models', '/slots', '/tools'];

// Multiple model servers are configured as `name=url,name=url`. Without
// UPSTREAMS this stays the old single-server behavior.
function parseBackends(raw) {
	const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
	if (entries.length === 0) return [{ name: 'local', url: UPSTREAM }];
	return entries.map((entry, index) => {
		const eq = entry.indexOf('=');
		const name = (eq === -1 ? `backend${index + 1}` : entry.slice(0, eq)).trim();
		const url = (eq === -1 ? entry : entry.slice(eq + 1)).trim().replace(/\/+$/, '');
		return { name, url: url || UPSTREAM };
	});
}

function modelKey(backend, model) {
	return MULTI ? `${backend.name}@${model}` : model;
}

function parseModelKey(key) {
	if (!MULTI || !key.includes('@')) return { backend: BACKENDS[0], model: key };
	const at = key.indexOf('@');
	const backend = BACKENDS.find((b) => b.name === key.slice(0, at));
	return backend ? { backend, model: key.slice(at + 1) } : { backend: BACKENDS[0], model: key };
}

function normalizeStatus(status) {
	if (status && typeof status === 'object' && 'value' in status) return status;
	return { value: typeof status === 'string' ? status : 'loaded' };
}

function splitConvModel(conv) {
	const sep = conv.indexOf('::');
	if (sep === -1) return { conv, model: '' };
	return { conv: conv.slice(0, sep), model: conv.slice(sep + 2) };
}

// ponytail: full stream buffers live in memory; a TTL prune keeps done sessions bounded.
const STREAM_SESSION_TTL_MS = 30 * 60 * 1000;
const streamSessions = new Map();

function pruneStreamSessions() {
	const now = Date.now();

	for (const [key, session] of streamSessions) {
		if (session.done && session.completedAt && now - session.completedAt > STREAM_SESSION_TTL_MS) {
			streamSessions.delete(key);
		}
	}
}

function startStreamSession(key, isContinue = false) {
	pruneStreamSessions();

	const previous = streamSessions.get(key);

	// a new POST means a new generation; reuse of the old buffer mixes turns
	if (previous) {
		finishSession(previous);
		streamSessions.delete(key);
	}

	const session = {
		chunks: [],
		totalBytes: 0,
		done: false,
		startedAt: Date.now(),
		completedAt: 0,
		isContinue,
		subscribers: new Set()
	};

	streamSessions.set(key, session);

	return session;
}

function appendSession(session, text) {
	if (!session || session.done) return;

	const buffer = Buffer.from(text);
	session.chunks.push(buffer);
	session.totalBytes += buffer.length;

	for (const subscriber of session.subscribers) {
		if (!subscriber.writableEnded) {
			try {
				subscriber.write(buffer);
			} catch {
				session.subscribers.delete(subscriber);
			}
		}
	}
}

function finishSession(session) {
	if (!session || session.done) return;
	session.done = true;
	session.completedAt = Date.now();

	for (const subscriber of session.subscribers) {
		if (!subscriber.writableEnded) {
			try {
				// a replay tail may have no [DONE] from upstream; tell the reader the session ended
				subscriber.write('data: [DONE]\n');
				subscriber.end();
			} catch {
				session.subscribers.delete(subscriber);
			}
		}
	}
	session.subscribers.clear();
}

function sessionInfo(key, session) {
	return {
		conversation_id: key,
		is_done: session.done,
		is_continue: session.isContinue,
		total_bytes: session.totalBytes,
		started_at: session.startedAt,
		completed_at: session.completedAt
	};
}

function cancelSession(key) {
	const session = streamSessions.get(key);

	if (!session) return;
	finishSession(session);
	streamSessions.delete(key);
}

function replayStream(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const key = url.searchParams.get('conv_id') || '';
	const session = streamSessions.get(key);

	if (!session) {
		return sendJson(res, 404, { error: { message: 'no stream session' } });
	}

	const from = Number(url.searchParams.get('from') || 0);
	let cursor = Number.isFinite(from) && from > 0 ? from : 0;
	let offset = 0;

	res.writeHead(200, {
		'cache-control': 'no-cache',
		'connection': 'keep-alive',
		'content-type': 'text/event-stream; charset=utf-8',
		'x-stream-continue': session.isContinue ? '1' : '0',
		'x-stream-done': session.done ? '1' : '0'
	});

	for (const buffer of session.chunks) {
		const start = offset;
		offset += buffer.length;

		if (offset <= cursor) continue;

		res.write(buffer.subarray(Math.max(0, cursor - start)));
		cursor = offset;
	}

	if (session.done) {
		res.end();
		return;
	}

	session.subscribers.add(res);
	res.on('close', () => session.subscribers.delete(res));
}

// The UI's MCP client prefixes the headers it wants forwarded to the target.
const CORS_PROXY_HEADER_PREFIX = 'x-llama-server-proxy-header-';

const MIME = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2'
};

// Revalidated on every load: the names are stable while their contents change.
const NO_CACHE = new Set([
	'index.html',
	'service-worker.js',
	'sw.js',
	'manifest.webmanifest',
	'_app/version.json',
	'build.json'
]);

/** Server properties the UI needs. llama.cpp answers /props; other engines do not. */
export function synthProps(role = MULTI ? 'router' : 'model') {
	return {
		build_info: 'llama-chat-standalone',
		chat_template: CHAT_TEMPLATE,
		cors_proxy_enabled: true,
		default_generation_settings: {
			id: 0,
			id_task: 0,
			is_processing: false,
			n_ctx: N_CTX,
			next_token: {
				has_new_line: false,
				has_next_token: false,
				n_decoded: 0,
				n_remain: -1,
				stopping_word: ''
			},
			params: {
				dry_allowed_length: 2,
				dry_base: 1.75,
				dry_multiplier: 0,
				dry_penalty_last_n: 0,
				dry_sequence_breakers: ['\n', ':', '"', '*', '/'],
				dynatemp_exponent: 1,
				dynatemp_range: 0,
				frequency_penalty: 0,
				grammar: '',
				grammar_lazy: false,
				grammar_triggers: [],
				ignore_eos: false,
				logit_bias: [],
				max_tokens: -1,
				min_keep: 0,
				min_p: 0.05,
				mirostat: 0,
				mirostat_eta: 0.1,
				mirostat_tau: 5,
				n_discard: 0,
				n_keep: 0,
				n_predict: -1,
				n_probs: 0,
				post_sampling_probs: false,
				presence_penalty: 0,
				preserved_tokens: [],
				repeat_last_n: 64,
				repeat_penalty: 1,
				samplers: ['top_k', 'top_p', 'min_p', 'temperature'],
				seed: -1,
				stop: [],
				stream: true,
				temperature: 0.8,
				timings_per_token: false,
				top_k: 40,
				top_n_sigma: -1,
				top_p: 0.95,
				typ_p: 1,
				xtc_probability: 0,
				xtc_threshold: 0.1
			},
			prompt: '',
			speculative: false
		},
		modalities: {
			audio: MODALITIES.has('audio'),
			video: MODALITIES.has('video'),
			vision: MODALITIES.has('vision')
		},
		model_path: MODEL_ID,
		role,
		system_prompt: '',
		total_slots: 1,
		ui_settings: {}
	};
}

/** Model list the UI needs. Falls back to the single configured model. */
export function synthModels() {
	return {
		data: [
			{
				created: 0,
				id: MODEL_ID,
				in_cache: false,
				name: MODEL_ID,
				object: 'model',
				owned_by: 'llama-chat-standalone',
				path: MODEL_ID,
				status: 'loaded'
			}
		],
		object: 'list'
	};
}

function upstreamHeaders(req, backend = BACKENDS[0]) {
	const headers = { ...req.headers, host: new URL(backend.url).host };
	delete headers['accept-encoding']; // keep the body readable for the JSON fallbacks
	if (API_KEY && !headers.authorization) headers.authorization = `Bearer ${API_KEY}`;
	return headers;
}

/** Buffered request, for the two endpoints that may need a fallback body. */
function fetchUpstream(req, body, pathOverride, backend = BACKENDS[0]) {
	return new Promise((resolve) => {
		const url = new URL(backend.url + (pathOverride ?? req.url));
		const headers = upstreamHeaders(req, backend);

		if (body) {
			headers['content-length'] = String(body.length);
			delete headers['transfer-encoding'];
		}

		const request = http.request(
			{
				headers,
				hostname: url.hostname,
				method: req.method,
				path: url.pathname + url.search,
				port: url.port || 80,
				protocol: url.protocol
			},
			(response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () =>
					resolve({ body: Buffer.concat(chunks), status: response.statusCode })
				);
				response.on('error', () => resolve({ body: Buffer.alloc(0), status: 0 }));
			}
		);
		request.on('error', () => resolve({ body: Buffer.alloc(0), status: 0 }));
		request.end(body);
	});
}

function sendJson(res, status, payload, extraHeaders = {}) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-length': Buffer.byteLength(body),
		'content-type': 'application/json; charset=utf-8',
		...extraHeaders
	});
	res.end(body);
}

/** Streams the request to the model server and the answer back, unbuffered. */
function proxy(req, res, body, backend = BACKENDS[0], pathOverride) {
	const url = new URL(backend.url + (pathOverride ?? req.url));
	const headers = upstreamHeaders(req, backend);

	if (body) {
		// a modified body must carry its own length; the upstream request has
		// already been consumed, so req.pipe() below no longer applies.
		headers['content-length'] = String(body.length);
		delete headers['transfer-encoding'];
	}

	const request = http.request(
		{
			headers,
			hostname: url.hostname,
			method: req.method,
			path: url.pathname + url.search,
			port: url.port || 80,
			protocol: url.protocol
		},
		(response) => {
			res.writeHead(response.statusCode, response.headers);
			response.pipe(res);
		}
	);
	request.on('error', (error) => {
		if (res.headersSent) return res.end();
		sendJson(res, 502, { error: { message: `upstream unreachable: ${error.message}` } });
	});
	if (body) request.end(body);
	else req.pipe(request);
}

/** Proxies chat completions and rewrites response.model to the qualified id. */
function proxyChat(req, res, body, backend, qualifiedModel, streamKey = '') {
	const url = new URL(backend.url + req.url);
	const headers = upstreamHeaders(req, backend);
	let isContinue = false;

	try {
		const parsedBody = JSON.parse(body.toString());
		isContinue = parsedBody?.continue_final_message === true;
	} catch {
		/* keep false */
	}

	const session = streamKey ? startStreamSession(streamKey, isContinue) : null;
	headers['content-length'] = String(body.length);
	delete headers['transfer-encoding'];

	const request = http.request(
		{
			headers,
			hostname: url.hostname,
			method: req.method,
			path: url.pathname + url.search,
			port: url.port || 80,
			protocol: url.protocol
		},
		(response) => {
			const contentType = response.headers['content-type'] || '';

			if (contentType.includes('text/event-stream')) {
				res.writeHead(response.statusCode, response.headers);
				let buffer = '';

				// stream chunks are captured for replay; the live response is written separately
				const emit = (text) => {
					if (session) appendSession(session, text);
					if (!res.writableEnded) res.write(text);
				};

				response.on('data', (chunk) => {
					buffer += chunk.toString();
					let index;

					while ((index = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, index);
						buffer = buffer.slice(index + 1);

						if (line.startsWith('data:')) {
							const raw = line.slice(5).trim();
							if (raw === '[DONE]') {
								emit(line + '\n');
								continue;
							}
							try {
								const parsed = JSON.parse(raw);
								if (parsed && typeof parsed.model === 'string') parsed.model = qualifiedModel;
								emit('data: ' + JSON.stringify(parsed) + '\n');
							} catch {
								emit(line + '\n');
							}
						} else {
							emit(line + '\n');
						}
					}
				});

				response.on('end', () => {
					if (buffer) emit(buffer);
					finishSession(session);
					res.end();
				});
				response.on('error', () => {
					finishSession(session);
					if (!res.writableEnded) res.end();
				});
				return;
			}

			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => {
				const raw = Buffer.concat(chunks);
				try {
					const parsed = JSON.parse(raw.toString());
					if (parsed && typeof parsed.model === 'string') parsed.model = qualifiedModel;
					const out = Buffer.from(JSON.stringify(parsed));
					const headers = { ...response.headers, 'content-length': out.length };
					delete headers['transfer-encoding'];
					res.writeHead(response.statusCode, headers);
					res.end(out);
				} catch {
					res.writeHead(response.statusCode, response.headers);
					res.end(raw);
				}
				finishSession(session);
			});
			response.on('error', () => {
				finishSession(session);
				if (!res.writableEnded) res.end();
			});
		}
	);

	request.on('error', (error) => {
		finishSession(session);
		if (res.headersSent) return res.end();
		sendJson(res, 502, { error: { message: `upstream unreachable: ${error.message}` } });
	});
	request.end(body);
}

/** Buffered request body, for endpoints whose JSON must be adjusted first. */
function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', () => resolve(Buffer.alloc(0)));
	});
}

/**
 * Some engines (gufo) require `model` even when serving a single model, while
 * the llama.cpp UI omits it in MODEL mode. They also reject `max_tokens: -1`,
 * which llama.cpp uses to mean "no limit". Normalize those two differences
 * before forwarding; the rest of the request is passed through untouched.
 */
export function normalizeChatRequest(body, modelOverride) {
	let parsed;

	try {
		parsed = JSON.parse(body.toString());
	} catch {
		return body;
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;

	if (modelOverride) parsed.model = modelOverride;
	else if (!parsed.model) parsed.model = MODEL_ID;

	if (typeof parsed.max_tokens === 'number' && parsed.max_tokens <= 0) {
		delete parsed.max_tokens;
	}

	return Buffer.from(JSON.stringify(parsed));
}

/**
 * Forwards a request to an arbitrary URL for the UI's MCP client. Remote MCP
 * servers only allow CORS from localhost, so a page served on a LAN address
 * cannot reach them directly; this makes the request same-origin instead.
 * Only headers the client explicitly prefixed are forwarded.
 */
function corsProxy(req, res) {
	let target;
	try {
		target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url') || '');
	} catch {
		return sendJson(res, 400, { error: { message: 'invalid target URL' } });
	}

	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		return sendJson(res, 400, { error: { message: `unsupported scheme ${target.protocol}` } });
	}

	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (!key.startsWith(CORS_PROXY_HEADER_PREFIX)) continue;
		const name = key.slice(CORS_PROXY_HEADER_PREFIX.length);
		if (name) headers[name] = value;
	}
	// the browser's own content-length is not prefixed, so carry it over
	if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];

	const secure = target.protocol === 'https:';
	const request = (secure ? https : http).request(
		{
			headers,
			hostname: target.hostname,
			method: req.method,
			path: target.pathname + target.search,
			port: target.port || (secure ? 443 : 80)
		},
		(response) => {
			const out = { ...response.headers };
			// route redirects back through the proxy, so each hop is checked
			if (response.statusCode >= 300 && response.statusCode < 400 && out.location) {
				out.location = '/cors-proxy?url=' + encodeURIComponent(new URL(out.location, target).href);
			}
			res.writeHead(response.statusCode, out);
			response.pipe(res);
		}
	);
	request.on('error', (error) => {
		if (res.headersSent) return res.end();
		sendJson(res, 502, { error: { message: `proxy target unreachable: ${error.message}` } });
	});
	req.pipe(request);
}

/** Merges each backend's /models/sse feed, requalifying model ids for the UI. */
function serveModelEvents(req, res) {
	res.writeHead(200, {
		'cache-control': 'no-cache',
		'connection': 'keep-alive',
		'content-type': 'text/event-stream; charset=utf-8'
	});

	const cleanups = [];

	for (const backend of BACKENDS) {
		const url = new URL(backend.url + '/models/sse');
		const request = http.request(
			{
				headers: upstreamHeaders(req, backend),
				hostname: url.hostname,
				method: 'GET',
				path: url.pathname + url.search,
				port: url.port || 80,
				protocol: url.protocol
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.resume();
					return;
				}

				let buffer = '';

				response.on('data', (chunk) => {
					buffer += chunk.toString();
					const records = buffer.split('\n\n');
					buffer = records.pop();

					for (const record of records) {
						const payload = record
							.split('\n')
							.filter((line) => line.startsWith('data:'))
							.map((line) => line.slice(5))
							.join('\n')
							.trim();

						if (!payload) continue;

						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {
							if (!res.writableEnded) res.write(record + '\n\n');
							continue;
						}

						if (parsed && typeof parsed.model === 'string') {
							parsed.model = modelKey(backend, parsed.model);
						}

						if (!res.writableEnded) res.write('data: ' + JSON.stringify(parsed) + '\n\n');
					}
				});

				response.on('error', () => {});
			}
		);

		request.on('error', () => {});
		request.end();
		cleanups.push(() => request.destroy());
	}

	req.on('close', () => cleanups.forEach((cleanup) => cleanup()));
}

async function handleApi(req, res) {
	const pathname = req.url.split('?')[0];

	if (pathname === '/props') {
		// The UI reads model capabilities (vision/audio/video) from /props at page
		// load. A response without cache-control gets heuristic-cached by the
		// browser, so one synthesized fallback served during an upstream blip
		// would stick forever and wrongly hide image upload. Never cache /props.
		const NO_STORE = { 'cache-control': 'no-store' };
		const url = new URL(req.url, 'http://localhost');
		const requested = url.searchParams.get('model');

		if (requested) {
			const { backend, model } = parseModelKey(requested);
			url.searchParams.set('model', model);
			const pathOverride = url.pathname + url.search;
			const { body, status } = await fetchUpstream(req, undefined, pathOverride, backend);
			if (status === 200) {
				try {
					const parsed = JSON.parse(body.toString());
					// this server answers /cors-proxy itself, so the UI may offer it
					parsed.cors_proxy_enabled = true;
					return sendJson(res, 200, parsed, NO_STORE);
				} catch {
					// fall through to the bare retry
				}
			}
			// The upstream rejected this exact request — some engines do not accept
			// query params like autoload=false. Retry the bare /props, which every
			// OpenAI-compatible server answers, before inventing anything.
			const retry = await fetchUpstream(req, undefined, '/props', backend);
			if (retry.status === 200) {
				try {
					const parsed = JSON.parse(retry.body.toString());
					parsed.cors_proxy_enabled = true;
					return sendJson(res, 200, parsed, NO_STORE);
				} catch {
					// fall through to the synthesized props
				}
			}
			return sendJson(res, 200, synthProps('model'), NO_STORE);
		}

		// In router mode the global props only need the role; model-specific props
		// are fetched separately for each selected model.
		if (MULTI) return sendJson(res, 200, synthProps('router'), NO_STORE);

		const { body, status } = await fetchUpstream(req, undefined, undefined, BACKENDS[0]);
		if (status === 200) {
			try {
				const parsed = JSON.parse(body.toString());
				parsed.cors_proxy_enabled = true;
				return sendJson(res, 200, parsed, NO_STORE);
			} catch {
				// fall through to the bare retry
			}
		}
		const retry = await fetchUpstream(req, undefined, '/props', BACKENDS[0]);
		if (retry.status === 200) {
			try {
				const parsed = JSON.parse(retry.body.toString());
				parsed.cors_proxy_enabled = true;
				return sendJson(res, 200, parsed, NO_STORE);
			} catch {
				// fall through to the synthesized props
			}
		}
		return sendJson(res, 200, synthProps(), NO_STORE);
	}

	if (pathname === '/v1/models') {
		if (!MULTI) {
			const { body, status } = await fetchUpstream(req, undefined, undefined, BACKENDS[0]);
			if (status === 200) {
				try {
					const parsed = JSON.parse(body.toString());
					if (Array.isArray(parsed.data) && parsed.data.length > 0) {
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
						return res.end(body);
					}
				} catch {
					// fall through to the synthesized list
				}
			}
			return sendJson(res, 200, synthModels());
		}

		const data = [];
		const models = [];

		for (const backend of BACKENDS) {
			const { body, status } = await fetchUpstream(req, undefined, '/v1/models', backend);
			if (status !== 200) continue;

			try {
				const parsed = JSON.parse(body.toString());
				if (!Array.isArray(parsed.data)) continue;

				for (const item of parsed.data) {
					if (!item || typeof item.id !== 'string') continue;

					const actual = item.id;
					const key = modelKey(backend, actual);
					const name = item.name || actual;
					const displayName = MULTI ? `${backend.name}/${name}` : name;

					data.push({ ...item, id: key, name: displayName, status: normalizeStatus(item.status) });
					models.push({ name: displayName, model: key });
				}
			} catch {
				// this backend is unreachable or not JSON; keep the ones that answer
			}
		}

		if (data.length === 0) return sendJson(res, 200, synthModels());
		return sendJson(res, 200, { object: 'list', data, models });
	}

	if (pathname === '/tools') {
		const { body, status } = await fetchUpstream(req, undefined, undefined, BACKENDS[0]);
		if (status === 200) {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			return res.end(body);
		}
		return sendJson(res, 200, []);
	}

	if (pathname === '/models/sse' && MULTI) {
		return serveModelEvents(req, res);
	}

	if (pathname === '/models/load' || pathname === '/models/unload') {
		const body = await readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(body.toString());
		} catch {
			parsed = null;
		}

		if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') {
			const { backend, model } = parseModelKey(parsed.model);
			parsed.model = model;
			return proxy(req, res, Buffer.from(JSON.stringify(parsed)), backend);
		}

		return proxy(req, res, body, BACKENDS[0]);
	}

	if (pathname === '/models') {
		const url = new URL(req.url, 'http://localhost');
		const requested = url.searchParams.get('model');

		if (requested) {
			const { backend, model } = parseModelKey(requested);
			url.searchParams.set('model', model);
			return proxy(req, res, undefined, backend, url.pathname + url.search);
		}

		return proxy(req, res, undefined, BACKENDS[0]);
	}

	if (pathname === '/v1/stream') {
		const url = new URL(req.url, 'http://localhost');
		const conv = url.searchParams.get('conv_id') || '';
		const { conv: bare, model } = splitConvModel(conv);
		const resolved = model ? parseModelKey(model) : { backend: BACKENDS[0], model: '' };

		if (req.method === 'DELETE') {
			cancelSession(conv);
			if (model) url.searchParams.set('conv_id', `${bare}::${resolved.model}`);
			return proxy(req, res, undefined, resolved.backend, url.pathname + url.search);
		}

		if (req.method === 'GET' && streamSessions.has(conv)) {
			return replayStream(req, res);
		}

		if (model) url.searchParams.set('conv_id', `${bare}::${resolved.model}`);
		return proxy(req, res, undefined, resolved.backend, url.pathname + url.search);
	}

	if (pathname === '/v1/streams/lookup' && req.method === 'POST') {
		const body = await readBody(req);
		let parsed;
		try {
			parsed = JSON.parse(body.toString());
		} catch {
			parsed = null;
		}

		const ids = Array.isArray(parsed?.conversation_ids) ? parsed.conversation_ids : [];
		const local = new Map();

		for (const id of ids) {
			if (typeof id !== 'string') continue;
			const session = streamSessions.get(id);
			if (session) local.set(id, sessionInfo(id, session));
		}

		const groups = new Map();

		for (const id of ids) {
			if (typeof id !== 'string' || local.has(id)) continue;
			const { conv, model } = splitConvModel(id);
			let backend = BACKENDS[0];
			let actual = conv;

			if (model) {
				const resolved = parseModelKey(model);
				backend = resolved.backend;
				actual = `${conv}::${resolved.model}`;
			}

			if (!groups.has(backend)) groups.set(backend, []);
			groups.get(backend).push(actual);
		}

		const out = [];

		for (const [backend, actualIds] of groups) {
			const payload = Buffer.from(JSON.stringify({ conversation_ids: actualIds }));
			const { body: responseBody, status } = await fetchUpstream(
				req,
				payload,
				'/v1/streams/lookup',
				backend
			);

			if (status !== 200) continue;

			try {
				const sessions = JSON.parse(responseBody.toString());
				if (!Array.isArray(sessions)) continue;

				for (const session of sessions) {
					if (session && typeof session.conversation_id === 'string') {
						const { conv, model } = splitConvModel(session.conversation_id);
						session.conversation_id = `${conv}::${modelKey(backend, model || MODEL_ID)}`;
					}
					out.push(session);
				}
			} catch {
				// keep whatever other backends answered
			}
		}

		return sendJson(res, 200, [...local.values(), ...out]);
	}

	// The llama.cpp UI omits `model` in single-model mode, but some engines
	// (gufo) require it, and they reject llama.cpp's -1 "no limit" sentinel.
	// Read the body once and normalize before proxying; the SSE response
	// still streams straight through.
	if ((pathname === '/v1/chat/completions' || pathname === '/v1/chat/completions/control') && req.method === 'POST') {
		const body = await readBody(req);
		let requested = '';
		try {
			const parsed = JSON.parse(body.toString());
			if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') {
				requested = parsed.model;
			}
		} catch {
			// route the first backend if the body is not JSON
		}

		const conv = req.headers['x-conversation-id'];
		const streamKey = typeof conv === 'string' ? conv : '';
		const headerModel = typeof conv === 'string' ? splitConvModel(conv).model : '';
		const chosen = requested || headerModel || MODEL_ID;
		const { backend, model } = parseModelKey(chosen);

		if (typeof conv === 'string') {
			const { conv: bare, model: convModel } = splitConvModel(conv);
			if (convModel) req.headers['x-conversation-id'] = `${bare}::${parseModelKey(convModel).model}`;
		}

		return proxyChat(req, res, normalizeChatRequest(body, model), backend, modelKey(backend, model), streamKey);
	}

	return proxy(req, res, undefined, BACKENDS[0]);
}

const mcpBackground = new McpBackground();

async function handleMcp(req, res) {
	const pathname = req.url.split('?')[0];

	try {
		if (pathname === '/mcp/config' && req.method === 'POST') {
			const body = await readBody(req);
			let parsed;
			try {
				parsed = JSON.parse(body.toString());
			} catch {
				return sendJson(res, 400, { error: { message: 'invalid JSON' } });
			}
			if (!parsed || typeof parsed !== 'object' || !parsed.servers || typeof parsed.servers !== 'object') {
				return sendJson(res, 400, { error: { message: 'servers must be an object' } });
			}

			const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
			return sendJson(res, 200, await mcpBackground.configure(parsed.servers, origin));
		}

		if (pathname === '/mcp/call' && req.method === 'POST') {
			const body = await readBody(req);
			let parsed;
			try {
				parsed = JSON.parse(body.toString());
			} catch {
				return sendJson(res, 400, { error: { message: 'invalid JSON' } });
			}
			if (!parsed || typeof parsed.server !== 'string' || typeof parsed.tool !== 'string') {
				return sendJson(res, 400, { error: { message: 'server and tool are required' } });
			}

			const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
			return sendJson(res, 200, await mcpBackground.callTool(parsed.server, parsed.tool, args));
		}

		if (pathname === '/mcp/status') return sendJson(res, 200, mcpBackground.status());
		if (pathname === '/mcp/tools') return sendJson(res, 200, mcpBackground.status().tools);

		return sendJson(res, 404, { error: { message: 'not found' } });
	} catch (error) {
		return sendJson(res, 502, {
			error: { message: error instanceof Error ? error.message : String(error) }
		});
	}
}

function serveStatic(req, res) {
	const pathname = decodeURIComponent(req.url.split('?')[0]);
	const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
	const file = path.resolve(DIST, relative);

	if (!file.startsWith(DIST + path.sep)) {
		res.writeHead(403).end('forbidden');
		return;
	}

	fs.stat(file, (error, stats) => {
		if (error || !stats.isFile()) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
			return;
		}

		const headers = {
			'cache-control': NO_CACHE.has(relative) ? 'no-cache' : 'public, max-age=31536000, immutable',
			'content-length': stats.size,
			'content-type': MIME[path.extname(file)] || 'application/octet-stream'
		};

		// the UI's sandbox worker needs a cross-origin isolated page
		if (relative === 'index.html') {
			headers['cache-control'] = 'no-cache';
			headers['cross-origin-embedder-policy'] = 'require-corp';
			headers['cross-origin-opener-policy'] = 'same-origin';
		}

		res.writeHead(200, headers);
		fs.createReadStream(file).pipe(res);
	});
}

export function createServer() {
	const server = http.createServer((req, res) => {
		const pathname = req.url.split('?')[0];

		if (pathname === '/cors-proxy') return void corsProxy(req, res);
		if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return void handleMcp(req, res);

		const isApi = PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));

		if (isApi) return void handleApi(req, res);
		return serveStatic(req, res);
	});

	server.on('close', () => void mcpBackground.close());
	return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!fs.existsSync(path.join(DIST, 'index.html'))) {
		console.error(`no UI build at ${DIST} - run "make build" first`);
		process.exit(1);
	}

	createServer().listen(PORT, HOST, () => {
		console.log(`llama-chat-standalone on http://${HOST}:${PORT}`);
		console.log(`  upstreams ${BACKENDS.map((b) => `${b.name}=${b.url}`).join(' ')}`);
		console.log(`  model ${MODEL_ID}  n_ctx ${N_CTX}  router ${MULTI}`);
	});
}
