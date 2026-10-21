import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Agent, type AgentUsage } from "../../agent.ts";
import { connectMcpServer, type McpServerOptions } from "../../mcp/mcp.ts";
import { githubMcpOptions, redactGithubToken } from "../../mcp/github.ts";
import { bashTool } from "../../tools/bash/bash.ts";

const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.OPENROUTER_MODEL?.trim();
if (!token || !apiKey || !model) throw new Error("Configure GitHub PAT, OPENROUTER_API_KEY and OPENROUTER_MODEL");
const bashOnly = process.argv.includes("--bash");
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
if (flags.some((arg) => arg !== "--bash")) throw new Error("Only --bash is supported");
const local = bashOnly ? undefined : githubMcpOptions();
const variants: { label: string; options?: McpServerOptions }[] = [
	...(local ? [
	{ label: "official-stdio", options: local },
	{ label: "official-http", options: {
		name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/",
		headers: { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true", "X-MCP-Toolsets": "context,repos,issues,pull_requests" },
	} },
	] : []),
	{ label: "bash-gh" },
];
const rows: { variant: string; model: string; mcpConnected: boolean; exposedToolNames: string[]; usedTools: string[]; commands: string[]; availableTools: number; exposedTools: number; schemaCharacters: number; toolResultCharacters: number; toolCalls: number; usage: AgentUsage; answer: string }[] = [];
try {
	for (const variant of variants) {
		const connection = variant.options
			? await connectMcpServer({ ...variant.options, signal: AbortSignal.timeout(60_000) })
			: undefined;
		try {
			const mcpTools = connection?.tools.filter((tool) => tool.name === "mcp__github__list_pull_requests") ?? [];
			assert.equal(mcpTools.length, connection ? 1 : 0);
			const tools = [bashTool, ...mcpTools];
			const exposedToolNames = tools.map((tool) => tool.name);
			assert.deepEqual(exposedToolNames, connection ? ["bash", "mcp__github__list_pull_requests"] : ["bash"]);
			assert.equal(Boolean(connection), variant.options !== undefined);
			console.info(`[benchmark] ${variant.label}: MCP connected=${Boolean(connection)}; exposed tools=${exposedToolNames.join(",")}`);
			let toolCalls = 0;
			let toolResultCharacters = 0;
			const usedTools: string[] = [];
			const commands: string[] = [];
			const agent = new Agent({
				backendUrl: "https://openrouter.ai/api", apiKey, model, tools, maxTurns: 5,
				compaction: { conversationThresholdCharacters: Number.MAX_SAFE_INTEGER },
				systemPrompt: "Use the supplied tools to answer the user. For the same task, choose exactly one execution path: either a suitable MCP tool or Bash, never both at once. Do not issue multiple tool calls to accomplish or cross-check the same thing in a single response. After a successful query with sufficient information, answer immediately without duplicate queries or verification through another tool. Only retry or switch paths if the previous call failed or lacked information necessary to answer; do not repeat an identical successful call. If using Bash for GitHub queries, use the installed, environment-authenticated gh CLI, not anonymous curl. For any query, explicitly request one result and only number, title and URL fields using the tool's supported parameters. Only perform read-only queries of public information. Never read local files or credentials, install software, or modify anything. Do not invent results. Return only the requested PR number, title and URL.",
				lifecycle: {
					beforeToolCall: ({ toolCall }) => {
						usedTools.push(toolCall.name);
						if (toolCall.name === "bash") commands.push(String(toolCall.arguments.command));
					},
					afterToolCall: ({ result }) => {
						assert.equal(result.isError, false, "Benchmark tool call must succeed");
						toolCalls++;
						toolResultCharacters += result.content.length;
					},
				},
			});
			const answer = await agent.prompt("Find the most recently created open pull request in the public GitHub repository cli/cli. Fetch only one result (page 1, perPage 1, sort created descending if supported). Give its number, title and URL.");
			assert.ok(toolCalls >= 1);
			assert.match(answer.content, /https:\/\/github.com\/cli\/cli\/pull\/\d+/);
			rows.push({
				variant: variant.label, model, mcpConnected: Boolean(connection), exposedToolNames, usedTools, commands,
				availableTools: 1 + (connection?.tools.length ?? 0), exposedTools: tools.length,
				schemaCharacters: JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))).length,
				toolResultCharacters, toolCalls, usage: agent.usage, answer: answer.content,
			});
		} finally {
			await connection?.close();
		}
	}
	const output = process.argv.slice(2).find((arg) => arg !== "--bash");
	if (output) await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
	console.info("[benchmark] results", JSON.stringify(rows, null, 2));
} catch (error) {
	let message = redactGithubToken(error instanceof Error ? error.message : String(error));
	message = message.replaceAll(apiKey, "[REDACTED]");
	console.error("[benchmark] failed:", message);
	process.exitCode = 1;
}
