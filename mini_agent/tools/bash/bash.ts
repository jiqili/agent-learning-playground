import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "../../agent.ts";

export function bashExecutable(): string {
	if (process.env.BASH_PATH?.trim()) return process.env.BASH_PATH.trim();
	if (process.platform !== "win32") return "bash";
	const candidates = [
		path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
		path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
	];
	const executable = candidates.find((candidate) => existsSync(candidate));
	if (!executable) throw new Error("Git Bash not found. Install Git for Windows or set BASH_PATH to bash.exe (not WSL bash).");
	return executable;
}

export function redactShellOutput(text: string): string {
	for (const [key, value] of Object.entries(process.env)) {
		if (value && /(?:TOKEN|API_KEY|PASSWORD|SECRET)/i.test(key)) {
			text = text.replaceAll(value, "[REDACTED]").replaceAll(encodeURIComponent(value), "[REDACTED]");
		}
	}
	return text;
}

export const bashTool: AgentTool = {
	name: "bash",
	description: "Execute a Bash command locally. On Windows the executor checks for Git Bash before running commands, using BASH_PATH when configured or detecting standard Git for Windows installations. Do not use this tool to check its own shell availability. If Git Bash is missing or cannot start, report the error and ask the user to install Git for Windows or configure BASH_PATH; do not install automatically or fall back to PowerShell or WSL. Write Bash syntax, not PowerShell commands. Unix commands and pipelines are supported, but Linux-only programs may not be installed; check required utilities with command -v when uncertain. gh (GitHub CLI) uses environment authentication when configured; never print credentials. Returns JSON stdout, stderr, exitCode. Nonzero exit, timeout and excessive output are errors. Commands have full local user permissions, not a sandbox. Use only authorized operations.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute." },
			cwd: { type: "string", description: "Optional native absolute working directory path." },
			timeoutMs: { type: "integer", minimum: 1, maximum: 120000, description: "Timeout in milliseconds, default 30000." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	execute: async (args, signal) => {
		if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command must be a non-empty string");
		const command = args.command;
		if (args.cwd !== undefined && (typeof args.cwd !== "string" || !path.isAbsolute(args.cwd))) {
			throw new Error("cwd must be a native absolute path");
		}
		const timeoutMs = args.timeoutMs ?? 30_000;
		if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
			throw new Error("timeoutMs must be an integer between 1 and 120000");
		}
		signal.throwIfAborted();
		const env = { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
		if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim()) {
			Object.assign(env, { GH_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN.trim() });
		}
		return new Promise<string>((resolve, reject) => {
			const child = spawn(bashExecutable(), ["--noprofile", "--norc", "-o", "pipefail", "-c", command], {
				cwd: typeof args.cwd === "string" ? args.cwd : undefined,
				env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let bytes = 0;
			let failure: Error | undefined;
			const stop = (error: Error) => {
				if (failure) return;
				failure = error;
				if (!child.pid) return;
				if (process.platform === "win32") {
					execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], (killError) => {
						if (killError && child.exitCode === null) {
							child.kill();
							failure = new AggregateError([error, killError], "Failed to terminate Bash process tree");
						}
					});
				} else {
					try { process.kill(-child.pid, "SIGKILL"); }
					catch (killError) {
						if (child.exitCode === null) {
							child.kill();
							failure = new AggregateError([error, killError], "Failed to terminate Bash process tree");
						}
					}
				}
			};
			const collect = (chunks: Buffer[], chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 256 * 1024) stop(new Error("Bash output exceeded 256 KiB; narrow the command output"));
				else chunks.push(chunk);
			};
			child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
			child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
			const timer = setTimeout(() => stop(new Error(`Bash timed out after ${timeoutMs} ms`)), timeoutMs);
			const abort = () => stop(new Error("Bash execution cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
			child.on("error", (error) => { cleanup(); reject(new Error(redactShellOutput(error.message))); });
			child.on("close", (exitCode) => {
				cleanup();
				const result = redactShellOutput(JSON.stringify({
					stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode,
				}));
				if (failure) reject(new Error(`${redactShellOutput(failure.message)}\n${result}`));
				else if (exitCode !== 0) reject(new Error(`Bash exited with code ${exitCode}\n${result}`));
				else resolve(result);
			});
		});
	},
};
