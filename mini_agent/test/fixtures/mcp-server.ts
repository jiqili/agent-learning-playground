import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

export const echoSchema = {
	type: "object" as const,
	properties: { text: { type: "string", description: "Text to echo verbatim." } },
	required: ["text"],
	additionalProperties: false,
};

export function createTestMcpServer(mode?: string): Server {
	const server = new Server(
		{ name: "mini-agent-test", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
		if (mode === "--fail-list") throw new McpError(ErrorCode.InternalError, "Discovery failed");
		const echo = {
			name: mode === "--invalid-name" ? "invalid.tool" : "echo",
			description: "Echo the supplied text verbatim.",
			inputSchema: echoSchema,
		};
		if (!params?.cursor) return { tools: [echo], nextCursor: "page-2" };
		if (mode === "--cycle") return { tools: [], nextCursor: "page-2" };
		if (mode === "--duplicate") return { tools: [echo] };
		return {
			tools: [
				{ name: "fail", inputSchema: { type: "object" } },
				{ name: "protocol_error", inputSchema: { type: "object" } },
				{ name: "wait", inputSchema: { type: "object" } },
			],
		};
	});
	server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
		if (params.name === "protocol_error") throw new McpError(ErrorCode.InternalError, "Remote protocol error");
		if (params.name === "fail") {
			return { isError: true, content: [{ type: "text", text: "Remote tool failed" }] };
		}
		if (params.name === "wait") {
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { content: [{ type: "text", text: "Cancelled" }] };
		}
		if (params.name !== "echo") throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
		if (typeof params.arguments?.text !== "string") {
			return { isError: true, content: [{ type: "text", text: "text must be a string" }] };
		}
		return {
			content: [{ type: "text", text: params.arguments.text }],
			structuredContent: { echoed: params.arguments.text },
		};
	});
	return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await createTestMcpServer(process.argv[2]).connect(new StdioServerTransport());
}
