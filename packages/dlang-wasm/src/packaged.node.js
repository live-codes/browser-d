// The assets that ship inside this package, as paths on disk. Node can read them directly, which is
// what makes `createCompiler('d')` work with no `baseUrl` and nothing hosted.
//
// Node-only: this file imports `node:fs`, so it is reachable only from `index.node.js`. The browser
// bundle never includes it - see scripts/build-iife.mjs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WASM = new URL('../assets/dmd.wasm', import.meta.url);

export const packagedAssets = {
	directory: fileURLToPath(new URL('../assets/', import.meta.url)),
	wasmPath: fileURLToPath(WASM),
	/** @returns {Promise<Uint8Array>} */
	readBytes: () => readFile(WASM)
};
