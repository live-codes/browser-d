// Builds the IIFE bundle: one classic script, for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// The output is committed, because a classic worker can only `importScripts()` a URL and consumers
// should not need a bundler to get one. It is built from the browser entry, so it never pulls in the
// Node-only packaged-assets code.
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outfile = fileURLToPath(new URL('../dist/dlang-wasm.global.js', import.meta.url));

await build({
	entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'dlangWasm',
	minify: true,
	platform: 'browser',
	target: 'es2022',
	legalComments: 'external',
	banner: {
		js: `/*! @live-codes/dlang-wasm - MIT. IIFE build, sets self.dlangWasm.
 *  importScripts('dlang-wasm.global.js') then self.dlangWasm.createCompiler('d', { baseUrl }).
 *  Bundles no third-party code: the WASI shim and the runtime are this package's own. */`
	}
});

console.log(`dist/dlang-wasm.global.js  ${(statSync(outfile).size / 1024).toFixed(1)} KB (minified)`);
