# @live-codes/dlang-wasm

Run D with one API, on the DMD compiler compiled to WebAssembly. Lexing, parsing, semantic analysis,
code generation, linking and execution all happen in the browser (or in Node) — **no server compiles
anything**, and nothing is sent anywhere.

```js
import { createCompiler } from '@live-codes/dlang-wasm';

const compiler = await createCompiler('d'); // Node: reads the assets in this package
const { stdout, errors, exitCode } = await compiler.run(`
    import std.stdio;
    void main() { writeln("hello from D"); }
`);
```

```
hello from D
```

## Install

```sh
npm install @live-codes/dlang-wasm
```

The package carries its own runtime — `assets/dmd.wasm`, 25 MB — so in Node there is nothing else to
set up, and in a browser one command puts a copy where you serve from.

## Node

Node has no filesystem-free entry point, so it reads the packaged assets itself and `baseUrl` is
optional:

```js
import { createCompiler } from '@live-codes/dlang-wasm';

const compiler = await createCompiler('d');
await compiler.run('import std.stdio;\nvoid main() { writeln(42); }', 'stdin for the program');
compiler.dispose();
```

**Node needs `--experimental-wasm-exnref`.** `dmd.wasm` is built with wasm exception handling, which
browsers ship but V8 still gates behind that flag; without it you get
`invalid value type 'exn'`. The `test` script passes it, and a Node host has to as well:

```sh
node --experimental-wasm-exnref your-app.mjs
```

## Browser

**Host it in a worker.** Chromium refuses to instantiate a wasm module whose memory is over 8 MB
*synchronously* on the main thread, and `dmd.wasm` is far past that:

```
WebAssembly.Instance is disallowed on the main thread, if the buffer size is larger than 8MB.
Use WebAssembly.instantiate, or use the flag `--enable-features=WebAssemblyUnlimitedSyncCompilation`.
```

There is no way around it from inside this package — compiling is synchronous, so instantiation is
too — and a multi-second compile does not belong on the main thread anyway. Every example below is
inside a worker, and the runtime says so plainly if you try it elsewhere.

A page cannot read a file inside `node_modules`, so publish the assets and point `baseUrl` at them:

```sh
npx dlang-wasm-copy-assets public/d
```

```js
import { createCompiler } from '@live-codes/dlang-wasm';

const compiler = await createCompiler('d', {
	baseUrl: new URL('/d/', location.href),
	onProgress: (fraction) => console.log(`${Math.round(fraction * 100)}%`)
});
const { stdout } = await compiler.run(code, stdinText);
```

`baseUrl` may be a `URL`, an absolute URL, or a path relative to the page. A directory served
cross-origin must send `Access-Control-Allow-Origin`; `dmd.wasm` is fetched with `fetch()` and does
not need any particular `Content-Type`.

Once published, one `WebAssembly.compile` of the runtime is shared by every compiler created against
the same URL, so a host that makes a compiler per run still only pays for the load once.

### Which worker

With a bundler, import the module entry in a module worker:

```js
// worker.module.js
import { createCompiler } from '@live-codes/dlang-wasm';

const compiler = await createCompiler('d', { baseUrl });
```

If the worker cannot use ES modules — LiveCodes builds its language workers from a content string —
`importScripts()` the IIFE build instead:

```js
importScripts('dlang-wasm.global.js'); // from @live-codes/dlang-wasm/iife
self.dlangWasm.createCompiler('d', { baseUrl });
```

`self.dlangWasm` is the same API as the module entry. [`example/`](example/) runs both — the module
entry in a module worker, and the IIFE in a classic worker — and checks the results.

There is no timeout that can preempt a running program: the wasm call does not yield. A program that
never returns blocks its thread until the **host terminates the worker**, which is the only way to
stop it.

## API

### `createCompiler(language = 'd', options)`

Returns a compiler. `language` is `d` (`dlang` and `dmd` are accepted).

| Option | Description |
| --- | --- |
| `baseUrl` | Where `dmd.wasm` is served from. Required outside Node. |
| `onProgress` | `(fraction) => void` for the asset download, 0 to 1. |

The returned object:

| Member | Description |
| --- | --- |
| `language` | The resolved language id. |
| `fileName` | The name the compiler reports sources under (`input.d`). |
| `run(code, input?)` | Compile and run. `input` is stdin, `string` or `Uint8Array`. |
| `warm()` | Compile druntime ahead of the first run. Optional. |
| `dispose()` | Release this compiler's hold on the shared runtime. Further runs throw. |

### `run()` result

