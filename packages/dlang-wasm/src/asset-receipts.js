// SHA-256 of every asset that ships in this package, so a directory served to a page can be checked
// by whoever serves it (`dlang-wasm-copy-assets` writes these next to the copy).
//
// Regenerate after replacing assets/dmd.wasm:  node scripts/asset-receipts.mjs

export const ASSET_RECEIPTS = {
	'dmd.wasm': {
		sha256: '65039fcc95a116e2007a0f74279b29868a882676b105b26005840a74965ebc45',
		bytes: 26209599
	}
};
