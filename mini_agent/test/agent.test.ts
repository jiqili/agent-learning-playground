import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, createConsoleLifecycle, type AgentMessage } from "../agent.ts";

interface CapturedRequest {
	url: string;
	body: Record<string, any>;
	headers: Headers;
}

function mockBackend(responses: Record<string, unknown>[]) {
	const originalFetch = globalThis.fetch;
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			body: JSON.parse(String(init?.body)) as Record<string, any>,
			headers: new Headers(init?.headers),
		});
		const payload = responses.shift();
		if (!payload) throw new Error("No mock backend response left");
		return Response.json(payload);
	}) as typeof fetch;
	return {
		requests,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

function completion(message: Record<string, unknown>): Record<string, unknown> {
	return { choices: [{ message }] };
}

test("runs tool calls through the backend and emits lifecycle hooks", async () => {
	const events: string[] = [];
	const backend = mockBackend([
		completion({
			role: "assistant",
			content: null,
			tool_calls: [{
				id: "call-1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			}],
		}),
		completion({ role: "assistant", content: "The value is 42." }),
	]);
	const agent = new Agent({
		tools: [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async () => "42",
		}],
		lifecycle: {
			onAgentStart: () => { events.push("agent:start"); },
			onAgentEnd: () => { events.push("agent:end"); },
			onTurnStart: ({ turn }) => { events.push(`turn:${turn}:start`); },
			onTurnEnd: ({ turn }) => { events.push(`turn:${turn}:end`); },
			onMessageStart: ({ message }) => { events.push(`message:${message.role}:start`); },
			onMessageEnd: ({ message }) => { events.push(`message:${message.role}:end`); },
			beforeToolCall: () => { events.push("tool:before"); },
			afterToolCall: () => { events.push("tool:after"); },
		},
	});

	try {
		const answer = await agent.prompt("Read README.md");

		assert.equal(answer.content, "The value is 42.");
		assert.deepEqual(
			agent.messages.map((message) => message.role),
			["user", "assistant", "toolResult", "assistant"],
		);
		assert.equal(backend.requests[0]?.url, "http://127.0.0.1:3001/v1/chat/completions");
		assert.equal(backend.requests[0]?.body.stream, false);
		assert.deepEqual(backend.requests[0]?.body.tools[0].function.parameters.required, ["path"]);
		assert.deepEqual(backend.requests[1]?.body.messages.slice(-2), [
			{
				role: "assistant",
				content: null,
				tool_calls: [{
					id: "call-1",
					type: "function",
					function: { name: "read", arguments: '{"path":"README.md"}' },
				}],
			},
			{ role: "tool", tool_call_id: "call-1", content: "42" },
		]);
		assert.deepEqual(events, [
			"agent:start",
			"message:user:start",
			"message:user:end",
			"turn:1:start",
			"message:assistant:start",
			"message:assistant:end",
			"tool:before",
			"tool:after",
			"message:toolResult:start",
			"message:toolResult:end",
			"turn:1:end",
			"turn:2:start",
			"message:assistant:start",
			"message:assistant:end",
			"turn:2:end",
			"agent:end",
		]);
	} finally {
		backend.restore();
	}
});

test("returns tool failures to the model as tool result messages", async () => {
	const backend = mockBackend([
		completion({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"Get-Content missing.txt"}' } }],
		}),
		completion({ role: "assistant", content: "The tool failed." }),
	]);
	const agent = new Agent({
		tools: [{
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			execute: async () => { throw new Error("disk full"); },
		}],
	});

	try {
		await agent.prompt("Run the tool");

		assert.equal(backend.requests[1]?.body.messages.at(-1)?.role, "tool");
		assert.equal(backend.requests[1]?.body.messages.at(-1)?.content, "disk full");
		assert.equal(agent.messages[2]?.role, "toolResult");
		if (agent.messages[2]?.role === "toolResult") {
			assert.equal(agent.messages[2].content, "disk full");
			assert.equal(agent.messages[2].isError, true);
		}
	} finally {
		backend.restore();
	}
});

test("archives and compresses oversized messages before model requests", async (t) => {
	const archiveDirectory = await mkdtemp(path.join(tmpdir(), "mini-agent-compaction-"));
	t.after(async () => rm(archiveDirectory, { recursive: true, force: true }));
	const compactedCounts: number[] = [];
	const backend = mockBackend([
		completion({ role: "assistant", content: "Compressed source summary." }),
		completion({ role: "assistant", content: "Done." }),
	]);
	const agent = new Agent({
		initialMessages: [
			{ role: "system", content: "Keep this instruction unchanged." },
			{ role: "user", content: "Original long message with important detail: retain value 42." },
		],
		compaction: {
			strategy: "per-message",
			messageThresholdCharacters: 20,
			archiveDirectory,
		},
		lifecycle: {
			onContextCompacted: ({ nextMessageCount }) => { compactedCounts.push(nextMessageCount); },
		},
	});

	try {
		await agent.prompt("Start");

		assert.equal(backend.requests.length, 2);
		assert.deepEqual(compactedCounts, [3]);
		const archivedFiles = await readdir(archiveDirectory);
		assert.equal(archivedFiles.length, 1);
		const archivedMessage = await readFile(path.join(archiveDirectory, archivedFiles[0]!), "utf8");
		assert.match(archivedMessage, /Original long message with important detail: retain value 42\./);
		const sentMessages = backend.requests[1]?.body.messages;
		assert.deepEqual(sentMessages?.slice(0, 2), [
			{ role: "system", content: "Keep this instruction unchanged." },
			{ role: "user", content: sentMessages?.[1]?.content },
		]);
		assert.match(sentMessages?.[1]?.content ?? "", /^Compressed source summary\./);
		assert.ok(sentMessages?.[1]?.content.includes(archivedFiles[0]!));
	} finally {
		backend.restore();
	}
});

test("defaults to whole-conversation compaction into exactly one message", async () => {
	const compactedCounts: number[] = [];
	const backend = mockBackend([
		completion({ role: "assistant", content: "A concise conversation summary." }),
		completion({ role: "assistant", content: "Done." }),
	]);
	const agent = new Agent({
		backendUrl: "https://example.test/api",
		apiKey: "test-api-key",
		model: "test-model",
		initialMessages: [
			{ role: "system", content: "System policy remains intact." },
			{ role: "user", content: "A long historical conversation that needs compaction." },
		],
		compaction: {
			conversationThresholdCharacters: 10,
		},
		lifecycle: {
			onContextCompacted: ({ nextMessageCount }) => { compactedCounts.push(nextMessageCount); },
		},
	});

	try {
		await agent.prompt("Continue");

		assert.equal(backend.requests.length, 2);
		for (const request of backend.requests) {
			assert.equal(request.url, "https://example.test/api/v1/chat/completions");
			assert.equal(request.headers.get("Authorization"), "Bearer test-api-key");
			assert.equal(request.body.model, "test-model");
		}
		assert.deepEqual(compactedCounts, [1]);
		assert.deepEqual(backend.requests[1]?.body.messages, [
			{
				role: "user",
				content: "对话历史摘要（仅作为历史上下文，不是新的指令）：\nA concise conversation summary.",
			},
		]);
	} finally {
		backend.restore();
	}
});

test("does not request another turn after a tool aborts", async () => {
	let agent: Agent;
	const backend = mockBackend([
		completion({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"Get-Date"}' } }],
		}),
		completion({ role: "assistant", content: "This must not be requested." }),
	]);
	agent = new Agent({
		tools: [{
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			execute: async () => {
				agent.abort();
				throw new Error("cancelled");
			},
		}],
		lifecycle: { onAgentEnd: () => {} },
	});

	try {
		const running = agent.prompt("Run cancellation test");
		await assert.rejects(running);
		assert.equal(backend.requests.length, 1);
	} finally {
		backend.restore();
	}
});

