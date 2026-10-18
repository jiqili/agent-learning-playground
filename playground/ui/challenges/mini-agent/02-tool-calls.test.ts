import assert from "node:assert/strict";
import { completion, loadAgentModule, mockBackend, run, test } from "./harness.ts";

const { Agent } = await loadAgentModule();
const backendUrl = "http://playground.test/api";

const readTool = (execute: (args: Record<string, unknown>) => Promise<string>) => ({
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute,
});

const readCall = (id = "call-1", args = '{"path":"README.md"}') => completion({
	role: "assistant",
	content: null,
	tool_calls: [{ id, type: "function", function: { name: "read", arguments: args } }],
});

test("请求体中包含 OpenAI 格式的工具定义", async () => {
	const backend = mockBackend([completion({ role: "assistant", content: "ok" })]);
	await new Agent({ backendUrl, tools: [readTool(async () => "")] }).prompt("hi");

	assert.deepEqual(backend.requests[0].body.tools, [{
		type: "function",
		function: {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	}]);
});

test("执行模型请求的工具并把结果回传给模型", async () => {
	const receivedArgs: unknown[] = [];
	const backend = mockBackend([readCall(), completion({ role: "assistant", content: "The value is 42." })]);
	const agent = new Agent({
		backendUrl,
		tools: [readTool(async (args) => {
			receivedArgs.push(args);
			return "42";
		})],
	});

	const answer = await agent.prompt("Read README.md");

	assert.equal(answer.content, "The value is 42.");
	assert.deepEqual(receivedArgs, [{ path: "README.md" }], "工具应收到解析后的参数对象");
	assert.equal(backend.requests.length, 2, "执行工具后应再次请求模型");
	assert.deepEqual(backend.requests[1].body.messages.slice(-2), [
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
		},
		{ role: "tool", tool_call_id: "call-1", content: "42" },
	]);
});

test("历史中记录 toolCalls 与 toolResult 消息", async () => {
	mockBackend([readCall(), completion({ role: "assistant", content: "done" })]);
	const agent = new Agent({ backendUrl, tools: [readTool(async () => "42")] });
	await agent.prompt("Read README.md");

	const messages = [...agent.messages];
	assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.deepEqual(messages[1].toolCalls, [{ id: "call-1", name: "read", arguments: { path: "README.md" } }]);
	assert.equal(messages[2].toolCallId, "call-1");
	assert.equal(messages[2].toolName, "read");
	assert.equal(messages[2].content, "42");
	assert.equal(messages[2].isError, false);
});

test("工具抛出异常时把错误作为工具结果返回给模型", async () => {
	const backend = mockBackend([readCall(), completion({ role: "assistant", content: "The tool failed." })]);
	const agent = new Agent({
		backendUrl,
		tools: [readTool(async () => {
			throw new Error("disk full");
		})],
	});

	const answer = await agent.prompt("Read README.md");

	assert.equal(answer.content, "The tool failed.");
	assert.deepEqual(backend.requests[1].body.messages.at(-1), { role: "tool", tool_call_id: "call-1", content: "disk full" });
	const toolResult = [...agent.messages].find((message) => message.role === "toolResult");
	assert.equal(toolResult?.isError, true);
});

test("找不到工具时返回错误结果而不是中断", async () => {
	mockBackend([
		completion({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-x", type: "function", function: { name: "missing", arguments: "{}" } }],
		}),
		completion({ role: "assistant", content: "no such tool" }),
	]);
	const agent = new Agent({ backendUrl, tools: [] });

	const answer = await agent.prompt("call a missing tool");

	assert.equal(answer.content, "no such tool");
	const toolResult = [...agent.messages].find((message) => message.role === "toolResult");
	assert.equal(toolResult?.isError, true);
	assert.equal(toolResult?.toolCallId, "call-x");
});

test("超过 maxTurns 时抛出异常", async () => {
	const backend = mockBackend([readCall("call-1"), readCall("call-2"), readCall("call-3")]);
	const agent = new Agent({ backendUrl, maxTurns: 2, tools: [readTool(async () => "again")] });

	await assert.rejects(agent.prompt("loop forever"));
	assert.equal(backend.requests.length, 2, "请求模型的次数不应超过 maxTurns");
});

await run();
