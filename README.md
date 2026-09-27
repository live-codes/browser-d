# D in the browser — proof of concept

Running D in LiveCodes with **no server**: the compiler itself is WebAssembly, so
D source is lexed, parsed, semantically analysed, code-generated and **executed
entirely in the browser tab**. Nothing is sent anywhere.

Status: working. Verified end-to-end in Chrome — see [Verified](#verified).

## Run it

```sh
node serve.mjs          # http://localhost:8000/
```

Then open <http://localhost:8000/> and press **Run** (or Ctrl/Cmd+Enter).

A static file server is required (ES-module Workers and WebAssembly are blocked
over `file://`) but nothing is compiled server-side. `serve.mjs` exists mainly to
send `Content-Type: application/wasm` for `.wasm` — `WebAssembly.compileStreaming`
rejects the response otherwise. Any server configured for that will do.

`?wasm=<url>` overrides where the compiler is loaded from, so the vendored copy
can be swapped for a hosted/CDN build without touching the code:

```
http://localhost:8000/?wasm=https://dkorpel.github.io/dmd-explorer/dmd.wasm
```

## What this proves

- D with **druntime and Phobos** compiles and runs client-side — `std.stdio`,
  `std.algorithm`, `std.range`, templates, operator overloading, struct
  `toString` all work.
- **Diagnostics** come back with file/line/column and correct messages, so
  inline editor markers are feasible.
- A program that never terminates is **killable and recoverable**: the compiler
  runs in a Worker, which is terminated and replaced on a watchdog timeout, and
  the page is usable again afterwards.

## Verified

Chrome, all runs against `vendor/dmd.wasm` served locally.

| Program | Result | Time |
| --- | --- | --- |
| `writeln` + `foreach` | `hello from D…` / `0 1 4 9 16` | ~1–2 s |
| `std.algorithm`: `sort`, `filter`, `sum`, `maxElement` | correct output | ~8 s |
| Template struct + `opBinary` + `toString` | `a + b = (11.5, 22.5)` | ~8 s |
| Type error | `input.d(6): Error: cannot implicitly convert…` | ~0.6–1.1 s |
| `void main(){while(true){}}` | stopped at 60 s, compiler restarted, next run OK | — |

Wall-clock from Run to output, on a loaded page (compiler fetched, druntime
precompiled). Figures vary run to run and with machine load. The first program
that pulls in Phobos pays a multi-second build; later ones reuse the warm
snapshot, and re-running *unchanged* source skips the build entirely.

## How it works

The compiler is a WebAssembly build of DMD (`dmd.wasm`, 25 MB) built against
wasi-libc. It is driven from a Worker, which keeps the synchronous compile off
the main thread.

The interesting part is that `dmd.wasm` **self-links** (`-mwasm-selflink`): it
compiles the snippet plus every druntime/Phobos module it imports into a complete
WebAssembly module, resolving relocations itself instead of handing them to
`wasm-ld`. So the Run path is:

```
warmRuntime()                      compile druntime once, snapshot the instance
  ↓
build(src)                         compile snippet against the warm snapshot
  ↓  dmdwasm_wasm_ptr()/len()
new WebAssembly.Module(bin)        the program, as a runnable wasm module
  ↓
new WebAssembly.Instance(module, { env: <dmd.wasm's own exports>,
                                   wasi_snapshot_preview1 })
  ↓  _start()
stdout captured via the WASI fd_write shim
```

Because the program imports its libc from the instance it was linked against,
its `printf`/`malloc` are dmd.wasm's, and its pointers stay dereferenceable on
both sides. Two details in `vendor/glue.js` are load-bearing and worth not
"simplifying" away:

- **A fresh instance per compile.** The frontend is a one-shot compiler: its
  interning tables can't be re-initialised in place and its allocator is a bump
  pointer that never frees, so reusing an instance leaks ~77 MB per compile and
  corrupts global state (a second `import std.stdio` traps).
- **Snapshot/restore for the warm runtime.** Restoring the snapshot rewinds the
  frontend but not libc's heap top, so the warm instance is dropped and rebuilt
  once memory has grown past 512 MB.

### Worker protocol

`vendor/worker.js` is a thin wrapper over `vendor/glue.js`. The page sends:

| Message | Reply |
| --- | --- |
| `{type: "load", url}` | `loaded` / `loadError` |
| `{type: "warm"}` | `warmed` |
| `{type: "compile", src, wat}` | `result` — lex/parse/sema/AST/IR/asm/WAT + diagnostics |
| `{type: "run", src}` | `runPhase` stage, then `runResult` — `{output, errors, exitCode, diagnostics}` |

The PoC only uses `load`/`warm`/`run`. `compile` is unused here but is what a
diagnostics/lint pass would use, and it's the same call the upstream explorer
uses for its AST/IR/assembly panes.

## Caveats for LiveCodes

Things to resolve before this becomes a language, roughly in order of weight:

1. **Output is batched, not streamed.** The WASI shim accumulates stdout/stderr
   in a string and returns it when `_start()` finishes. A program that prints
   and then loops shows nothing until it's killed. LiveCodes expects live stdout,
   so the shim needs to postMessage incrementally, or the runner needs a way to
   flush on an interval.
2. **The wasm backend is not upstream.** `dmd.wasm` is built from dkorpel's
   `wasm-web-app` branch of `dlang/dmd` — upstream `master` plus a wasm backend
   and self-linking. The build is pinned to whatever is deployed to
   <https://dkorpel.github.io/dmd-explorer/>. Rebuilding it ourselves is a
   toolchain project (host LDC + LLVM `wasm-ld` + Binaryen), not a script.
   Worth asking upstream whether this is intended to land.
3. **25 MB download.** Payload size matters for a playground. It is
   `application/wasm` and cached by the browser, and can be lazily loaded only
   when a module actually uses D — the same treatment the other wasm languages
   get.
4. **No filesystem, args, env or stdin.** The WASI shim stubs them (stdin
   returns `EBADF`), so interactive `readln` is not available. Programs are
   pure-compute plus stdout/stderr.
5. **No `import` of other local modules / multi-file projects** — a single
   source string is compiled. LiveCodes' multi-file support would need the
   frontend's VFS surface, which this build doesn't expose.
6. **Compile cost.** Multi-second for Phobos-heavy programs. Acceptable for a
   Run button, too slow to drive from a keystroke debounce the way the explorer's
   AST panes do.
7. **`real` is unsupported.** Something in the wasm backend traps on
   `real.mant_dig`, so `static assert`s in float-heavy Phobos can trap the
   instance. `glue.js` catches it and returns a diagnostic.

## Layout

```
index.html          the PoC page — editor, Run, output, diagnostics
serve.mjs           static server (adds Content-Type: application/wasm)
vendor/
  dmd.wasm          the DMD wasm build (25 MB)
  glue.js           load / compile / run against dmd.wasm
  worker.js         worker wrapper around glue.js
  README.md         provenance, license and how to update
```

`vendor/` is upstream code, vendored unmodified. See [vendor/README.md](vendor/README.md)
for provenance and licensing.
