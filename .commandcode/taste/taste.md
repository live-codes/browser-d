# Taste

## Architecture
- Prefers client-side / serverless solutions: code should run entirely in the browser with no backend servers. Confidence: 0.6

## Workflow
- Prefers to start with a minimal, self-contained proof-of-concept (e.g., a single simple HTML page that works) before wiring an approach into the full project. Confidence: 0.6
- Values feature parity with existing implementations: when adding a capability, expects it to work the way comparable features already do elsewhere in the project (e.g. "fake stdin like we did in other wasm languages"). Prior art in the codebase beats a novel approach. Confidence: 0.7
- Wants new deliverables shaped to match the existing analogue in the project rather than invented fresh — e.g. an npm package "similar to `@live-codes/clang-wasm`", mirroring its conventions (shared API shape, exports map, bin CLI, committed build output). Confidence: 0.7
