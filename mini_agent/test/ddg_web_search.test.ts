import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, ddgWebSearchTools, TOOL_SCHEMAS } from "../tools/ddg_web_search/ddg_web_search.ts";

test("registers one English-described web search tool", () => {
	assert.deepEqual(ddgWebSearchTools.map((tool) => tool.name), ["web_search"]);
	assert.equal(TOOL_SCHEMAS[0]?.function.name, "web_search");
	assert.match(ddgWebSearchTools[0]?.description ?? "", /DuckDuckGo/);
	assert.match(ddgWebSearchTools[0]?.description ?? "", /top three results/);
});

test("does not expose a separate page-fetch tool", async () => {
	await assert.rejects(callTool("web_fetch", {}), /unknown tool: web_fetch/);
});

test("delegates search validation to the Python implementation", async () => {
	await assert.rejects(callTool("web_search", { query: "   " }), /query must be a non-empty string/);
});