| Field | Description |
| --- | --- |
| `stdout` | What the program wrote to fd 1. |
| `stderr` | What the program wrote to fd 2. |
| `output` | `stdout` and `stderr` in the order the program wrote them. |
| `errors` | The compiler's diagnostics, one string per line, ANSI stripped. Empty on a clean compile; a successful build can still carry deprecations. |
| `exitCode` | The program's exit status, or `null` if it never ran. |
| `compileMs` | Time spent compiling. `0` when unchanged source was reused. |
| `runMs` | Time spent running, or `null` if the program never ran. |

A failed compile does not throw: it comes back with `exitCode: null` and `errors` filled in. Only a
load failure, a disposed compiler, or a bad argument throws.

### `LANGUAGE_IDS`

`['d']`. D is one language and one compiler here: the wasm backend targets a single architecture and
druntime/Phobos are always linked, so there is no standard to choose and no `betterC` variant — which
is why this package has no `standardsFor()`, unlike `@live-codes/clang-wasm`.

## What works

Verified in Node and in Chromium; `npm test` compiles and runs all of it (12 tests).

- D with **druntime and Phobos** — `std.stdio`, `std.algorithm`, `std.range`, `std.conv`, templates,
  operator overloading, struct `toString`.
- **stdin** — `readln` and `stdin.byLine()` read the text you pass in, once, then see EOF.
- **stdout and stderr**, kept apart and ordered.
- **Exit codes** — `int main() { return 7; }` reports `7`.
- **Diagnostics** with file, line and column, e.g. `input.d(5): Error: cannot implicitly convert…`.
- **Repeat runs are cheap and deterministic** — an unchanged program is not recompiled (~50 ms), and
  it reads stdin again from the start rather than seeing a stale EOF.

Measured on this machine (Node, Chromium similar): the first compile of a program that pulls in
Phobos takes ~10–30 s; later runs of the *same* program are ~50 ms, and new stdin on the same program
costs no rebuild at all.

## Limitations

- **Output is batched, not streamed.** A program runs to completion inside one synchronous wasm call,
  so stdout arrives when it finishes. For a program that prints forever, nothing appears until it is
  killed. This is the main gap against LiveCodes' other wasm languages.
- **No filesystem, argv or environment.** A program gets stdin and nothing else; `args_get` and
  `environ_get` report empty. Multi-file programs are not possible — one source string is compiled.
- **One program is cached at a time**, so alternating between two programs recompiles each time.
  Re-running or feeding new stdin to the *same* program does not.
- **Stdin is a static buffer.** The program is handed all of it at once and then EOF, so there is no
  prompt-then-respond interaction.
- **`real` is unsupported.** Something in the wasm backend traps on `real.mant_dig`, so float-heavy
  Phobos can trap the instance; that surfaces as a diagnostic, not a crash.
- **The wasm backend is not upstream.** `dmd.wasm` is a build of dkorpel's `wasm-web-app` branch of
  `dlang/dmd`, pinned to the deployed explorer build rather than to a DMD release. Rebuilding it is a
  toolchain project (host LDC + LLVM `wasm-ld` + Binaryen), not a script. See
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **25 MB.** Fetched once and cached by the browser; `onProgress` is there to show it.

## LiveCodes integration

- Create one compiler per sandbox worker, lazily on the first D run, and call `warm()` when the
  language loads so the druntime compile does not land on the user's first Run.
- Assets belong on the CDN with the other wasm languages. `dmd.wasm` is 25 MB raw; it compresses well
  and is cached, but it should be lazily loaded only when a module actually uses D.
- `run()` collects output and returns it, rather than streaming it — see the first limitation. Wiring
  live stdout would mean changing the runtime's `fd_write` shim to hand chunks out as they are
  written, which only helps if the host can yield while the program runs.
- The compiler always reports the source as `input.d`, so diagnostics carry `input.d(<line>)`. A host
  with its own file name should map that name when showing errors.
- Extracting `file(line): Error: message` is straightforward — the ANSI escapes DMD emits are already
  stripped, unlike Clang's (a trap `@live-codes/clang-wasm` documents).
- A runaway program can only be stopped by terminating the worker.

## Development

```sh
npm install --include=dev     # note: `npm config get omit` is `dev` on some machines
npm test                      # real compiles, Node
npm run build:iife            # rewrites dist/dlang-wasm.global.js (committed)
node scripts/asset-receipts.mjs   # after replacing assets/dmd.wasm
```

`dist/` is committed because a classic worker can only `importScripts()` a URL, and consumers should
not need a bundler to get one. `dlang-wasm-copy-assets` verifies the assets against
`src/asset-receipts.js` before copying, so a stale pairing fails there rather than on someone's page.

## Licence

MIT. `assets/dmd.wasm` is DMD, druntime and Phobos under BSL-1.0 — permissive and MIT-compatible. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
