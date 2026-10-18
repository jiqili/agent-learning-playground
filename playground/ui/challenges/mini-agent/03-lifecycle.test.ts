import assert from "node:assert/strict";
import { completion, loadAgentModule, mockBackend, run, test } from "./harness.ts";

const { Agent } = await loadAgentModule();
const backendUrl = "http://playground.test/api";

const bashTool = (execute: () => Promise<string>) => ({
	name: "bash",
	description: "Run a shell command",
	parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	execute,
});

const bashCall = () => completion({
	role: "assistant",
	content: null,
	tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
});

test("按顺序触发生命周期钩子", async () => {
	const events: string[] = [];
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
	mockBackend([bashCall(), completion({ role: "assistant", content: "done" })]);
	const agent = new Agent({
		backendUrl,
		tools: [bashTool(async () => "file.txt")],
		lifecycle: {
			onAgentStart: async () => { await tick(); events.push("agent:start"); },
			onAgentEnd: async () => { await tick(); events.push("agent:end"); },
			onTurnStart: async ({ turn }: { turn: number }) => { await tick(); events.push(`turn:${turn}:start`); },
			onTurnEnd: async ({ turn }: { turn: number }) => { await tick(); events.push(`turn:${turn}:end`); },
			onMessageStart: async ({ message }: { message: { role: string } }) => { await tick(); events.push(`message:${message.role}:start`); },
			onMessageEnd: async ({ message }: { message: { role: string } }) => { await tick(); events.push(`message:${message.role}:end`); },
			beforeToolCall: async () => { await tick(); events.push("tool:before"); },
			afterToolCall: async () => { await tick(); events.push("tool:after"); },
		},
	});

	await agent.prompt("list files");

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
});

test("钩子收到正确的参数", async () => {
	const seen: Record<string, any> = {};
	mockBackend([bashCall(), completion({ role: "assistant", content: "done" })]);
	const agent = new Agent({
		backendUrl,
		tools: [bashTool(async () => "file.txt")],
		lifecycle: {
			beforeToolCall: (event: any) => { seen.before = event; },
			afterToolCall: (event: any) => { seen.after = event; },
			onTurnEnd: (event: any) => { if (event.turn === 1) seen.turnEnd = event; },
			onAgentEnd: (event: any) => { seen.agentEnd = event; },
		},
	});

	await agent.prompt("list files");

	assert.equal(seen.before?.turn, 1);
	assert.equal(seen.before?.toolCall?.name, "bash");
	assert.deepEqual(seen.before?.toolCall?.arguments, { command: "ls" });
	assert.equal(seen.before?.assistantMessage?.role, "assistant");
	assert.equal(seen.after?.result?.role, "toolResult");
	assert.equal(seen.after?.result?.content, "file.txt");
	assert.equal(seen.turnEnd?.assistantMessage?.toolCalls?.length, 1);
	assert.equal(seen.turnEnd?.toolResults?.length, 1);
	assert.deepEqual(
		[...seen.agentEnd?.messages ?? []].map((message: { role: string }) => message.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	assert.equal(seen.agentEnd?.error, undefined);
});

test("beforeToolCall 返回 block 时不执行工具", async () => {
	let executed = false;
	const backend = mockBackend([bashCall(), completion({ role: "assistant", content: "blocked" })]);
	const agent = new Agent({
		backendUrl,
		tools: [bashTool(async () => {
			executed = true;
			return "should not run";
		})],
		lifecycle: {
			beforeToolCall: () => ({ block: true, reason: "dangerous command" }),
		},
	});

	await agent.prompt("rm -rf /");

	assert.equal(executed, false, "被拦截的工具不应被执行");
	assert.deepEqual(backend.requests[1].body.messages.at(-1), { role: "tool", tool_call_id: "call-1", content: "dangerous command" });
	const toolResult = [...agent.messages].find((message) => message.role === "toolResult");
	assert.equal(toolResult?.isError, true);
});

test("失败时也会触发 onAgentEnd 并带上 error", async () => {
	let endEvent: any;
	mockBackend([{ status: 500, body: { error: "boom" } }]);
	const agent = new Agent({
		backendUrl,
		lifecycle: { onAgentEnd: (event: any) => { endEvent = event; } },
	});

	await assert.rejects(agent.prompt("hi"));
	assert.ok(endEvent, "onAgentEnd 应被调用");
	assert.ok(endEvent.error, "onAgentEnd 应收到 error");
});

await run();
