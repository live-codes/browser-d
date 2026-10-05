// A module worker using the package's ES module entry — the shape a host with a bundler uses.
//
// A worker is not optional here: Chromium refuses to instantiate a wasm module whose memory is over
// 8 MB synchronously on the main thread, and dmd.wasm is far past that. See the README.
import { createCompiler } from '../src/index.js';

self.onmessage = async (event) => {
	const { baseUrl, source, stdin } = event.data;
	try {
		const compiler = await createCompiler('d', { baseUrl });
		const result = await compiler.run(source, stdin);
		self.postMessage({ ok: true, result });
	} catch (error) {
		self.postMessage({ ok: false, error: String(error?.message ?? error) });
	}
};
