# Mini Agent

## Tests

Run `npm install` once, then run unit tests with `npm test` from this directory.
MCP tests use local stdio and HTTP servers and do not require model credentials.

For real-model integration tests, configure `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL` in the local `.env` file, then run `npm run test:integration`.
The tests call OpenRouter directly; no local backend is required. Do not commit
the environment file.
The integration command uses Node.js native environment proxy support
(`--use-env-proxy`), honoring `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

## Model configuration

Pass `backendUrl`, `apiKey`, and `model` to the `Agent` constructor to call a
model provider directly. `backendUrl` is the base URL before
`/v1/chat/completions` (for OpenRouter, `https://openrouter.ai/api`).
Both normal completions and compaction requests use these options.
Without these options, the existing local proxy default remains available.

## MCP tools

`connectMcpServer` in [mcp/mcp.ts](mcp/mcp.ts) uses the official MCP SDK to
initialize a server and discover every page of `tools/list`. It returns
`AgentTool[]`; pass these alongside local tools to the existing `Agent`.
No separate model endpoint or special tool-dispatch branch is needed.

```ts
import { Agent } from "./agent.ts";
import { connectMcpServer } from "./mcp/mcp.ts";
import { readFileTool } from "./tools/file/file.ts";

const mcp = await connectMcpServer({
	name: "myserver",
	transport: "stdio",
	command: "node",
	args: ["C:\\path\\to\\mcp-server.js"],
	// Optional: cwd, env (explicit server environment), signal.
});
try {
	const agent = new Agent({ tools: [readFileTool, ...mcp.tools] });
	await agent.prompt("Use the available tools to answer my question.");
} finally {
	await mcp.close();
}
```

For a remote Streamable HTTP server, use
`{ name: "remote", transport: "http", url: "https://example.com/mcp",
headers: { Authorization: "Bearer ..." } }`. Read credentials from your
environment rather than hard-coding them. Legacy HTTP+SSE transport is not
supported.

Each remote tool becomes an individual function named
`mcp__<server-name>__<tool-name>`. Its MCP description and `inputSchema`
become the function description and `parameters` in the model's tool schema.
Use distinct server names when combining connections. Server names must contain
only letters, digits, underscores, or hyphens; the resulting function name must
use the same characters and fit within 64 characters. Invalid or duplicate names
fail discovery explicitly rather than being silently renamed.

Tool results are JSON strings preserving the MCP result, including `content`
and `structuredContent` (non-text blocks are retained as JSON, not rendered as
native model image/audio messages). MCP `isError` results and protocol failures
flow through the existing agent tool-error handling and lifecycle callbacks.
Agent cancellation is forwarded to the SDK's tool request. An optional connection
`signal` cancels initialization/discovery; failed initialization closes the client.
Keep the connection open across agent prompts and close it in `finally` when done.
Tools are a discovery-time snapshot; reconnect to pick up server tool-list changes.
Only connect to trusted servers: stdio starts a local process, and tools may have
side effects.

## Console output

Tool result logs show at most 500 characters of content, followed by a truncation
notice for longer results. Full results remain available to lifecycle callbacks
and in model context. Compaction start and completion logs show the strategy,
message counts, and context character counts (not token counts).

Per-message compaction produces a brief retrieval summary (a prompt target of
300 characters, up to 500 when needed), preserving execution and pagination
state. The archive reference is appended separately. Already archived messages
are skipped even if their summaries exceed the compaction trigger threshold.

## File reading

`read_file` accepts a 1-based `offset` (default 1) and `limit` (default and
maximum 1000). Each page contains at most 1000 complete lines or 25 KiB of
UTF-8 file content, whichever is reached first. JSON metadata is additional
to the content budget. Original line endings are preserved.
The JSON result includes `content`, `offset`, `limit`, `linesRead`,
`bytesRead`, `eof`, and `next`. Continue with `next.offset` and `next.limit`
on the same file until `next` is null. A single line exceeding 25 KiB
produces an explicit error rather than silently dropping part of the line.
