# Mini Agent

## Tests

Run `npm install` once, then run unit tests with `npm test` from this directory.
MCP tests use local stdio and HTTP servers and do not require model credentials.
GitHub-specific unit tests, the authenticated smoke test, and the token benchmark
are grouped under [test/github/](test/github/). Shared agent/tool tests,
the generic MCP transport test, and the manual chat runner remain in `test/`;
shared MCP fixtures and sample data remain in `test/fixtures/` and `test/assets/`.

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

## Skills

[skills.ts](skills.ts) implements Pi-style progressive disclosure. The chat
runner discovers immediate `skill/<name>/SKILL.md` directories at startup,
parses YAML frontmatter, and passes the metadata to `Agent`. Only names,
descriptions, and absolute entry paths enter the system prompt. The model reads
a matching entry with the existing paginated `read_file`, then loads supporting
references as needed and runs scripts with `bash`. There is no new tool schema,
automatic script execution, `/skill` command, or eager injection of all bodies.
The catalog survives `reset()` and conversation compaction.

```ts
import { Agent } from "./agent.ts";
import { discoverSkills } from "./skills.ts";
import { readFileTool, writeFileTool } from "./tools/file/file.ts";
import { bashTool } from "./tools/bash/bash.ts";

const agent = new Agent({
  skills: await discoverSkills(), // Or pass a native absolute directory.
  tools: [readFileTool, writeFileTool, bashTool],
  // Configure backendUrl, apiKey, model as above.
});
await agent.prompt("Use ppt-master to create a presentation.");
```

Library callers opt in by supplying `skills`; omitting it preserves the previous
behavior. Discovery is a startup snapshot: restart or rediscover to pick up new
skills. Each directory must have a regular `SKILL.md` with a lowercase
kebab-case `name` matching its directory (up to 64 characters) and a nonempty
`description` (up to 1024 characters). Folded YAML descriptions are supported.
Invalid/missing frontmatter, duplicate YAML keys, symlinks, and missing entry
files fail explicitly rather than silently disappearing. This is not a
permission or trust validator: only install reviewed skills. File and shell
tools retain full local user permissions; skills are not sandboxes or
permission grants.

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

### Official GitHub MCP (local stdio)

