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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST || path.join(ROOT, 'ui/apps/chat/dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:8888').replace(/\/+$/, '');
const MODEL_ID = process.env.MODEL_ID || 'local-model';
const N_CTX = Number(process.env.N_CTX || 8192);
const CHAT_TEMPLATE = process.env.CHAT_TEMPLATE || '';
const API_KEY = process.env.API_KEY || '';
const MODALITIES = new Set(
	(process.env.MODALITIES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Paths the UI sends to the model server. Everything else is a static asset.
const PROXY_PREFIXES = ['/v1', '/props', '/models', '/slots', '/tools'];

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
export function synthProps() {
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
		role: 'model',
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

function upstreamHeaders(req) {
	const headers = { ...req.headers, host: new URL(UPSTREAM).host };
	delete headers['accept-encoding']; // keep the body readable for the JSON fallbacks
	if (API_KEY && !headers.authorization) headers.authorization = `Bearer ${API_KEY}`;
	return headers;
}

/** Buffered request, for the two endpoints that may need a fallback body. */
function fetchUpstream(req, body, pathOverride) {
	return new Promise((resolve) => {
		const url = new URL(UPSTREAM + (pathOverride ?? req.url));
		const request = http.request(
			{
				headers: upstreamHeaders(req),
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
function proxy(req, res) {
	const url = new URL(UPSTREAM + req.url);
	const request = http.request(
		{
			headers: upstreamHeaders(req),
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
	req.pipe(request);
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

async function handleApi(req, res) {
	const pathname = req.url.split('?')[0];

	if (pathname === '/props') {
		// The UI reads model capabilities (vision/audio/video) from /props at page
		// load. A response without cache-control gets heuristic-cached by the
		// browser, so one synthesized fallback served during an upstream blip
		// would stick forever and wrongly hide image upload. Never cache /props.
		const NO_STORE = { 'cache-control': 'no-store' };
		const { body, status } = await fetchUpstream(req);
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
		const retry = await fetchUpstream(req, undefined, '/props');
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
		const { body, status } = await fetchUpstream(req);
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

	if (pathname === '/tools') {
		const { body, status } = await fetchUpstream(req);
		if (status === 200) {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			return res.end(body);
		}
		return sendJson(res, 200, []);
	}

	return proxy(req, res);
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
	return http.createServer((req, res) => {
		const pathname = req.url.split('?')[0];

		if (pathname === '/cors-proxy') return void corsProxy(req, res);

		const isApi = PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));

		if (isApi) return void handleApi(req, res);
		return serveStatic(req, res);
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!fs.existsSync(path.join(DIST, 'index.html'))) {
		console.error(`no UI build at ${DIST} - run "make build" first`);
		process.exit(1);
	}

	createServer().listen(PORT, HOST, () => {
		console.log(`llama-chat-standalone on http://${HOST}:${PORT}`);
		console.log(`  upstream ${UPSTREAM}  model ${MODEL_ID}  n_ctx ${N_CTX}`);
	});
}
