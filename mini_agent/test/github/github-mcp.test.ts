import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { githubMcpOptions, redactGithubToken } from "../../mcp/github.ts";

function setEnv(t: TestContext, key: string, value: string): void {
	const previous = process.env[key];
	process.env[key] = value;
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
}

test("official GitHub MCP requires an explicit PAT", (t) => {
	setEnv(t, "GITHUB_PERSONAL_ACCESS_TOKEN", "");
	assert.throws(() => githubMcpOptions(), /GITHUB_PERSONAL_ACCESS_TOKEN must be configured/);
});

test("official GitHub MCP launches an executable directly with stdio and read-only toolsets", (t) => {
	setEnv(t, "GITHUB_PERSONAL_ACCESS_TOKEN", " fake-pat-for-tests ");
	setEnv(t, "GITHUB_MCP_SERVER_PATH", process.execPath);
	const signal = new AbortController().signal;
	const options = githubMcpOptions(signal);
	assert.equal(options.name, "github");
	assert.equal(options.transport, "stdio");
	assert.equal(options.command, process.execPath);
	assert.deepEqual(options.args, ["stdio", "--read-only", "--toolsets", "context,repos,issues,pull_requests"]);
	assert.equal(options.env?.GITHUB_PERSONAL_ACCESS_TOKEN, "fake-pat-for-tests");
	assert.equal(options.signal, signal);
	assert.ok(!options.args?.some((arg) => arg.includes("fake-pat")));
});

test("official GitHub MCP reports a missing binary with setup instructions", (t) => {
	setEnv(t, "GITHUB_PERSONAL_ACCESS_TOKEN", "fake-pat-for-tests");
	setEnv(t, "GITHUB_MCP_SERVER_PATH", `${process.execPath}.missing-github-mcp-server`);
	assert.throws(() => githubMcpOptions(), /npm run setup:mcp:github/);
});

test("GitHub MCP errors redact raw and URL-encoded PAT values", (t) => {
	setEnv(t, "GITHUB_PERSONAL_ACCESS_TOKEN", "test/token+secret");
	assert.equal(redactGithubToken("failed test/token+secret test%2Ftoken%2Bsecret"), "failed [REDACTED] [REDACTED]");
});
