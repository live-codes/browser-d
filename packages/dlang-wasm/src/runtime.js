// The D runtime: one WebAssembly build of DMD, driven entirely in process.
//
// dmd.wasm is a one-shot compiler built against wasi-libc. It compiles a snippet *plus* every
// druntime/Phobos module it imports into a complete, self-linked wasm module, which we then
// instantiate beside it and run. Three properties of that compiler shape everything below, and each
// one is load-bearing:
//
//  1. Its global tables cannot be re-initialised in place and its allocator is a bump pointer that
//     never frees, so every *compile* gets a fresh instance. Reusing one leaks ~77 MB per compile and
//     corrupts state (a second `import std.stdio` traps).
//  2. Compiling druntime is most of a build and does not depend on the snippet, so it is done once:
//     the instance state after `dmdwasm_warm` is snapshotted, and every later build restores it and
//     compiles only the snippet against it.
//  3. The built program shares dmd.wasm's own stdin/stdout/stderr FILE pointers (the backend binds
//     those symbols to them), so the snapshot is restored before each *run* as well - otherwise
//     libc's EOF flag survives and a second run of the same program reads no input.

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;

/** Linear-memory slice the self-linked program's data and shadow stack live in. */
const PROGRAM_REGION = 8 << 20;
const PROGRAM_STACK = 1 << 20;
/**
 * Restoring the snapshot rewinds the frontend but not libc's heap top, which wasm can only grow, so
 * builds keep claiming fresh pages. Past this much growth the warm instance is dropped and rebuilt.
 */
const MEMORY_BUDGET = 512 << 20;

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

