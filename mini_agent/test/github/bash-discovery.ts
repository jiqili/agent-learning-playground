import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Agent } from "../../agent.ts";
import { bashTool, redactShellOutput } from "../../tools/bash/bash.ts";

try {
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	const model = process.env.OPENROUTER_MODEL?.trim();
	if (!apiKey || !model) throw new Error("Configure OPENROUTER_API_KEY and OPENROUTER_MODEL");
	const commands: string[] = [];
	const agent = new Agent({
		backendUrl: "https://openrouter.ai/api", apiKey, model, tools: [bashTool], maxTurns: 8,
		systemPrompt: "Answer in Chinese. Use the terminal to verify current public information, not memory alone. Only query public information with read-only commands. Never read local files or credentials, install software, or modify anything. Be concise and cite the repository URL. Limit command output to relevant fields. Do not invent tool results.",
		lifecycle: {
			beforeToolCall: ({ toolCall }) => {
				assert.equal(toolCall.name, "bash");
				commands.push(String(toolCall.arguments.command));
			},
		},
	});
	console.info("[discovery] MCP connected=false; exposed tools=bash; repository not preconfigured.");
	const question = "查询 pi agent 的 GitHub repo 信息。";
	const answer = await agent.prompt(question);
	assert.ok(commands.length > 0);
	assert.match(answer.content, /https:\/\/github.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
	const result = { measuredAt: new Date().toISOString(), model, question, mcpConnected: false, exposedToolNames: ["bash"], commands, usage: agent.usage, answer: answer.content };
	if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
	console.info("[discovery] result", JSON.stringify(result, null, 2));
} catch (error) {
	console.error("[discovery] failed:", redactShellOutput(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
