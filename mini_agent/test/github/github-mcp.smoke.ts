import assert from "node:assert/strict";
import { connectMcpServer } from "../../mcp/mcp.ts";
import { githubMcpOptions, redactGithubToken } from "../../mcp/github.ts";

try {
	const signal = AbortSignal.timeout(60_000);
	const connection = await connectMcpServer(githubMcpOptions(signal));
	try {
		async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
			const tool = connection.tools.find((tool) => tool.name === `mcp__github__${name}`);
			assert.ok(tool, `Official server must expose ${name}`);
			const result = JSON.parse(await tool.execute(args, signal));
			assert.ok(result.content.length > 0, `${name} must return content`);
			return result;
		}
		const result = await call("get_me", {});
		assert.ok(result && typeof result === "object" && "content" in result);
		const repository = { owner: "cli", repo: "cli" };
		await call("get_file_contents", { ...repository, path: "README.md" });
		await call("list_issues", { ...repository, state: "OPEN", perPage: 1 });
		await call("list_pull_requests", { ...repository, state: "open", perPage: 1 });
		assert.ok(!connection.tools.some((tool) => /__(create_issue|create_pull_request|push_files|delete_file)$/.test(tool.name)));
		console.info(`[github-mcp] official stdio server: discovered ${connection.tools.length} tools; get_me, file, issue and PR queries passed (public repository cli/cli).`);
	} finally {
		await connection.close();
	}
} catch (error) {
	console.error("[github-mcp] smoke failed:", redactGithubToken(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
