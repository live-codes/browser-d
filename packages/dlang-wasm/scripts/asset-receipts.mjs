// Rewrites src/asset-receipts.js from whatever is actually in assets/.
//
//   node scripts/asset-receipts.mjs
//
// Run this after replacing assets/dmd.wasm. `dlang-wasm-copy-assets` refuses to copy when the two
// disagree, so a missed run fails at copy time rather than silently serving unverified bytes.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const OUTFILE = fileURLToPath(new URL('../src/asset-receipts.js', import.meta.url));

const names = (await readdir(ASSETS)).sort();
const entries = [];

for (const name of names) {
	const bytes = await readFile(resolve(ASSETS, name));
	entries.push({
		name,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		bytes: bytes.length
	});
	console.log(`${name}  ${entries.at(-1).sha256}  ${entries.at(-1).bytes} bytes`);
}

const body = entries
	.map(({ name, sha256, bytes }) => `\t'${name}': {\n\t\tsha256: '${sha256}',\n\t\tbytes: ${bytes}\n\t}`)
	.join(',\n');

await writeFile(
	OUTFILE,
	`// SHA-256 of every asset that ships in this package, so a directory served to a page can be checked
// by whoever serves it (\`dlang-wasm-copy-assets\` writes these next to the copy).
//
// Regenerate after replacing assets/dmd.wasm:  node scripts/asset-receipts.mjs

export const ASSET_RECEIPTS = {
${body}
};
`
);

console.log(`\nWrote ${OUTFILE}`);
