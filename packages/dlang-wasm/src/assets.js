// Where the runtime wasm comes from, and how it becomes a WebAssembly.Module.
//
// Two sources, matching the two entry points: `packaged` (Node can read the files that ship in this
// package straight off disk) and `baseUrl` (anything else fetches them). Modules are cached per
// source, so two compilers asking for the same assets compile the wasm once.

const MODULES = new Map();

function withTrailingSlash(value) {
	const text = String(value);
	// A query or hash belongs to the path, not to the directory, so only strip a real trailing slash.
	return text.endsWith('/') ? text : `${text}/`;
}

function resolveBaseUrl(baseUrl) {
	if (baseUrl == null) return null;
	// A URL instance is already absolute; a string may be relative to the page.
	const url = new URL(withTrailingSlash(baseUrl), globalThis.location?.href);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`baseUrl must be http(s), got "${baseUrl}".`);
	}
	return url.href;
}

export function resolveAssetSource(options = {}, packaged = null) {
	if (packaged) {
		// Carries `readBytes` through, so nothing downstream has to know about node:fs.
		return { kind: 'packaged', ...packaged, key: `file:${packaged.wasmPath}` };
	}
	if (!options.baseUrl) {
		throw new Error(
			"createCompiler() needs the URL the runtime assets are served from, for example " +
				"createCompiler('d', { baseUrl: new URL('/d/', location.href) }). " +
				'Run `npx dlang-wasm-copy-assets <dir>` to put them in a directory you serve.'
		);
	}
	const base = resolveBaseUrl(options.baseUrl);
	const url = new URL('dmd.wasm', base).href;
	return { kind: 'url', url, key: url };
}

/** Compile the runtime, once per source. */
export function loadWasmModule(source, options = {}) {
	const cached = MODULES.get(source.key);
	if (cached) return cached;
	const pending = compile(source, options.onProgress);
	MODULES.set(source.key, pending);
	// A failed load must not be cached, or retrying after fixing the server keeps failing.
	pending.catch(() => MODULES.delete(source.key));
	return pending;
}

async function compile(source, onProgress) {
	const bytes =
		source.kind === 'packaged'
			? await readPackaged(source, onProgress)
			: await readRemote(source, onProgress);
	try {
		return await WebAssembly.compile(bytes);
	} catch (cause) {
		throw new Error(
			`Failed to compile the runtime wasm from ${source.url ?? source.wasmPath}: ` +
				`${cause.message}${v8FlagHint(cause)}`,
			{ cause }
		);
	}
}

async function readPackaged(source, onProgress) {
	// `readBytes` comes from packaged.node.js, so nothing here imports `node:fs` and the browser
	// bundle stays free of Node-only code.
	const bytes = await source.readBytes();
	onProgress?.(1);
	return bytes;
}

async function readRemote(source, onProgress) {
	// Deliberately not WebAssembly.compileStreaming: that requires the server to send
	// `Content-Type: application/wasm`, and a wrong MIME type should not be the difference between
	// this working and not.
	const response = await fetch(source.url);
	if (!response.ok) {
		throw new Error(
			`Failed to load dmd.wasm from ${source.url}: HTTP ${response.status} ${response.statusText}`
		);
	}
	return readBody(response, onProgress);
}

// dmd.wasm is built with wasm exception handling. Browsers ship it; V8 in Node still gates it behind
// a flag, and the bare "invalid value type 'exn'" explains nothing on its own.
function v8FlagHint(cause) {
	const isNode = typeof process !== 'undefined' && process.versions?.node;
	if (!isNode || !/exn|invalid value type/i.test(String(cause?.message))) return '';
	return ' Node needs --experimental-wasm-exnref to compile dmd.wasm.';
}

async function readBody(response, onProgress) {
	if (!onProgress || !response.body) return new Uint8Array(await response.arrayBuffer());

	const total = Number(response.headers.get('content-length')) || 0;
	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		// Without a length there is nothing to be a fraction of; report "started" rather than lie.
		onProgress(total ? Math.min(received / total, 1) : 0);
	}

	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	onProgress(1);
	return bytes;
}
