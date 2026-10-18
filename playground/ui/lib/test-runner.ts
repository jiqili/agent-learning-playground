import "server-only";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./http";

export interface TestCaseResult {
	name: string;
	passed: boolean;
	error?: string;
	durationMs: number;
}

export interface TestRunResult {
	passed: boolean;
	tests: TestCaseResult[];
	/** Set when the test process itself failed (syntax error, timeout, crash). */
	error?: string;
	output: string;
	durationMs: number;
}

const RESULT_MARKER = "__ALP_RESULT__";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONCURRENT_RUNS = Math.max(1, Number.parseInt(process.env.TEST_RUNNER_CONCURRENCY ?? "2", 10) || 2);
const challengesDir = path.join(process.cwd(), "challenges");

const runningUsers = new Set<string>();
let activeRuns = 0;

/**
 * Runs a level's tests against user code in a separate Node process restricted by the
 * permission model (read-only access to its temp dir, no child processes/workers/addons,
 * empty environment). This is defense-in-depth only, not a hard security boundary:
 * production deployments should additionally isolate this in a container or VM.
 */
export async function runLevelTests(userId: string, chapterId: string, testFile: string, code: string): Promise<TestRunResult> {
	if (runningUsers.has(userId)) throw new HttpError(429, "你已有一个测试正在运行，请稍候");
	if (activeRuns >= MAX_CONCURRENT_RUNS) throw new HttpError(503, "测试服务繁忙，请稍后再试");
	runningUsers.add(userId);
	activeRuns++;

	const workDir = await mkdtemp(path.join(os.tmpdir(), "alp-run-"));
	try {
		await Promise.all([
			writeFile(path.join(workDir, "package.json"), '{"type":"module"}'),
			writeFile(path.join(workDir, "agent.ts"), code, "utf8"),
			copyFile(path.join(challengesDir, "harness.ts"), path.join(workDir, "harness.ts")),
			copyFile(path.join(challengesDir, chapterId, testFile), path.join(workDir, "level.test.ts")),
		]);
		return await execute(workDir);
	} finally {
		runningUsers.delete(userId);
		activeRuns--;
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function execute(workDir: string): Promise<TestRunResult> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [
			"--permission",
			`--allow-fs-read=${workDir}`,
			"--experimental-transform-types",
			"--disable-warning=ExperimentalWarning",
			"--max-old-space-size=128",
			"--stack-size=2048",
			"level.test.ts",
		], {
			cwd: workDir,
			env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot ?? "" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const append = (current: string, chunk: Buffer) =>
			current.length >= MAX_OUTPUT_BYTES ? current : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);

		child.on("close", (exitCode) => {
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
			const output = (markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout).trimEnd()
				+ (stderr ? `\n${stderr}` : "");

			let tests: TestCaseResult[] = [];
			if (markerIndex >= 0) {
				try {
					tests = JSON.parse(stdout.slice(markerIndex + RESULT_MARKER.length).split("\n")[0] ?? "[]") as TestCaseResult[];
				} catch {
					tests = [];
				}
			}

			let error: string | undefined;
			if (timedOut) error = `测试运行超过 ${TIMEOUT_MS / 1000} 秒，已被终止（是否存在死循环？）`;
			else if (markerIndex < 0) error = `测试进程异常退出（exit code ${exitCode ?? "unknown"}），请检查代码能否被正确加载`;

			resolve({
				passed: !error && tests.length > 0 && tests.every((test) => test.passed),
				tests,
				error,
				output: sanitizeOutput(output.trim(), workDir),
				durationMs,
			});
		});

		child.on("error", () => {
			clearTimeout(timer);
			resolve({ passed: false, tests: [], error: "无法启动测试进程", output: "", durationMs: Date.now() - startedAt });
		});
	});
}

function sanitizeOutput(output: string, workDir: string): string {
	return output
		.split(pathToFileURL(workDir).href).join(".")
		.split(workDir).join(".");
}
