import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { Agent } from "../agent.ts";
import { connectMcpServer, type McpConnection } from "../mcp/mcp.ts";
import { githubMcpOptions } from "../mcp/github.ts";
import { ddgWebSearchTools } from "../tools/ddg_web_search/ddg_web_search.ts";
import { readFileTool, writeFileTool } from "../tools/file/file.ts";
import { bashTool } from "../tools/bash/bash.ts";
import { discoverSkills } from "../skills.ts";

async function main(): Promise<void> {
	const key = process.env.GAODE_API_KEY?.trim();
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	const model = process.env.OPENROUTER_MODEL?.trim();
	if (!apiKey || !model) {
		throw new Error("Configure OPENROUTER_API_KEY and OPENROUTER_MODEL in mini_agent/.env");
	}

	const shutdown = new AbortController();
	let agent: Agent | undefined;
	let input: ReturnType<typeof createInterface> | undefined;
	const connections: McpConnection[] = [];
	const stop = () => {
		shutdown.abort(new Error("Stopped by user"));
		agent?.abort();
		input?.close();
	};
	process.on("SIGINT", stop);
	try {
		const skills = await discoverSkills();
		console.info(`[skills] discovered ${skills.length}: ${skills.map((skill) => skill.name).join(", ")}`);
		const tools = [readFileTool, writeFileTool, bashTool, ...ddgWebSearchTools];
		if (key) {
			const url = new URL("https://mcp.amap.com/mcp");
			url.searchParams.set("key", key);
			console.info("[mcp] connecting to Amap...");
			const connection = await connectMcpServer({
				name: "gaode",
				transport: "http",
				url,
				signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
			});
			connections.push(connection);
			tools.push(...connection.tools);
		} else {
			console.info("[mcp] Amap disabled: GAODE_API_KEY is not configured.");
		}
		if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim()) {
			console.info("[mcp] connecting to official local GitHub stdio server (read-only)...");
			const connection = await connectMcpServer(githubMcpOptions(
				AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
			));
			connections.push(connection);
			tools.push(...connection.tools);
		} else {
			console.info("[mcp] GitHub disabled: GITHUB_PERSONAL_ACCESS_TOKEN is not configured.");
		}
		try {
			console.info("[chat] File tools access the local filesystem; write_file can overwrite files.");
			console.info("[chat] Bash commands run with your local permissions, without sandboxing.");
			agent = new Agent({
				backendUrl: "https://openrouter.ai/api",
				apiKey,
				model,
				tools,
				skills,
				systemPrompt: "You are a helpful assistant with local file, web search, and optionally MCP tools. Reply in the user's language. Use the available tools as needed; do not invent tool results. Report service errors explicitly. Only write files when the user explicitly requests it.",
			});
			const question = process.argv.slice(2).join(" ").trim();
			if (question) {
				await agent.prompt(question);
				return;
			}

			input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
			input.on("SIGINT", stop);
			console.info("Enter a question; /exit quits. Conversation context is retained.");
			if (stdin.isTTY) input.setPrompt("> ");
			if (stdin.isTTY) input.prompt();
			for await (const line of input) {
				const question = line.trim();
				if (shutdown.signal.aborted || question === "/exit") break;
				if (question) await agent.prompt(question);
				if (stdin.isTTY) input.prompt();
			}
		} finally {
			input?.close();
		}
	} finally {
		try {
			const results = await Promise.allSettled(connections.map((connection) => connection.close()));
			const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
			if (errors.length) throw new AggregateError(errors, "Failed to close MCP connections");
		} finally {
			process.removeListener("SIGINT", stop);
		}
	}
}

try {
	await main();
} catch (error) {
	let message = error instanceof Error ? error.message : String(error);
	for (const key of [process.env.GAODE_API_KEY, process.env.OPENROUTER_API_KEY, process.env.GITHUB_PERSONAL_ACCESS_TOKEN]) {
		if (key?.trim()) {
			message = message.replaceAll(key.trim(), "[REDACTED]")
				.replaceAll(encodeURIComponent(key.trim()), "[REDACTED]");
		}
	}
	console.error("[chat] failed:", message);
	process.exitCode = 1;
}
