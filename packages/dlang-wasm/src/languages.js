// The languages this package compiles.
//
// D is one language and one compiler here. The wasm backend targets a single architecture and
// druntime/Phobos are always linked in, so there is no standard to pick and no `-betterC` variant to
// switch to - unlike the C/C++ package, where `std` is a real choice. That is why this package has no
// `standardsFor()`.

export const LANGUAGE_IDS = ['d'];

const LANGUAGES = {
	d: { id: 'd', fileName: 'input.d' }
};

// Accepted spellings, so a host can pass whatever name its language registry uses.
const ALIASES = {
	d: 'd',
	dlang: 'd',
	dmd: 'd'
};

export function resolveLanguage(language) {
	const id = ALIASES[String(language ?? '').toLowerCase()];
	if (!id) {
		throw new Error(
			`Unknown language "${language}". This package supports: ${LANGUAGE_IDS.join(', ')}.`
		);
	}
	return LANGUAGES[id];
}
