import assert from "node:assert/strict";
import { completion, loadAgentModule, mockBackend, run, test } from "./harness.ts";

const { Agent } = await loadAgentModule();
const backendUrl = "http://playground.test/api";

test("导出 Agent 类", () => {
	assert.equal(typeof Agent, "function", "agent.ts 需要 `export class Agent`");
});

test("向 {backendUrl}/v1/chat/completions 发送 JSON POST 请求", async () => {
	const backend = mockBackend([completion({ role: "assistant", content: "pong" })]);
	await new Agent({ backendUrl }).prompt("ping");

	assert.equal(backend.requests.length, 1, "应当只请求一次模型");
	assert.equal(backend.requests[0].url, `${backendUrl}/v1/chat/completions`);
	assert.equal(backend.requests[0].method, "POST");
	assert.match(backend.requests[0].headers.get("content-type") ?? "", /application\/json/);
});

test("去掉 backendUrl 末尾的斜杠", async () => {
	const backend = mockBackend([completion({ role: "assistant", content: "pong" })]);
	await new Agent({ backendUrl: `${backendUrl}/` }).prompt("ping");

	assert.equal(backend.requests[0].url, `${backendUrl}/v1/chat/completions`);
});

test("请求体包含 system 与 user 消息，且 stream 为 false", async () => {
	const backend = mockBackend([completion({ role: "assistant", content: "pong" })]);
	await new Agent({ backendUrl, systemPrompt: "You are helpful." }).prompt("ping");

	const body = backend.requests[0].body;
	assert.equal(body.stream, false);
	assert.deepEqual(
		body.messages.map(({ role, content }: { role: string; content: string }) => ({ role, content })),
		[
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "ping" },
		],
	);
});

test("返回大模型的回复", async () => {
	mockBackend([completion({ role: "assistant", content: "你好，我是大模型。" })]);
	const answer = await new Agent({ backendUrl }).prompt("你好");

	assert.equal(answer.role, "assistant");
	assert.equal(answer.content, "你好，我是大模型。");
});

test("多轮对话保留历史消息", async () => {
	const backend = mockBackend([
		completion({ role: "assistant", content: "记住了，你叫小明。" }),
		completion({ role: "assistant", content: "你叫小明。" }),
	]);
	const agent = new Agent({ backendUrl, systemPrompt: "Be brief." });
	await agent.prompt("我叫小明");
	await agent.prompt("我叫什么？");

	const simplify = (messages: { role: string; content: string }[]) =>
		messages.map(({ role, content }) => ({ role, content }));
	const expected = [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "我叫小明" },
		{ role: "assistant", content: "记住了，你叫小明。" },
		{ role: "user", content: "我叫什么？" },
	];
	assert.deepEqual(simplify(backend.requests[1].body.messages), expected);
	assert.deepEqual(simplify([...agent.messages]), [...expected, { role: "assistant", content: "你叫小明。" }]);
});

test("后端返回错误时抛出包含错误信息的异常", async () => {
	mockBackend([{ status: 503, body: { error: "Model proxy is not configured" } }]);
	await assert.rejects(
		new Agent({ backendUrl }).prompt("ping"),
		(error: unknown) => error instanceof Error && error.message.includes("Model proxy is not configured"),
	);
});

await run();
