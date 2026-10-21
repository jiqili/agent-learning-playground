import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServerOptions } from "./mcp.ts";

export function redactGithubToken(message: string): string {
	const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	return token ? message.replaceAll(token, "[REDACTED]")
		.replaceAll(encodeURIComponent(token), "[REDACTED]") : message;
}

export function githubMcpOptions(signal?: AbortSignal): McpServerOptions & { transport: "stdio" } {
	const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN must be configured");
	const command = process.env.GITHUB_MCP_SERVER_PATH?.trim()
		|| fileURLToPath(new URL("../.local/github-mcp-server/v2.0.2/github-mcp-server.exe", import.meta.url));
	if (!existsSync(command)) {
		throw new Error("Official GitHub MCP server not found. Run npm run setup:mcp:github or set GITHUB_MCP_SERVER_PATH to its executable path.");
	}
	return {
		name: "github",
		transport: "stdio",
		command,
		args: ["stdio", "--read-only", "--toolsets", "context,repos,issues,pull_requests"],
		env: {
			...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			GITHUB_PERSONAL_ACCESS_TOKEN: token,
		},
		signal,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const options = githubMcpOptions();
		const child = spawn(options.command, options.args, { env: options.env, stdio: "inherit" });
		child.on("error", (error) => {
			console.error("[github-mcp]", redactGithubToken(error.message));
			process.exitCode = 1;
		});
		child.on("exit", (code) => { process.exitCode = code ?? 1; });
	} catch (error) {
		console.error("[github-mcp]", redactGithubToken(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