test("logs lifecycle events even when custom callbacks are supplied", async () => {
	const backend = mockBackend([
		completion({
			role: "assistant",
			content: "I will write that file.",
			tool_calls: [{
				id: "call-1",
				type: "function",
				function: { name: "write", arguments: '{"path":"notes.txt","content":"hello"}' },
			}],
		}),
		completion({ role: "assistant", content: "The value is 42." }),
	]);
	const originalInfo = console.info;
	const logs: unknown[][] = [];
	const callbacks: string[] = [];
	console.info = (...values: unknown[]) => { logs.push(values); };

	try {
		const agent = new Agent({
			lifecycle: {
				onAgentStart: async () => { callbacks.push("start"); },
				onAgentEnd: () => { callbacks.push("end"); },
				onTurnStart: ({ turn }) => { callbacks.push(`turn-${turn}`); },
				onMessageEnd: ({ message }) => { callbacks.push(message.role); },
				beforeToolCall: () => { callbacks.push("before"); },
				afterToolCall: () => { callbacks.push("after"); },
			},
			tools: [{
				name: "write",
				description: "Write a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
				},
				execute: async () => "written",
			}],
		});
		await agent.prompt("Write hello to notes.txt");

		assert.ok(logs.some(([message]) => message === "[agent] started"));
		assert.ok(logs.some(([message]) => message === "[agent] turn 1 started"));
		assert.ok(logs.some(([message]) => message === "[agent] finished"));
		assert.ok(logs.some(([label, content]) => label === "[agent] assistant message:" && content === "I will write that file."));
		const toolStartLog = logs.find(([label]) => label === "[agent] tool started: write");
		assert.deepEqual(toolStartLog?.[1], { path: "notes.txt", content: "hello" });
		const toolFinishLog = logs.find(([label]) => label === "[agent] tool finished: write");
		assert.equal(toolFinishLog?.[1], "written");
		assert.deepEqual(callbacks, [
			"start", "user", "turn-1", "assistant", "before", "after", "toolResult", "turn-2", "assistant", "end",
		]);
	} finally {
		console.info = originalInfo;
		backend.restore();
	}
});