[mcp/github.ts](mcp/github.ts) only configures and launches the
[official GitHub MCP server](https://github.com/github/github-mcp-server).
There is no custom server, GitHub API wrapper, or locally implemented tool.
The official executable implements the tools; `connectMcpServer` discovers
their schemas and forwards calls over stdio. Neither `gh` nor Docker is required.

On Windows, install the pinned official release (v2.0.2) from this directory:

```powershell
npm run setup:mcp:github
```

[mcp/install-github.ps1](mcp/install-github.ps1) downloads the official release
for the current Windows architecture, verifies its SHA256 against the release
checksums, then extracts it under `.local/github-mcp-server/v2.0.2/` (git-ignored).
The installer does not need a PAT. To use a separately installed official binary,
set `GITHUB_MCP_SERVER_PATH` to its full executable path in `.env`.
On non-Windows systems, install the official binary for your platform and set
this path explicitly.

Add your PAT to the local `.env`:

```dotenv
GITHUB_PERSONAL_ACCESS_TOKEN=your-github-pat
```

The PAT is passed to the official process as `GITHUB_PERSONAL_ACCESS_TOKEN`,
not a command-line argument; no login or credential-store changes are needed.
The executable is started with:

```text
stdio --read-only --toolsets context,repos,issues,pull_requests
```

Read-only mode excludes write tools. Prefer a least-privilege PAT with Contents,
Issues, and Pull requests read access for selected repositories; an organization
may additionally require SSO authorization. This is a transport/implementation
replacement, not a drop-in schema replacement for the former four custom tools.
Tools and parameter schemas now come from the official server, for example
`get_me`, `get_file_contents`, `list_issues`, and `list_pull_requests`, exposed
with the `mcp__github__` prefix. The official enabled toolsets provide more than
these four tools. Do not assume the old `limit` argument or state casing applies;
use each discovered schema. Startup, authentication, and API errors propagate
through the MCP client rather than silently disabling the configured server.

Run an authenticated stdio smoke test (no model or OpenRouter key required):

```powershell
npm run test:mcp:github
```

This launches the official server as a subprocess, discovers its tools, calls
`get_me` using the real PAT, reads the README and queries issues and PRs for the
public `cli/cli` repository, checks that representative write tools are absent,
then closes the connection. The test prints a status summary, not the PAT or API
responses. Offline configuration tests are included in `npm test` and do not
require the binary, PAT, or network.

To launch the server directly:

```powershell
npm run mcp:github
```

It waits for MCP JSON-RPC messages on stdin; stdout is reserved for the MCP
protocol and logs use stderr. For other MCP clients, preferably launch the
official executable directly, passing the PAT via the client's environment
configuration (never hard-code the token):

```json
{
  "command": "C:\\path\\to\\mini_agent\\.local\\github-mcp-server\\v2.0.2\\github-mcp-server.exe",
  "args": [
    "stdio",
    "--read-only",
    "--toolsets",
    "context,repos,issues,pull_requests"
  ]
}
```

Within this project, use `connectMcpServer(githubMcpOptions())`, importing
`githubMcpOptions` from [mcp/github.ts](mcp/github.ts). The parent process must
already have loaded `.env`; the helper explicitly forwards the environment to
the stdio subprocess, including the PAT and proxy settings.
Always close the returned connection in `finally`.

#### Choosing a transport

- **stdio**: the client starts a local server process and communicates through
  stdin/stdout. Use for desktop agents, local tools, or testing subprocess
  startup/shutdown. No listening port is needed. A local server can still call
  remote APIs: this GitHub server needs network access to GitHub.
- **Streamable HTTP**: use for hosted services, multiple clients, or independently
  managed servers. Configure authentication, TLS, and server lifecycle separately.
  This is the preferred HTTP transport for new MCP integrations. The existing
  `transport: "http"` client uses it.
- **Legacy HTTP+SSE**: use only when integrating with older servers that require
  it. It uses a persistent SSE connection for server messages and a separate POST
  endpoint for client messages. It is superseded by Streamable HTTP and is not
  implemented by this client. Streamable HTTP can also carry SSE event streams;
  seeing `text/event-stream` does not necessarily mean legacy HTTP+SSE.

### Amap (Gaode) remote MCP

The [official Amap setup guide](https://lbs.amap.com/api/mcp-server/gettingstarted)
recommends Streamable HTTP at `https://mcp.amap.com/mcp`. Authentication uses
the `key` query parameter, not a Bearer header. Add your Amap key to the local
`.env` file (never commit it):

```dotenv
GAODE_API_KEY=your-amap-key
```

Node loads this file with `--env-file=.env`; existing process environment values
take precedence. No additional dotenv dependency is needed.

```ts
const key = process.env.GAODE_API_KEY?.trim();
if (!key) throw new Error("GAODE_API_KEY must be configured");
const url = new URL("https://mcp.amap.com/mcp");
url.searchParams.set("key", key);
const gaode = await connectMcpServer({
	name: "gaode",
	transport: "http",
	url,
});
try {
	const agent = new Agent({
		// Supply your backendUrl, apiKey, and model here.
		tools: gaode.tools,
	});
	await agent.prompt("Query the weather in Beijing using Amap.");
} finally {
	await gaode.close();
}
```

Do not log or share the full connection URL because it contains the key.
The key must have the service access and quota required by Amap; see the
[official key setup guide](https://lbs.amap.com/api/mcp-server/create-project-and-key).

Run only the real-model Amap integration case from this directory:

```powershell
node --use-env-proxy --env-file=.env --experimental-strip-types --test --test-name-pattern="queries Amap weather" .\test\agent.integration.test.ts
```

This test discovers the remote tools and lets the configured OpenRouter model
call `maps_weather` for Beijing (`110000`). It requires `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL`, and `GAODE_API_KEY`, and consumes model/API quota.
Without `GAODE_API_KEY`, this optional case is explicitly skipped.
Only the weather tool is exposed to the model in this case to keep the request
read-only and bounded; use `gaode.tools` to expose the full tool set.
Proxy settings apply to both OpenRouter and Amap HTTP requests.

### Interactive agent runner

Configure `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, then run:

```powershell
npm run chat
```

Enter a question and press Enter to see agent turns, tool arguments, tool result
previews, and the assistant reply. All current local tools (`read_file`,
`write_file`, `bash`, and `web_search`) are available. If `GAODE_API_KEY` is configured,
all discovered Amap MCP tools are added to the same tool list; otherwise Amap
is explicitly reported as disabled. If `GITHUB_PERSONAL_ACCESS_TOKEN` is configured,
the discovered read-only tools from the official local GitHub stdio server are also added;
otherwise GitHub is explicitly reported as disabled. A configured MCP connection failure is fatal,
not silently ignored. The runner is a common entry point, not an Amap-only test.
Continue asking questions in the same conversation; `/exit`, Ctrl+C, or end of
input closes the connection. A request failure is logged and exits the runner
with a nonzero status. Initial connection/discovery has a 30-second timeout.

For a single question, pass it as an argument:

```powershell
npm run chat -- "读取 package.json 并说明有哪些运行命令"
```

The manual runner is [test/chat.ts](test/chat.ts); it is not part of
the automated test suite. Output goes to the terminal, not a log file.
Web search requires Python and the dependencies in `requirements.txt`; the
`PYTHON` environment variable can select the interpreter. File tools access
the local filesystem without sandboxing, and `write_file` can overwrite files.
Only request operations on files you intend the agent to access.
Requests consume model and, when enabled, Amap quota and GitHub API rate limits.
GitHub results may contain private repository data accessible to your PAT;
using these tools in chat sends their results to the configured model provider.
Only query data you are authorized to share with that provider.
Logs include tool arguments and results,
so avoid entering private addresses or other information you do not want logged.

### Web search transport

The Python search and page-extraction clients explicitly share proxy and CA
settings. `DDGS_PROXY` takes precedence over standard proxy settings resolved
by Python's `urllib.request.getproxies()` (`https`, then `http`, then `all`).
DDGS uses one proxy for its search backends and extraction; this is not
per-destination `NO_PROXY` routing. Set `DDGS_PROXY` to the desired search proxy.
If your network requires a custom trusted CA bundle, set `SSL_CERT_FILE` to
its PEM file path. Certificate verification remains enabled; a proxy setting
alone does not resolve every TLS or proxy-authentication failure.

Run Python search tests from this directory:

```powershell
python -m unittest discover -s .\tools\ddg_web_search -p "test_*.py" -v
```

These tests mock external search requests and validate proxy/CA propagation,
result extraction, fallback behavior, and input validation.

## Bash terminal tool

[tools/bash/bash.ts](tools/bash/bash.ts) executes model-generated Bash commands,
not a gh-specific schema or MCP server. On Windows it uses Git for Windows'
`bin/bash.exe` (Program Files or the per-user installation); override the
executable with `BASH_PATH`. On other systems it uses `bash` from PATH.
BusyBox is not a Bash-to-PowerShell translator; Git Bash supplies a Bash shell
and common Unix utilities without rewriting command strings or requiring WSL.
Linux-only utilities are not guaranteed to exist, and this is not a Linux VM.
Use native absolute paths for the `cwd` argument; use Git Bash path syntax
inside the command string (for example `/c/Users/...`).

The `bash` tool accepts `command`, optional `cwd`, and optional `timeoutMs`
(default 30000, maximum 120000). It runs with `pipefail` and without login/profile
startup files or interactive stdin. Success returns JSON `stdout`, `stderr`,
and `exitCode`; nonzero exits, spawn errors, cancellation, timeouts, and output
exceeding 256 KiB are explicit errors. Timeout, cancellation, and overflow
terminate the process tree (Windows PID-specific taskkill; Unix process group).
This is for bounded commands, not persistent/background services.

**This is not sandboxed or a read-only executor.** Commands run with the current
user's filesystem/network permissions and inherit the environment. The local PAT,
when configured, is mapped to `GH_TOKEN` for gh; other credentials may also be
accessible. Known token/API-key/password/secret environment values are redacted
from captured output, but this is not protection against arbitrary secret
disclosure, transformed secrets, or unsafe commands. Only run trusted prompts
and use least-privilege credentials. Chat command arguments/results may be logged
and sent to the model; never ask it to print credentials.

To test repository discovery without any MCP or specialized gh tool:

```powershell
npm run test:github:bash
# Optional result JSON:
npm run test:github:bash -- C:\path\to\pi-discovery.json
```

[test/github/bash-discovery.ts](test/github/bash-discovery.ts) creates a fresh
Agent with only `bash`, asks "查询 pi agent 的 GitHub repo 信息。", and does not
provide an owner/repository or command. The model chooses commands and can
search/refine its query. The system prompt requests public, read-only operations
but does not enforce a sandbox. This opt-in real-model test consumes quota and
requires OpenRouter credentials and a working network; gh authentication uses
the existing PAT. It records commands, answer, usage, and explicit MCP/tool
isolation. This open-ended discovery task is not directly comparable to the
earlier fixed one-PR benchmark.

## Console output

Each `Agent.prompt()` prints a per-task usage summary when it finishes, fails,
or is cancelled, including input, output, total tokens, and USD cost:

```text
[agent] usage: requests=2; tokens: input=1860, output=274, total=2134; cost: $0.00073962 USD
```

Counts include all chat completion requests in that task, including conversation
and per-message compaction. They reset for the next prompt (even when conversation
history is retained). Read the same snapshot from `agent.usage` or the `usage`
field of `onAgentEnd`. The getter returns a copy.
Usage comes from backend `usage.prompt_tokens`, `completion_tokens`,
`total_tokens`, and `cost` (OpenRouter USD), not character estimates or hard-coded
model prices. Reasoning/cache details remain included as reported by the backend,
not added a second time. Backends without token or cost reporting, malformed
usage values, or requests interrupted before a response are explicitly shown as
`unknown/partial` with reporting coverage and known subtotals, not as free usage.
Only `usage.cost` is supported for cost reporting; other providers' formats
remain unknown. No additional billing API requests are made.

Tool result logs show at most 500 characters of content, followed by a truncation
notice for longer results. Full results remain available to lifecycle callbacks
and in model context. Compaction start and completion logs show the strategy,
message counts, and context character counts (not token counts).

Per-message compaction produces a brief retrieval summary (a prompt target of
300 characters, up to 500 when needed), preserving execution and pagination
state. The archive reference is appended separately. Already archived messages
are skipped even if their summaries exceed the compaction trigger threshold.

### GitHub token comparison

Run the opt-in, real-model benchmark from this directory:

```powershell
npm run benchmark:github
# Run only the Bash + gh variant (no MCP connection or official binary needed).
npm run benchmark:github -- --bash
# Optional: save the measured results as JSON.
npm run benchmark:github -- C:\path\to\results.json
```

Requires the installed official executable, `gh`, and the GitHub/OpenRouter
credentials described above. This consumes model quota and sends only public
`cli/cli` query results to the configured model. It runs one task per variant:
official local stdio + Bash, official remote Streamable HTTP + Bash (not legacy
SSE), and Bash alone. The fixed-query custom gh MCP wrapper and specialized
`run_gh` executor have been removed; they are not fair general-purpose baselines.

Bash is always exposed with exactly the same schema and description.
Each MCP variant additionally exposes the official `list_pull_requests` tool;
this remains a task-relevant subset, not a full official-toolset comparison.
The Bash-only variant exposes no MCP tools and opens no MCP connection.
Every variant asks for the newest open PR's number, title, and URL in `cli/cli`,
requesting one result. The same system prompt is used for all three variants,
without prewritten CLI commands or instructions favoring either route.
The common instructions specify authenticated gh if Bash is chosen, explicit
single-result/field selection, and allow recovery from errors; query parameters
are still generated by the model and may not always follow these instructions.
They explicitly prohibit multiple calls for the same task in one response,
duplicate successful queries, and cross-checking via both Bash and MCP.
Switching paths or retrying is allowed only after failure or insufficient
information. This is a prompt constraint, not an executor-enforced restriction.
The model chooses which available tool to call. `usedTools` records that choice;
if an MCP-enabled variant chooses Bash, it measures the overhead of having an
unused MCP tool available, not an actual MCP call. `commands` records Bash
commands for inspection. Only run these unsandboxed tools with trusted prompts.
The read-only system instruction is not a security boundary.
Assertions require successful tool calls and a PR URL in the answer. Actual
call counts are recorded rather than assuming exactly one call.
Output includes provider-reported usage/cost, schema/result character lengths
(diagnostics, not token estimates), discovered/exposed tool counts, and answer.
Compaction is disabled for this small benchmark. Local discovery does not itself
send tool schemas to the model; only the selected tool is supplied to `Agent`.
Every variant creates a fresh Agent with no inherited transcript or other chat
tools, and closes its own MCP connection before the next variant starts.
`--bash` also bypasses official binary configuration entirely. The benchmark asserts
these tool/connection boundaries and logs and records `mcpConnected` and
`exposedToolNames` so isolation can be audited. MCP tools configured in the
surrounding editor are not automatically inherited by these standalone Agents.

Important limitations: this is one run per variant, not a statistical ranking.
Earlier measurements without Bash in the MCP variants are not directly
comparable to this revised setup. The official tools support field selection
too. Costs may vary with generation length, provider
routing, and prompt caching. With identical model-facing schemas, messages, and
results, stdio versus HTTP/SSE does not change model input tokens; transport
framing is not passed into model context.

## File reading

`read_file` accepts a 1-based `offset` (default 1) and `limit` (default and
maximum 1000). Each page contains at most 1000 complete lines or 25 KiB of
UTF-8 file content, whichever is reached first. JSON metadata is additional
to the content budget. Original line endings are preserved.
The JSON result includes `content`, `offset`, `limit`, `linesRead`,
`bytesRead`, `eof`, and `next`. Continue with `next.offset` and `next.limit`
on the same file until `next` is null. A single line exceeding 25 KiB
produces an explicit error rather than silently dropping part of the line.