/** DMD colourises diagnostics; callers get plain text. */
const ANSI = /\x1b\[[0-9;]*m/g;

function diagnosticLines(text) {
	const plain = String(text ?? '').replace(ANSI, '').trim();
	return plain ? plain.split('\n') : [];
}

// Chromium refuses to instantiate a wasm module whose memory is over 8 MB synchronously on the main
// thread, and dmd.wasm is far past that. Nothing here can work around it - and a multi-second
// synchronous compile does not belong on the main thread anyway - so say what to do instead.
function instantiationHelp(cause) {
	const message = String(cause?.message ?? cause);
	if (!/main thread|larger than 8MB|UnlimitedSyncCompilation/i.test(message)) return message;
	return (
		'dmd.wasm must be instantiated in a worker: Chromium blocks synchronous instantiation of ' +
		'wasm modules over 8 MB on the main thread. Create the compiler inside a Worker - see the ' +
		'README. ' +
		`(${message})`
	);
}

/**
 * Wrap a compiled dmd.wasm module.
 *
 * @param {WebAssembly.Module} module
 * @returns {{ run(source: string, input?: string|Uint8Array): Promise<object>, warm(): void, dispose(): void }}
 */
export function createRuntime(module) {
	let exports = null;
	let memory = null;

	/** Writes the running program made, in order, so stdout/stderr can be recombined faithfully. */
	let programOutput = [];
	/** Compiler stderr during a build. */
	let diagnostics = '';
	/** Which of the two the fd_write shim is feeding right now. */
	let writing = 'diagnostics';

	let stdin = new Uint8Array(0);
	let stdinPos = 0;

	/** `{ region, snapshot }` for the warm instance, or null when it has been dropped. */
	let warm = null;
	/** `{ source, wasm, env, diagnostics }` for the last build, so re-running is not a recompile. */
	let built = null;

	const view = () => new DataView(memory.buffer);

	// --- WASI shim -----------------------------------------------------------------------------

	function writeIovecs(fd, iovecsPtr, iovecsLen, writtenPtr) {
		const data = view();
		let written = 0;
		let text = '';
		for (let i = 0; i < iovecsLen; i++) {
			const ptr = data.getUint32(iovecsPtr + i * 8, true);
			const len = data.getUint32(iovecsPtr + i * 8 + 4, true);
			text += textDecoder.decode(new Uint8Array(memory.buffer, ptr, len));
			written += len;
		}
		if (writing === 'program') programOutput.push({ fd, text });
		else diagnostics += text;
		data.setUint32(writtenPtr, written, true);
		return WASI_ESUCCESS;
	}

	function readIovecs(fd, iovecsPtr, iovecsLen, readPtr) {
		if (fd !== 0) return WASI_EBADF;
		const data = view();
		let read = 0;
		for (let i = 0; i < iovecsLen; i++) {
			const ptr = data.getUint32(iovecsPtr + i * 8, true);
			const len = data.getUint32(iovecsPtr + i * 8 + 4, true);
			const available = Math.min(len, stdin.length - stdinPos);
			if (available <= 0) break;
			new Uint8Array(memory.buffer, ptr, available).set(
				stdin.subarray(stdinPos, stdinPos + available)
			);
			stdinPos += available;
			read += available;
			if (stdinPos >= stdin.length) break;
		}
		// A zero-length read is EOF, which is exactly what readln / byLine are waiting for.
		data.setUint32(readPtr, read, true);
		return WASI_ESUCCESS;
	}

	const wasi = {
		fd_write: (fd, iovecs, len, written) => writeIovecs(fd, iovecs, len, written),
		fd_read: (fd, iovecs, len, read) => readIovecs(fd, iovecs, len, read),
		fd_pread: () => WASI_EBADF,
		fd_close: () => WASI_ESUCCESS,
		fd_seek: () => WASI_EBADF,
		// libc probes the filetype to choose TTY vs buffered behaviour, so the three standard fds are
		// reported as character devices rather than erroring.
		fd_fdstat_get: (fd, statPtr) => {
			if (fd > 2) return WASI_EBADF;
			const data = view();
			data.setUint8(statPtr, 2); // filetype: character_device
			data.setUint16(statPtr + 2, 0, true); // fdflags
			data.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true); // rights_base
			data.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true); // rights_inheriting
			return WASI_ESUCCESS;
		},
		fd_filestat_get: () => WASI_EBADF,
		fd_filestat_set_size: () => WASI_EBADF,
		fd_prestat_get: () => WASI_EBADF,
		fd_prestat_dir_name: () => WASI_EBADF,
		fd_readdir: () => WASI_EBADF,
		path_open: () => WASI_EBADF,
		path_readlink: () => WASI_EBADF,
		path_filestat_get: () => WASI_EBADF,
		path_filestat_set_times: () => WASI_EBADF,
		path_create_directory: () => WASI_EBADF,
		path_remove_directory: () => WASI_EBADF,
		path_unlink_file: () => WASI_EBADF,
		path_rename: () => WASI_EBADF,
		// No argv and no environment: a program gets its input on stdin and nothing else.
		environ_get: () => WASI_ESUCCESS,
		environ_sizes_get: (countPtr, sizePtr) => {
			const data = view();
			data.setUint32(countPtr, 0, true);
			data.setUint32(sizePtr, 0, true);
			return WASI_ESUCCESS;
		},
		args_get: () => WASI_ESUCCESS,
		args_sizes_get: (countPtr, sizePtr) => {
			const data = view();
			data.setUint32(countPtr, 0, true);
			data.setUint32(sizePtr, 0, true);
			return WASI_ESUCCESS;
		},
		clock_time_get: (id, precision, timePtr) => {
			// id 0 is the realtime clock; everything else (monotonic, cpu-time) comes from
			// performance.now(), which is what druntime's MonoTime wants.
			const ns =
				id === 0
					? BigInt(Date.now()) * 1000000n
					: BigInt(Math.round(performance.now() * 1e6));
			view().setBigUint64(timePtr, ns, true);
			return WASI_ESUCCESS;
		},
		// core.time refuses to start without a monotonic clock frequency, so this has to succeed:
		// report 1 microsecond, performance.now()'s clamped floor.
		clock_res_get: (id, resPtr) => {
			view().setBigUint64(resPtr, 1000n, true);
			return WASI_ESUCCESS;
		},
		random_get: (ptr, len) => {
			globalThis.crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len));
			return WASI_ESUCCESS;
		},
		poll_oneoff: () => WASI_EBADF,
		sched_yield: () => WASI_ESUCCESS,
		proc_exit: (code) => {
			throw new Error(`proc_exit(${code})`);
		}
	};

	// dmd.wasm pulls in more of the WASI surface than any of this calls. Anything not implemented
	// becomes a stub returning EBADF, so a new druntime module cannot turn into a LinkError.
	const wasiImports = new Proxy(wasi, {
		get: (target, name) => (name in target ? target[name] : () => WASI_EBADF),
		has: () => true
	});

	// --- instances -----------------------------------------------------------------------------

	function newInstance() {
		let instance;
		try {
			instance = new WebAssembly.Instance(module, {
				wasi_snapshot_preview1: wasiImports,
				env: {}
			});
		} catch (cause) {
			throw new Error(instantiationHelp(cause));
		}
		exports = instance.exports;
		memory = exports.memory;
		// dmdwasm_init runs the C global ctors and then druntime's rt_init (GC, TypeInfo, D module
		// ctors). The frontend needs all of it.
		if (exports.dmdwasm_init() === 0) {
			throw new Error('dmd.wasm runtime initialization failed');
		}
	}

	/** Compile druntime once and snapshot the resulting instance state. */
	function warmUp() {
		diagnostics = '';
		newInstance();
		const region = exports.malloc(PROGRAM_REGION);
		if (!region) throw new Error('dmd.wasm could not reserve the program region');
		if (exports.dmdwasm_warm(region, PROGRAM_STACK)) {
			throw new Error(
				`dmd.wasm could not precompile druntime:\n${diagnosticLines(diagnostics).join('\n')}`
			);
		}
		warm = { region, snapshot: new Uint8Array(memory.buffer).slice() };
	}

	/** Rewind to the post-warm state: libc's stdio goes back to its baseline. */
	function restore() {
		new Uint8Array(memory.buffer).set(warm.snapshot);
	}

	/** Build `source` into a runnable wasm module, against the warm snapshot. */
	function build(source) {
		// Recycle before building, never after: a build must leave `warm` in place for the run that
		// follows it.
		if (warm && memory.buffer.byteLength - warm.snapshot.length > MEMORY_BUDGET) {
			warm = null;
			built = null;
		}
		diagnostics = '';
		writing = 'diagnostics';
		if (warm) restore();
		else warmUp();

		const bytes = textEncoder.encode(source);
		const ptr = exports.dmdwasm_input_buffer(bytes.length + 1);
		new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
		new Uint8Array(memory.buffer, ptr + bytes.length, 1)[0] = 0;

		let errors;
		try {
			errors = exports.dmdwasm_build(ptr, bytes.length, warm.region, PROGRAM_STACK);
		} catch (cause) {
			// A trapped instance is not worth reusing; the next build starts from a new one.
			warm = null;
			return { errors: [`dmd.wasm trapped: ${cause.message}`] };
		}
		if (errors) return { errors: diagnosticLines(diagnostics) };

		const wasmPtr = exports.dmdwasm_wasm_ptr();
		const wasmLen = exports.dmdwasm_wasm_len();
		const binary = new Uint8Array(memory.buffer, wasmPtr, wasmLen).slice();

		// The program imports its libc from this instance, so its printf/malloc are dmd.wasm's and its
		// pointers stay dereferenceable on both sides. Anything dmd.wasm does not export becomes a
		// stub returning 0 rather than an instantiation LinkError.
		const env = Object.create(null);
		for (const [name, value] of Object.entries(exports)) {
			if (typeof value === 'function') env[name] = value;
		}
		env.memory = memory;
		const envImports = new Proxy(env, {
			get: (target, name) => (name in target ? target[name] : () => 0),
			has: () => true
		});

		return {
			wasm: new WebAssembly.Module(binary),
			env: envImports,
			exports,
			memory,
			diagnostics: diagnosticLines(diagnostics)
		};
	}

	/** Instantiate the built program and call `_start`. */
	function execute(entry) {
		exports = entry.exports;
		memory = entry.memory;
		programOutput = [];
		writing = 'program';
		// A new instance re-initialises the program's data segments and shadow stack, and the restore
		// clears libc's stdin EOF flag that the previous run left behind.
		if (warm) restore();

		let instance;
		try {
			// The program imports dmd.wasm's memory rather than allocating its own, so this instance
			// stays under the main thread's 8 MB synchronous-instantiation limit.
			instance = new WebAssembly.Instance(entry.wasm, {
				env: entry.env,
				wasi_snapshot_preview1: wasiImports
			});
		} catch (cause) {
			return { stdout: '', stderr: '', output: '', exitCode: null, trapped: instantiationHelp(cause) };
		}

		let exitCode = 0;
		let trapped = null;
		try {
			instance.exports._start();
		} catch (cause) {
			const exited = /^proc_exit\((-?\d+)\)$/.exec(cause.message || '');
			if (exited) exitCode = Number(exited[1]);
			else trapped = `program trapped: ${cause.message}`;
		}

		const stdout = programOutput
			.filter((chunk) => chunk.fd === 1)
			.map((chunk) => chunk.text)
			.join('');
		const stderr = programOutput
			.filter((chunk) => chunk.fd === 2)
			.map((chunk) => chunk.text)
			.join('');
		// stdout and stderr in the order the program wrote them.
		const output = programOutput.map((chunk) => chunk.text).join('');

		return { stdout, stderr, output, exitCode, trapped };
	}

	// --- public surface ------------------------------------------------------------------------

	async function run(source, input = '') {
		stdin = typeof input === 'string' ? textEncoder.encode(input) : input;
		stdinPos = 0;

		let compileMs = 0;
		if (!built || built.source !== source) {
			const started = performance.now();
			const result = build(source);
			compileMs = performance.now() - started;
			if (result.errors) {
				built = null;
				return {
					stdout: '',
					stderr: '',
					output: '',
					errors: result.errors,
					exitCode: null,
					compileMs,
					runMs: null
				};
			}
			built = { source, ...result };
		}

		const started = performance.now();
		const result = execute(built);
		const runMs = performance.now() - started;

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			output: result.output,
			// Diagnostics can be non-empty on a successful build (deprecations, warnings); a null
			// exitCode is what says the program never ran.
			errors: result.trapped ? [...built.diagnostics, result.trapped] : built.diagnostics,
			exitCode: result.trapped ? null : result.exitCode,
			compileMs,
			runMs
		};
	}

	/** Compile druntime ahead of the first run. Safe to call more than once. */
	function warmRuntime() {
		if (!warm) warmUp();
	}

	function dispose() {
		exports = null;
		memory = null;
		warm = null;
		built = null;
		programOutput = [];
		diagnostics = '';
		stdin = new Uint8Array(0);
		stdinPos = 0;
	}

	return { run, warm: warmRuntime, dispose };
}
