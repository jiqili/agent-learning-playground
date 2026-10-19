import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "../agent.ts";
import { readFileTool, writeFileTool, type FileReadResult } from "../tools/file/file.ts";

const timeout = 180_000;
const backendUrl = "https://openrouter.ai/api";
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;
if (!apiKey?.trim() || !model?.trim()) {
	throw new Error("OPENROUTER_API_KEY and OPENROUTER_MODEL must be configured in mini_agent/.env");
}

test("hi", { timeout }, async (t) => {
	const agent = new Agent({
		backendUrl,
		apiKey,
		model,
		systemPrompt: "Reply briefly to the user's greeting. Do not call tools.",
		maxTurns: 1,
	});
	t.signal.addEventListener("abort", () => agent.abort(), { once: true });

	const answer = await agent.prompt("hi");

	assert.ok(answer.content.trim().length > 0, "expected a non-empty response from the local backend");
	assert.equal(answer.toolCalls?.length ?? 0, 0);
});

test("creates a txt file in the specified directory and writes a greeting", { timeout }, async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-file-integration-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, "greeting.txt");
	const content = "hi，mini agent";
	const calls: string[] = [];
	const agent = new Agent({
		backendUrl,
		apiKey,
		model,
		systemPrompt: "First call write_file with the requested path and exact content. Then call read_file on that path. After reading it, report the content without calling any more tools.",
		maxTurns: 4,
		tools: [readFileTool, writeFileTool],
		lifecycle: {
			beforeToolCall: ({ toolCall }) => {
				assert.equal(toolCall.arguments.path, filePath, "only the temporary test file may be accessed");
				if (toolCall.name === "write_file") assert.equal(toolCall.arguments.content, content);
				calls.push(toolCall.name);
			},
		},
	});
	t.signal.addEventListener("abort", () => agent.abort(), { once: true });

	const answer = await agent.prompt(
		`Create greeting.txt in the directory ${JSON.stringify(directory)} and write exactly ${JSON.stringify(content)} into it. Then read the file to verify its contents and report them.`,
	);
	const results = agent.messages.filter((message) => message.role === "toolResult");

	assert.deepEqual(calls, ["write_file", "read_file"]);
	assert.equal(results.length, 2);
	assert.ok(results.every((message) => !message.isError));
	const readResult: FileReadResult = JSON.parse(results[1]!.content);
	assert.equal(readResult.content, content);
	assert.equal(readResult.eof, true);
	assert.equal(await readFile(filePath, "utf8"), content);
	assert.equal(answer.toolCalls?.length ?? 0, 0);
	assert.ok(answer.content.includes(content));
});

