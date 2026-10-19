import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "../agent.ts";
import { connectMcpServer, type McpServerOptions } from "../mcp/mcp.ts";
import { createTestMcpServer, echoSchema } from "./fixtures/mcp-server.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
const stdioOptions: McpServerOptions = {
	name: "fixture",
	transport: "stdio",
	command: process.execPath,
	args: ["--experimental-strip-types", fixture],
};
const timeout = 15_000;

test("discovers all MCP pages and exposes input schemas and rich results as AgentTools", { timeout }, async (t) => {
	const connection = await connectMcpServer(stdioOptions);
	t.after(() => connection.close());
	assert.deepEqual(connection.tools.map((tool) => tool.name), [
		"mcp__fixture__echo", "mcp__fixture__fail", "mcp__fixture__protocol_error", "mcp__fixture__wait",
	]);
	const tool = connection.tools[0]!;
	assert.equal(tool.description, "Echo the supplied text verbatim.");
	assert.deepEqual(tool.parameters, echoSchema);
	const result = JSON.parse(await tool.execute({ text: "hello MCP" }, t.signal));
	assert.deepEqual(result.content, [{ type: "text", text: "hello MCP" }]);
	assert.deepEqual(result.structuredContent, { echoed: "hello MCP" });
	await connection.close();
	await assert.rejects(tool.execute({ text: "closed" }, t.signal), /MCP connection is closed/);
});

test("MCP tools share the model schema and lifecycle with local tools", { timeout }, async (t) => {
	const connection = await connectMcpServer(stdioOptions);
	t.after(() => connection.close());
	const requests: { tools: unknown; messages: { role: string; content: string }[] }[] = [];
	t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)));
		return Response.json({
			choices: [{
				message: requests.length === 1 ? {
					role: "assistant", content: null,
					tool_calls: [
						{ id: "echo", type: "function", function: { name: "mcp__fixture__echo", arguments: '{"text":"hello"}' } },
						{ id: "fail", type: "function", function: { name: "mcp__fixture__fail", arguments: "{}" } },
					],
				} : { role: "assistant", content: "Done" },
			}],
		});
	});
	const outcomes: boolean[] = [];
	const localTool = { name: "local", description: "Local", parameters: { type: "object" }, execute: async () => "ok" };
	const agent = new Agent({
		tools: [localTool, ...connection.tools],
		lifecycle: { afterToolCall: ({ result }) => { outcomes.push(result.isError); } },
	});
	assert.equal((await agent.prompt("Echo hello")).content, "Done");
	assert.deepEqual(requests[0]!.tools, [localTool, ...connection.tools].map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	})));
	assert.deepEqual(outcomes, [false, true]);
	const toolMessages = requests[1]!.messages.filter((message) => message.role === "tool");
	assert.equal(JSON.parse(toolMessages[0]!.content).structuredContent.echoed, "hello");
	assert.equal(JSON.parse(toolMessages[1]!.content).isError, true);
	assert.match(toolMessages[1]!.content, /Remote tool failed/);
});

test("propagates protocol errors and cancellation without closing the connection", { timeout }, async (t) => {
	const connection = await connectMcpServer(stdioOptions);
	t.after(() => connection.close());
	await assert.rejects(connection.tools[2]!.execute({}, t.signal), /Remote protocol error/);
	const controller = new AbortController();
	const pending = connection.tools[3]!.execute({}, controller.signal);
	controller.abort(new Error("Cancelled by test"));
	await assert.rejects(pending, /Cancelled by test/);
	await assert.rejects(connection.tools[0]!.execute({}, controller.signal), /Cancelled by test/);
	assert.match(await connection.tools[0]!.execute({ text: "still connected" }, t.signal), /still connected/);
});

for (const [mode, message] of [
	["--fail-list", /Discovery failed/],
	["--duplicate", /Duplicate MCP tool name/],
	["--invalid-name", /not a valid model function name/],
	["--cycle", /repeated cursor/],
] as const) {
	test(`rejects invalid discovery and cleans up the connection (${mode})`, { timeout }, async () => {
		await assert.rejects(connectMcpServer({
			...stdioOptions,
			args: ["--experimental-strip-types", fixture, mode],
		}), message);
	});
}

test("rejects invalid server names and pre-aborted connections", async () => {
	await assert.rejects(connectMcpServer({ ...stdioOptions, name: "bad.name" }), /MCP server name/);
	await assert.rejects(connectMcpServer({
		...stdioOptions, signal: AbortSignal.abort(new Error("Do not start")),
	}), /Do not start/);
});

test("connects over Streamable HTTP and forwards configured headers", { timeout }, async (t) => {
	const mcpServer = createTestMcpServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
	await mcpServer.connect(transport);
	const headers: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		const header = request.headers["x-mcp-test"];
		headers.push(Array.isArray(header) ? header.join(",") : header);
		transport.handleRequest(request, response).catch((error: unknown) => {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		});
	});
	t.after(async () => {
		await mcpServer.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const connection = await connectMcpServer({
		name: "remote", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`,
		headers: { "X-Mcp-Test": "configured" },
	});
	t.after(() => connection.close());
	assert.equal(connection.tools[0]!.name, "mcp__remote__echo");
	assert.match(await connection.tools[0]!.execute({ text: "over HTTP" }, t.signal), /over HTTP/);
	assert.ok(headers.length >= 4);
	assert.ok(headers.every((header) => header === "configured"));
	await connection.close();
});
