// Re-gzips the compiler asset for this package.
//
//   node scripts/compress-asset.mjs <path-to-dmd.wasm>
//
// The asset ships gzipped, for two reasons: the raw module is 25 MB, which is over jsDelivr's 20 MB
// per-file limit, and installing 6 MB beats installing 26 MB. The loader inflates it, so the wire
// size is the same either way - this is not about bandwidth.
//
// The output is deterministic (Node writes no timestamp into the gzip header), so re-running this on
// the same input reproduces the same bytes. It also round-trips: what this writes is decompressed
// again and compared to the input, and nothing is written if they differ.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const input = process.argv[2];
if (!input) {
	console.error('usage: node scripts/compress-asset.mjs <path-to-dmd.wasm>');
	process.exit(1);
}

const outfile = fileURLToPath(new URL('../assets/dmd.wasm.gz', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const raw = await readFile(input);
const gzipped = gzipSync(raw, { level: 9 });

const roundTrip = gunzipSync(gzipped);
if (roundTrip.length !== raw.length || sha256(roundTrip) !== sha256(raw)) {
	throw new Error('gzip did not round-trip; refusing to write the asset');
}

await writeFile(outfile, gzipped);

console.log(`input   ${basename(input).padEnd(12)} ${raw.length} bytes  sha256 ${sha256(raw)}`);
console.log(`output  dmd.wasm.gz   ${gzipped.length} bytes  sha256 ${sha256(gzipped)}`);
console.log(`ratio   ${((100 * gzipped.length) / raw.length).toFixed(1)}%`);
console.log('\nNext: node scripts/asset-receipts.mjs');
