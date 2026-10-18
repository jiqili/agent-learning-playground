import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { AgentTool } from "../../agent.ts";

const execFileAsync = promisify(execFile);
const pythonScript = fileURLToPath(new URL("./ddg_web_search.py", import.meta.url));
const englishPrompt = readFileSync(new URL("./ddg_web_search.prompt.en.txt", import.meta.url), "utf8").trim();

export const TOOL_SCHEMAS = [{
	type: "function",
	function: {
		name: "web_search",
		description: englishPrompt,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search keywords." },
				category: { type: "string", enum: ["text", "news"], default: "text" },
				timelimit: {
					type: "string",
					enum: ["d", "w", "m", "y"],
					description: "Published within: d=day, w=week, m=month, y=year.",
				},
				region: {
					type: "string",
					default: "wt-wt",
					description: "Region code, e.g. wt-wt (global), cn-zh, us-en, jp-jp.",
				},
				max_results: { type: "integer", default: 5, minimum: 1, maximum: 20 },
			},
			required: ["query"],
		},
	},
}] as const;

export async function callTool(
	name: string,
	arguments_: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	if (name !== "web_search") throw new Error(`unknown tool: ${name}`);
	if (signal?.aborted) throw signal.reason ?? new Error("Search aborted");

	const python = process.env.PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
	try {
		const { stdout } = await execFileAsync(python, [pythonScript, JSON.stringify(arguments_)], {
			signal,
			windowsHide: true,
			maxBuffer: 1_048_576,
			encoding: "utf8",
		});
		return stdout.trim();
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(stderr || `Python web search failed: ${message}`, { cause: error });
	}
}

export const ddgWebSearchTools: AgentTool[] = TOOL_SCHEMAS.map((schema) => ({
	name: schema.function.name,
	description: schema.function.description,
	parameters: schema.function.parameters,
	execute: (args, signal) => callTool(schema.function.name, args, signal),
}));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
