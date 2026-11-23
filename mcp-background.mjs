// Server-owned MCP connections so tool calls survive the browser tab being
// hidden. The UI posts its settings to /mcp/config and calls /mcp/call.
import { URL } from 'node:url';

const HEADER_PREFIX = 'x-llama-server-proxy-header-';
const DEFAULT_IMAGE_MIME = 'image/png';
const NEWLINE = '\n';

const SDK = new URL('./ui/apps/chat/node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url);
let sdkPromise;

async function loadSdk() {
	if (!sdkPromise) {
		sdkPromise = Promise.all([
			import(new URL('client/index.js', SDK).href),
			import(new URL('client/streamableHttp.js', SDK).href),
			import(new URL('client/sse.js', SDK).href),
			import(new URL('client/websocket.js', SDK).href)
		]);
	}

	return sdkPromise;
}

function proxiedHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers || {})) {
		out[`${HEADER_PREFIX}${key}`] = value;
	}
	return out;
}

function proxyUrl(origin, target) {
	const url = new URL('/cors-proxy', origin);
	url.searchParams.set('url', target.href);
	return url;
}

function proxyFetch(origin, headers) {
	return async (input, init = {}) => {
		const target = new URL(input instanceof URL ? input.href : String(input));
		const merged = new Headers(init.headers || headers || {});
		for (const [key, value] of Object.entries(headers || {})) merged.set(key, value);

		const out = {};
		for (const [key, value] of merged) out[`${HEADER_PREFIX}${key}`] = value;

		return fetch(proxyUrl(origin, target), { ...init, headers: out });
	};
}

function formatSingleContent(content) {
	if (content.type === 'text' && content.text) return content.text;
	if (content.type === 'image' && content.data) {
		return `data:${content.mimeType || DEFAULT_IMAGE_MIME};base64,${content.data}`;
	}
	if (content.type === 'resource' && content.resource) {
		const resource = content.resource;
		if (resource.text) return resource.text;
		if (resource.blob) return resource.blob;
		return JSON.stringify(resource);
	}
	if (content.data && content.mimeType) return `data:${content.mimeType};base64,${content.data}`;
	return JSON.stringify(content);
}

function formatToolResult(result) {
	const content = result.content;
	if (!Array.isArray(content)) return '';

	const formatted = content.map(formatSingleContent).filter(Boolean).join(NEWLINE);
	if (formatted) return formatted;
	if (result.structuredContent && typeof result.structuredContent === 'object') {
		return JSON.stringify(result.structuredContent);
	}
	return '';
}

export class McpBackground {
	constructor() {
		this.configs = new Map();
		this.connections = new Map();
		this.tools = new Map();
		this.errors = new Map();
		this.origin = '';
	}

	async configure(servers, origin) {
		await this.close();
		this.origin = origin || this.origin;
		this.configs.clear();
		this.tools.clear();
		this.errors.clear();

		for (const [name, config] of Object.entries(servers || {})) {
			if (!config || typeof config.url !== 'string' || !config.url) continue;
			this.configs.set(name, config);
			try {
				await this.connect(name, config);
			} catch (error) {
				this.errors.set(name, error instanceof Error ? error.message : String(error));
			}
		}

		return this.status();
	}

	async connect(name, config) {
		const [clientModule, streamableModule, sseModule, websocketModule] = await loadSdk();
		const { Client } = clientModule;
		const { StreamableHTTPClientTransport } = streamableModule;
		const { SSEClientTransport } = sseModule;
		const { WebSocketClientTransport } = websocketModule;

		const client = new Client(
			{ name: 'llama-ui-mcp', version: '1.0.0' },
			{ capabilities: { tools: { listChanged: true } } }
		);

		const requestInit = {};
		if (config.headers) {
			requestInit.headers = config.useProxy ? proxiedHeaders(config.headers) : config.headers;
		}

		let transport;
		if (config.transport === 'websocket') {
			if (config.useProxy) throw new Error('WebSocket transport does not support CORS proxy');
			transport = new WebSocketClientTransport(new URL(config.url));
		} else {
			const target = new URL(config.url);
			const url = config.useProxy ? proxyUrl(this.origin, target) : target;
			const fetchFn = config.useProxy ? proxyFetch(this.origin, config.headers) : fetch;

			if (config.transport === 'sse') {
				transport = new SSEClientTransport(url, {
					eventSourceInit: { fetch: fetchFn },
					fetch: fetchFn,
					requestInit
				});
			} else {
				transport = new StreamableHTTPClientTransport(url, { fetch: fetchFn, requestInit });
			}
		}

		await client.connect(transport);
		const { tools } = await client.listTools();

		for (const tool of tools) {
			this.tools.set(tool.name, {
				description: tool.description,
				inputSchema: tool.inputSchema,
				name: tool.name,
				server: name
			});
		}

		this.connections.set(name, { client, transport });
	}

	async callTool(serverName, toolName, args) {
		const connection = this.connections.get(serverName);
		if (!connection) throw new Error(`MCP server "${serverName}" is not connected`);

		try {
			const result = await connection.client.callTool({ arguments: args, name: toolName });
			return { content: formatToolResult(result), isError: Boolean(result.isError) };
		} catch (error) {
			if (error && error.code === 404) {
				await this.reconnect(serverName);
				const newConnection = this.connections.get(serverName);
				if (!newConnection) throw new Error(`Failed to reconnect to "${serverName}"`, { cause: error });
				const result = await newConnection.client.callTool({ arguments: args, name: toolName });
				return { content: formatToolResult(result), isError: Boolean(result.isError) };
			}
			throw error;
		}
	}

	async reconnect(serverName) {
		const config = this.configs.get(serverName);
		if (!config) return;
		try {
			await this.connections.get(serverName)?.client.close();
		} catch {
			// close failures are not actionable here
		}
		this.connections.delete(serverName);
		await this.connect(serverName, config);
	}

	status() {
		return {
			servers: [...this.configs.keys()].map((name) => ({
				name,
				connected: this.connections.has(name),
				toolCount: [...this.tools.values()].filter((tool) => tool.server === name).length,
				error: this.errors.get(name)
			})),
			tools: [...this.tools.values()]
		};
	}

	async close() {
		for (const connection of this.connections.values()) {
			try {
				await connection.client.close();
			} catch {
				// close failures are not actionable here
			}
		}
		this.connections.clear();
	}
}