for (const strategy of ["conversation", "per-message"] as const) {
test(`reads a large Apache log and compacts it before the next model request (${strategy})`, { timeout: 360_000 }, async (t) => {
	const archiveDirectory = await mkdtemp(path.join(tmpdir(), "mini-agent-log-compaction-"));
	t.after(() => rm(archiveDirectory, { recursive: true, force: true }));
	const filePath = fileURLToPath(new URL("./assets/apache_error.log", import.meta.url));
	const log = await readFile(filePath, "utf8");
	assert.ok(log.length > 20_000, "fixture must exceed the default conversation compaction threshold");
	const compactions: {
		previousMessageCount: number; nextMessageCount: number;
		previousCharacters: number; nextCharacters: number;
	}[] = [];
	const results: string[] = [];
	const originalResults: string[] = [];
	const seenSummaries = new Set<string>();
	let next: FileReadResult["next"] = { offset: 1, limit: 1000 };
	const agent: Agent = new Agent({
		backendUrl,
		apiKey,
		model,
		compaction: { strategy, archiveDirectory },
		systemPrompt: "Read the requested Apache log in pages using read_file. Follow the next offset and limit in each JSON result until eof is true. Preserve pagination progress after compaction; do not reread earlier pages. Once eof is true, summarize the main errors without calling tools again.",
		maxTurns: 12,
		tools: [readFileTool],
		lifecycle: {
			beforeToolCall: ({ toolCall }) => {
				assert.equal(toolCall.name, "read_file");
				assert.equal(toolCall.arguments.path, filePath);
				assert.ok(next, "do not read again after EOF");
				assert.equal(toolCall.arguments.offset ?? 1, next.offset);
				assert.equal(toolCall.arguments.limit ?? 1000, next.limit);
			},
			afterToolCall: ({ result }) => {
				assert.equal(result.isError, false);
				const page: FileReadResult = JSON.parse(result.content);
				assert.ok(page.linesRead <= 1000);
				assert.ok(page.bytesRead <= 25 * 1024);
				assert.equal(Buffer.byteLength(page.content), page.bytesRead);
				results.push(page.content);
				originalResults.push(result.content);
				next = page.next;
				console.info("[test] page:", {
					offset: page.offset, linesRead: page.linesRead,
					bytesRead: page.bytesRead, next: page.next,
				});
			},
			onContextCompacted: (event) => {
				compactions.push(event);
				assert.ok(event.nextCharacters < event.previousCharacters, "compaction must reduce context size");
				if (strategy === "conversation") {
					assert.equal(agent.messages.length, 1);
				} else {
					assert.equal(event.nextMessageCount, event.previousMessageCount);
					assert.equal(agent.messages[0]?.role, "system");
					const compacted = agent.messages.filter((message) => message.role === "toolResult");
					assert.equal(compacted.length, results.length);
					for (const message of compacted) {
						assert.match(message.content, /\[Full original archived at: `.+`\]$/);
						if (!seenSummaries.has(message.content)) {
							seenSummaries.add(message.content);
							const summary = message.content.replace(/\n\n\[Full original archived at: `.+`\]$/, "");
							console.info("[test] message summary:", { characters: summary.length, content: summary });
							assert.ok(summary.length <= 500, "per-message summary should stay within the requested 500 characters");
						}
					}
				}
			},
		},
	});
	t.signal.addEventListener("abort", () => agent.abort(), { once: true });

	const answer = await agent.prompt(
		`Read all of ${JSON.stringify(filePath)} using the next offset and limit returned by read_file until eof is true, then summarize its main errors. After compaction, continue from the next unread page.`,
	);

	assert.equal(results.join(""), log, "pages must cover the entire log without gaps or duplication");
	assert.equal(next, null);
	assert.ok(results.length > 1);
	assert.ok(compactions.length >= 1);
	assert.ok(compactions[0]!.previousMessageCount > 1);
	if (strategy === "conversation") {
		assert.equal(compactions[0]!.nextMessageCount, 1);
	} else {
		const files = await readdir(archiveDirectory);
		assert.equal(files.length, originalResults.length, "each page must be archived exactly once");
		assert.equal(seenSummaries.size, originalResults.length, "each archived page should have one stable summary");
		const archivedContents = await Promise.all(files.map((file) => readFile(path.join(archiveDirectory, file), "utf8")));
		for (const original of originalResults) {
			assert.ok(archivedContents.some((archive) => {
				const json = archive.match(/```json\n([\s\S]*)\n```/);
				assert.ok(json);
				return JSON.parse(json[1]!).content === original;
			}), "archive must contain the exact original tool result");
		}
		for (const message of agent.messages.filter((message) => message.role === "toolResult")) {
			const reference = message.content.match(/\[Full original archived at: `(.+)`\]$/);
			assert.ok(reference);
			assert.ok(files.includes(path.basename(reference[1]!)), "reference must point to an existing archive");
		}
		console.info("[test] archive verification:", { pages: results.length, archives: files.length, compactions: compactions.length });
	}
	assert.equal(answer.toolCalls?.length ?? 0, 0);
	assert.ok(answer.content.trim().length > 0);
});
}
