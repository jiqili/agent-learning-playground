import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentMessage } from "./agent.ts";

interface CapturedRequest {
	url: string;
	body: Record<string, any>;
}

function mockBackend(responses: Record<string, unknown>[]) {
	const originalFetch = globalThis.fetch;
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, any> });
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
				function: { name: "lookup", arguments: '{"key":"x"}' },
			}],
		}),
		completion({ role: "assistant", content: "The value is 42." }),
	]);
	const agent = new Agent({
		tools: [{
			name: "lookup",
			description: "Look up a value",
			parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
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
		const answer = await agent.prompt("Find x");

		assert.equal(answer.content, "The value is 42.");
		assert.deepEqual(
			agent.messages.map((message) => message.role),
			["user", "assistant", "toolResult", "assistant"],
		);
		assert.equal(backend.requests[0]?.url, "http://127.0.0.1:3001/v1/chat/completions");
		assert.equal(backend.requests[0]?.body.stream, false);
		assert.deepEqual(backend.requests[0]?.body.tools[0].function.parameters.required, ["key"]);
		assert.deepEqual(backend.requests[1]?.body.messages.slice(-2), [
			{
				role: "assistant",
				content: null,
				tool_calls: [{
					id: "call-1",
					type: "function",
					function: { name: "lookup", arguments: '{"key":"x"}' },
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
			tool_calls: [{ id: "call-1", type: "function", function: { name: "fail", arguments: "{}" } }],
		}),
		completion({ role: "assistant", content: "The tool failed." }),
	]);
	const agent = new Agent({
		tools: [{
			name: "fail",
			description: "Always fails",
			parameters: { type: "object", properties: {} },
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

test("runs context compaction before each model request", async () => {
	let compactionCalls = 0;
	const compactedCounts: number[] = [];
	const backend = mockBackend([
		completion({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
		}),
		completion({ role: "assistant", content: "Done." }),
	]);
	const agent = new Agent({
		tools: [{
			name: "lookup",
			description: "Look up a value",
			parameters: { type: "object", properties: {} },
			execute: async () => "value",
		}],
		compactContext: async (messages) => {
			compactionCalls++;
			return messages.slice();
		},
		lifecycle: {
			onContextCompacted: ({ nextMessageCount }) => { compactedCounts.push(nextMessageCount); },
		},
	});

	try {
		await agent.prompt("Start");

		assert.equal(compactionCalls, 2);
		assert.deepEqual(compactedCounts, [1, 3]);
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
			tool_calls: [{ id: "call-1", type: "function", function: { name: "cancel", arguments: "{}" } }],
		}),
		completion({ role: "assistant", content: "This must not be requested." }),
	]);
	agent = new Agent({
		tools: [{
			name: "cancel",
			description: "Abort the current run",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				agent.abort();
				throw new Error("cancelled");
			},
		}],
	});

	try {
		const running = agent.prompt("Run cancellation test");
		await assert.rejects(running);
		assert.equal(backend.requests.length, 1);
	} finally {
		backend.restore();
	}
});

test("uses the default console lifecycle when no callbacks are supplied", async () => {
	const backend = mockBackend([completion({ role: "assistant", content: "Ready." })]);
	const originalInfo = console.info;
	const logs: string[] = [];
	console.info = (...values: unknown[]) => { logs.push(values.join(" ")); };

	try {
		await new Agent({}).prompt("Say hello");
		assert.ok(logs.includes("[agent] started"));
		assert.ok(logs.includes("[agent] turn 1 started"));
		assert.ok(logs.includes("[agent] finished"));
	} finally {
		console.info = originalInfo;
		backend.restore();
	}
});