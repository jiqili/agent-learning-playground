import assert from "node:assert/strict";
import { test } from "node:test";
import { bashTool } from "../tools/bash/bash.ts";

test("bash executes Unix pipelines, quoting, unicode and a native cwd", async () => {
	const result = JSON.parse(await bashTool.execute({
		command: "printf '%s\\n' 'hello world' '你好' | head -n 2; pwd",
		cwd: process.cwd(),
	}, new AbortController().signal));
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout, /hello world\n你好\n/);
	assert.match(result.stdout, /mini_agent|agent-learning-playground/);
});

test("bash reports failed commands and pipeline failures", async () => {
	const signal = new AbortController().signal;
	await assert.rejects(bashTool.execute({ command: "printf 'failure' >&2; exit 7" }, signal), /code 7.*\n.*failure/);
	await assert.rejects(bashTool.execute({ command: "false | cat" }, signal), /code 1/);
});

test("bash rejects invalid inputs and pre-aborted commands", async () => {
	const signal = new AbortController().signal;
	for (const args of [{ command: "" }, { command: "pwd", cwd: "relative" }, { command: "pwd", timeoutMs: 0 }]) {
		await assert.rejects(bashTool.execute(args, signal));
	}
	await assert.rejects(bashTool.execute({ command: "pwd" }, AbortSignal.abort(new Error("cancelled"))), /cancelled/);
});

test("bash terminates timed-out, cancelled and excessive-output commands", { timeout: 15_000 }, async () => {
	await assert.rejects(bashTool.execute({ command: "sleep 10", timeoutMs: 300 }, new AbortController().signal), /timed out/);
	const controller = new AbortController();
	const pending = bashTool.execute({ command: "sleep 10" }, controller.signal);
	setTimeout(() => controller.abort(), 300);
	await assert.rejects(pending, /cancelled/);
	await assert.rejects(bashTool.execute({ command: "yes x", timeoutMs: 5000 }, new AbortController().signal), /exceeded 256 KiB/);
});

test("bash redacts configured secrets from command output", async (t) => {
	const previous = process.env.TEST_API_KEY;
	process.env.TEST_API_KEY = "fake-shell-secret-for-test";
	t.after(() => {
		if (previous === undefined) delete process.env.TEST_API_KEY;
		else process.env.TEST_API_KEY = previous;
	});
	const result = await bashTool.execute({ command: "printf '%s' \"$TEST_API_KEY\"" }, new AbortController().signal);
	assert.match(result, /REDACTED/);
	assert.doesNotMatch(result, /fake-shell-secret-for-test/);
});
