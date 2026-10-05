// Rewrites src/asset-receipts.js from whatever is actually in assets/.
//
//   node scripts/asset-receipts.mjs
//
// Run this after adding or replacing an asset. `dlang-wasm-copy-assets` refuses to copy when the two
// disagree, so a missed run fails at copy time rather than silently serving unverified bytes.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const OUTFILE = fileURLToPath(new URL('../src/asset-receipts.js', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const names = (await readdir(ASSETS)).sort();
const entries = [];

for (const name of names) {
	const bytes = await readFile(resolve(ASSETS, name));
	const entry = { name, sha256: sha256(bytes), bytes: bytes.length };

	// A compressed asset also records what it unpacks to, so the compiled module keeps a verifiable
	// identity even though only the gzipped file ships.
	if (name.endsWith('.gz')) {
		const unpacked = gunzipSync(bytes);
		entry.unpackedSha256 = sha256(unpacked);
		entry.unpackedBytes = unpacked.length;
	}

	entries.push(entry);
	console.log(
		`${name}  ${entry.sha256}  ${entry.bytes} bytes` +
			(entry.unpackedSha256 ? `\n  unpacks to ${entry.unpackedSha256}  ${entry.unpackedBytes} bytes` : '')
	);
}

const body = entries
	.map(({ name, sha256: hash, bytes, unpackedSha256, unpackedBytes }) => {
		const fields = [`\t\tsha256: '${hash}'`, `\t\tbytes: ${bytes}`];
		if (unpackedSha256) {
			fields.push(`\t\tunpackedSha256: '${unpackedSha256}'`, `\t\tunpackedBytes: ${unpackedBytes}`);
		}
		return `\t'${name}': {\n${fields.join(',\n')}\n\t}`;
	})
	.join(',\n');

await writeFile(
	OUTFILE,
	`// SHA-256 of every asset that ships in this package, so a directory served to a page can be checked
// by whoever serves it (\`dlang-wasm-copy-assets\` writes these next to the copy).
//
// Regenerate after changing assets:  node scripts/asset-receipts.mjs

export const ASSET_RECEIPTS = {
${body}
};
`
);

console.log(`\nWrote ${OUTFILE}`);
