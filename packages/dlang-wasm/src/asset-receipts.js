// SHA-256 of every asset that ships in this package, so a directory served to a page can be checked
// by whoever serves it (`dlang-wasm-copy-assets` writes these next to the copy).
//
// Regenerate after changing assets:  node scripts/asset-receipts.mjs

export const ASSET_RECEIPTS = {
	'dmd.wasm': {
		sha256: '65039fcc95a116e2007a0f74279b29868a882676b105b26005840a74965ebc45',
		bytes: 26209599
	},
	'dmd.wasm.gz': {
		sha256: 'cbc35572a3069bb49df70513f8ed72db2f3fa8173741a68e9bf53203b0685613',
		bytes: 5731864,
		unpackedSha256: '65039fcc95a116e2007a0f74279b29868a882676b105b26005840a74965ebc45',
		unpackedBytes: 26209599
	}
};
