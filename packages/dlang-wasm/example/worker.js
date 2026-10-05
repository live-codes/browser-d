// A classic (non-module) worker driving the IIFE build, which is the shape LiveCodes runs its
// languages in: a worker created from content, where an ES module cannot be loaded at all.
//
// `self.dlangWasm` is exactly the same API as the package's ES module entry.
importScripts('../dist/dlang-wasm.global.js');

self.onmessage = async (event) => {
	const { baseUrl, source, stdin } = event.data;
	try {
		const compiler = await self.dlangWasm.createCompiler('d', { baseUrl });
		const result = await compiler.run(source, stdin);
		self.postMessage({ ok: true, result });
	} catch (error) {
		self.postMessage({ ok: false, error: String(error?.message ?? error) });
	}
};
