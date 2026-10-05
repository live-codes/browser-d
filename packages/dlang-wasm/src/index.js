// The entry every environment gets unless something more specific matches, so it has to work without
// a filesystem: no `node:fs` here, and `baseUrl` is required because a browser cannot read a file
// that lives inside an npm package.
import { createApi } from './api.js';

const api = createApi({ packaged: null });

export const createCompiler = api.createCompiler;
export const { LANGUAGE_IDS } = api;