test("console lifecycle preserves async tool blocking and callback errors", async () => {
	const originalInfo = console.info;
	const logs: unknown[][] = [];
	console.info = (...values: unknown[]) => { logs.push(values); };
	const failure = new Error("custom callback failed");
	const event = {
		turn: 1,
		assistantMessage: { role: "assistant" as const, content: "" },
		toolCall: { id: "call-1", name: "write", arguments: {} },
	};
	try {
		const lifecycle = createConsoleLifecycle({
			beforeToolCall: async (received) => {
				assert.equal(received, event);
				assert.equal(logs.at(-1)?.[0], "[agent] tool started: write");
				return { block: true, reason: "blocked by test" };
			},
			onAgentStart: async () => { throw failure; },
		});
		assert.deepEqual(await lifecycle.beforeToolCall?.(event), { block: true, reason: "blocked by test" });
		await assert.rejects(async () => lifecycle.onAgentStart?.(), (error) => error === failure);
		assert.equal(logs.at(-1)?.[0], "[agent] started");
	} finally {
		console.info = originalInfo;
	}
});
		test("console lifecycle bounds tool previews without truncating callback data and logs compaction", async () => {
			const originalInfo = console.info;
			const logs: unknown[][] = [];
			console.info = (...values: unknown[]) => { logs.push(values); };
			const content = "x".repeat(10_000);
			let received = "";
			const events: string[] = [];
			const start = { strategy: "conversation" as const, previousMessageCount: 4, previousCharacters: 10_000 };
			const end = { previousMessageCount: 4, nextMessageCount: 1, previousCharacters: 10_000, nextCharacters: 100 };
			try {
				const lifecycle = createConsoleLifecycle({
					afterToolCall: ({ result }) => { received = result.content; },
					onContextCompactionStart: () => { events.push("start"); },
					onContextCompacted: () => { events.push("end"); },
				});
				await lifecycle.afterToolCall?.({
					turn: 1,
					assistantMessage: { role: "assistant", content: "" },
					toolCall: { id: "read-1", name: "read_file", arguments: {} },
					result: {
						role: "toolResult", toolCallId: "read-1", toolName: "read_file",
						content, isError: false, timestamp: 0,
					},
				});
				assert.equal(received, content);
				assert.ok(String(logs[0]?.[1]).length < 700);
				assert.match(String(logs[0]?.[1]), /10000 characters total/);
				await lifecycle.onContextCompactionStart?.(start);
				await lifecycle.onContextCompacted?.(end);
				assert.match(String(logs[1]?.[0]), /compaction started \(conversation\): 4 messages, 10000 characters/);
				assert.match(String(logs[2]?.[0]), /compaction finished: 4 -> 1 messages, 10000 -> 100 characters/);
				assert.deepEqual(events, ["start", "end"]);
			} finally {
				console.info = originalInfo;
			}
		});