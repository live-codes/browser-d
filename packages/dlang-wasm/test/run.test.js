// Real compiles, in Node, against the assets that ship in this package.
//
//   npm test
//
// Node needs --experimental-wasm-exnref: dmd.wasm is built with wasm exception handling, which V8
// still gates behind that flag. The package's `test` script passes it, and a consumer has to as well.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createCompiler, LANGUAGE_IDS } from '../src/index.node.js';

const compiler = await createCompiler('d');
after(() => compiler.dispose());

const SUM_SOURCE = `import std.stdio, std.conv;

void main()
{
    long sum;
    size_t count;
    foreach (line; stdin.byLine())
    {
        sum += line.to!long;
        ++count;
    }
    writeln("numbers: ", count, "  sum: ", sum);
}
`;

test('exposes the language ids', () => {
	assert.deepEqual(LANGUAGE_IDS, ['d']);
});

test('compiles and runs a program, capturing stdout', async () => {
	const result = await compiler.run(`import std.stdio;

void main()
{
    writeln("hello from D");
}
`);
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, 'hello from D\n');
	assert.equal(result.output, 'hello from D\n');
	assert.equal(result.exitCode, 0);
	assert.equal(typeof result.compileMs, 'number');
	assert.ok(result.runMs >= 0);
});

test('links druntime and Phobos', async () => {
	const result = await compiler.run(`import std.stdio, std.algorithm;

void main()
{
    writeln([5, 3, 9, 1].sort);
}
`);
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, '[1, 3, 5, 9]\n');
});

test('supports floats and std.math', async () => {
	const result = await compiler.run(`import std.stdio, std.math;

void main()
{
    writeln(sqrt(2.0));
    writeln(sin(0.0), " ", pow(2.0, 10.0));
    real x = 1.5L;
    writeln(x, " ", real.mant_dig);
}
`);
	assert.deepEqual(result.errors, []);
	// `real` is double on wasm, so mant_dig is 53 rather than x87's 64.
	assert.equal(result.stdout, '1.41421\n0 1024\n1.5 53\n');
});

test('feeds stdin to the program', async () => {
	const result = await compiler.run(SUM_SOURCE, '1\n2\n35\n');
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, 'numbers: 3  sum: 38\n');
});

test('reads stdin again on a repeat run, and does not rebuild', async () => {
	const first = await compiler.run(SUM_SOURCE, '1\n2\n35\n');
	const second = await compiler.run(SUM_SOURCE, '1\n2\n35\n');
	assert.equal(second.stdout, first.stdout, 'a repeat run must see the same input');
	assert.equal(second.compileMs, 0, 'running unchanged source should reuse the build');
	assert.equal(second.runMs > 0, true);
});

test('takes new stdin without rebuilding', async () => {
	const result = await compiler.run(SUM_SOURCE, '10\n20\n');
	assert.equal(result.stdout, 'numbers: 2  sum: 30\n');
	assert.equal(result.compileMs, 0);
});

test('keeps stdout and stderr apart, and output in write order', async () => {
	const result = await compiler.run(`import std.stdio;

void main()
{
    writeln("to out");
    stdout.flush();
    stderr.writeln("to err");
    stderr.flush();
}
`);
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, 'to out\n');
	assert.equal(result.stderr, 'to err\n');
	assert.equal(result.output, 'to out\nto err\n');
});

test('reports a compile error without running anything', async () => {
	const result = await compiler.run(`import std.stdio;

void main()
{
    int x = "not an int";
    writeln(x);
}
`);
	assert.equal(result.exitCode, null);
	assert.equal(result.runMs, null);
	assert.equal(result.stdout, '');
	assert.deepEqual(result.stderr, '');
	assert.match(result.errors.join('\n'), /input\.d\(5\): Error: cannot implicitly convert/);
});

test('reports the program exit code', async () => {
	const result = await compiler.run(`int main()
{
    return 7;
}
`);
	assert.deepEqual(result.errors, []);
	assert.equal(result.exitCode, 7);
});

test('recovers from a compile error on the next run', async () => {
	const bad = await compiler.run('void main() { int x = "nope"; }');
	assert.equal(bad.exitCode, null);
	const good = await compiler.run(`import std.stdio;

void main()
{
    writeln("still working");
}
`);
	assert.deepEqual(good.errors, []);
	assert.equal(good.stdout, 'still working\n');
	assert.equal(good.exitCode, 0);
});

test('throws once disposed', async () => {
	const temp = await createCompiler('d');
	temp.dispose();
	await assert.rejects(() => temp.run('void main() {}'), /disposed/);
});

test('rejects an unknown language', async () => {
	await assert.rejects(() => createCompiler('cobol'), /Unknown language/);
});
