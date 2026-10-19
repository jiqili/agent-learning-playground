import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "../agent.ts";

export type McpServerOptions = {
	name: string;
	signal?: AbortSignal;
} & (
	| ({ transport: "stdio" } & StdioServerParameters)
	| { transport: "http"; url: string | URL; headers?: Record<string, string> }
);

export interface McpConnection {
	tools: AgentTool[];
	close: () => Promise<void>;
}

export async function connectMcpServer(options: McpServerOptions): Promise<McpConnection> {
	if (!/^[a-zA-Z0-9_-]+$/.test(options.name)) {
		throw new Error("MCP server name must contain only letters, digits, underscores, or hyphens");
	}
	options.signal?.throwIfAborted();
	const transport = options.transport === "stdio"
		? new StdioClientTransport(options)
		: new StreamableHTTPClientTransport(new URL(options.url), {
			requestInit: { headers: options.headers },
		});
	const client = new Client({ name: "mini-agent", version: "1.0.0" });
	let closed = false;
	client.onclose = () => { closed = true; };

	try {
		await client.connect(transport, { signal: options.signal });
		const tools: AgentTool[] = [];
		const names = new Set<string>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await client.listTools({ cursor }, { signal: options.signal });
			for (const tool of page.tools) {
				const name = `mcp__${options.name}__${tool.name}`;
				if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
					throw new Error(`MCP tool name is not a valid model function name (maximum 64 characters): ${name}`);
				}
				if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
				names.add(name);
				tools.push({
					name,
					description: tool.description ?? `Call ${tool.name} on MCP server ${options.name}.`,
					parameters: tool.inputSchema,
					execute: async (args, signal) => {
						signal.throwIfAborted();
						if (closed) throw new Error(`MCP connection is closed: ${options.name}`);
						const result = await client.callTool(
							{ name: tool.name, arguments: args },
							undefined,
							{ signal },
						);
						const content = JSON.stringify(result);
						if (result.isError) throw new Error(content);
						return content;
					},
				});
			}
			cursor = page.nextCursor;
			if (cursor !== undefined) {
				if (cursors.has(cursor)) throw new Error(`MCP tools/list returned a repeated cursor: ${cursor}`);
				cursors.add(cursor);
			}
		} while (cursor !== undefined);

		return { tools, close: () => client.close() };
	} catch (error) {
		try {
			await client.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], `Failed to initialize and close MCP server ${options.name}`);
		}
		throw error;
	}
}
