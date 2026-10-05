// Node, where the assets that ship in this package can be read off disk, so `baseUrl` becomes
// optional and `createCompiler('d')` is enough on its own.
//
// Node needs `--experimental-wasm-exnref` for this to work at all: dmd.wasm is built with wasm
// exception handling, which V8 still gates behind that flag. The `test` script passes it; see the
// README for what a host has to do.
import { createApi } from './api.js';
import { packagedAssets } from './packaged.node.js';

const api = createApi({ packaged: packagedAssets });

export const createCompiler = api.createCompiler;
export const { LANGUAGE_IDS } = api;
