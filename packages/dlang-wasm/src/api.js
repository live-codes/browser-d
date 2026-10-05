import { loadWasmModule, resolveAssetSource } from './assets.js';
import { LANGUAGE_IDS, resolveLanguage } from './languages.js';
import { createRuntime } from './runtime.js';

// One runtime per asset source, shared by every compiler created against it: compiling druntime is
// the expensive part of a first run and it does not depend on the program. Refcounted, so a host
// that creates a compiler per run still only warms one runtime.
const runtimes = new Map();

async function acquireRuntime(source, options) {
	let entry = runtimes.get(source.key);
	if (!entry) {
		entry = {
			key: source.key,
			refs: 0,
			// Serialises runs: the runtime is a single wasm instance and one compile at a time.
			lock: Promise.resolve(),
			runtime: null
		};
		entry.runtime = loadWasmModule(source, options).then((module) => createRuntime(module));
		runtimes.set(source.key, entry);
		// A failed load must not be cached, or fixing the server and retrying keeps failing.
		entry.runtime.catch(() => runtimes.delete(source.key));
	}
	entry.refs++;
	await entry.runtime;
	return entry;
}

function releaseRuntime(entry) {
	entry.refs--;
	if (entry.refs > 0) return;
	runtimes.delete(entry.key);
	entry.runtime.then(
		(runtime) => runtime.dispose(),
		() => {}
	);
}

function withRuntimeLock(entry, task) {
	const result = entry.lock.then(task, task);
	entry.lock = result.then(
		() => {},
		() => {}
	);
	return result;
}

// One implementation, two entry points: `index.js` for anything without a filesystem, and
// `index.node.js` for Node, which can also read the assets that ship in this package.
export function createApi({ packaged }) {
	/**
	 * Create a compiler.
	 *
	 * The runtime is shared between every compiler created against the same assets, so asking for a
	 * compiler per run costs one asset load rather than one per run.
	 *
	 * @param {'d'} [language] - the language to compile. Defaults to D.
	 * @param {object} [options]
	 * @param {string|URL} [options.baseUrl] - where `dmd.wasm` is served from. Required in a browser;
	 *   in Node it can be omitted to use the copy that ships in this package.
	 * @param {(fraction: number) => void} [options.onProgress] - asset download progress, 0 to 1.
	 */
	async function createCompiler(language = 'd', options = {}) {
		const resolved = resolveLanguage(language);
		const source = resolveAssetSource(options, packaged);
		const entry = await acquireRuntime(source, options);

		let disposed = false;

		return {
			/** The resolved language id, always `d`. */
			language: resolved.id,

			/** The name the compiler reports the source under, e.g. in diagnostics. */
			fileName: resolved.fileName,

			/**
			 * Compile and run a program.
			 *
			 * The call is synchronous underneath - a program that never returns will block the thread
			 * it is called on - so run this in a worker the host can terminate. See the README.
			 *
			 * @param {string} code - the program source.
			 * @param {string|Uint8Array} [input] - stdin, handed to the program once and then closed.
			 * @returns {Promise<{stdout: string, stderr: string, output: string, errors: string[],
			 *   exitCode: number|null, compileMs: number, runMs: number|null}>}
			 *   `output` is stdout and stderr in the order the program wrote them. `errors` holds the
			 *   compiler's diagnostics and is empty on a clean compile. `exitCode` is null when the
			 *   program never ran, and `runMs` is null alongside it.
			 */
			async run(code, input = '') {
				if (disposed) throw new Error('This compiler has been disposed.');
				if (typeof code !== 'string') {
					throw new Error('run() needs the program source as its first argument.');
				}
				return withRuntimeLock(entry, () => entry.runtime.then((runtime) => runtime.run(code, input)));
			},

			/**
			 * Compile druntime ahead of the first run, so the first Run only pays for the program.
			 * Optional; the first `run()` does this itself if it has not been called.
			 */
			async warm() {
				if (disposed) throw new Error('This compiler has been disposed.');
				return withRuntimeLock(entry, () => entry.runtime.then((runtime) => runtime.warm()));
			},

			/** Release this compiler's hold on the shared runtime. Further runs throw. */
			dispose() {
				if (disposed) return;
				disposed = true;
				releaseRuntime(entry);
			}
		};
	}

	return { createCompiler, LANGUAGE_IDS };
}
