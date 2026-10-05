#!/usr/bin/env node
// Copies the runtime assets that ship inside this package into a directory you serve.
//
// This is the browser story: a page cannot read a file inside node_modules, so the assets have to be
// published by whatever serves the page. One command drops a complete, self-describing copy into
// your public directory; point `baseUrl` at it and nothing else has to be hosted.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_RECEIPTS } from '../src/asset-receipts.js';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

const USAGE = `Copy the runtime assets that ship with this package into a directory you serve.

  dlang-wasm-copy-assets [directory]

  directory      where to write them (default: ./d)
  --print-path   print the packaged assets directory and exit
  --help         print this
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
if (args.includes('--print-path')) {
	console.log(ASSETS);
	process.exit(0);
}

const target = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'd');
const names = (await readdir(ASSETS)).sort();

// Check the bytes against the receipts before copying anything, so a stale assets/receipts pairing
// fails here rather than as a mysterious compile error on someone's page.
for (const name of names) {
	const receipt = ASSET_RECEIPTS[name];
	if (!receipt) {
		throw new Error(
			`assets/${name} has no entry in src/asset-receipts.js. Run: node scripts/asset-receipts.mjs`
		);
	}
	const bytes = await readFile(resolve(ASSETS, name));
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (digest !== receipt.sha256 || bytes.length !== receipt.bytes) {
		throw new Error(
			`assets/${name} does not match its receipt (${digest}, ${bytes.length} bytes). ` +
				'Run: node scripts/asset-receipts.mjs'
		);
	}
}

await mkdir(target, { recursive: true });
for (const entry of await readdir(ASSETS, { withFileTypes: true })) {
	await cp(resolve(ASSETS, entry.name), resolve(target, entry.name), {
		recursive: true,
		force: true
	});
}

// The copy carries the receipts for its own bytes, so whoever serves it can check it.
await writeFile(
	resolve(target, 'asset-receipts.json'),
	`${JSON.stringify(ASSET_RECEIPTS, null, 2)}\n`
);

let totalBytes = 0;
for (const entry of await readdir(target, { withFileTypes: true })) {
	if (!entry.isFile() || entry.name === 'asset-receipts.json') continue;
	totalBytes += (await stat(resolve(target, entry.name))).size;
}

console.log(`Runtime assets copied to ${target}  (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log('Serve that directory and pass its URL as baseUrl, for example:');
console.log("  await createCompiler('d', { baseUrl: new URL('/d/', location.href) });");
