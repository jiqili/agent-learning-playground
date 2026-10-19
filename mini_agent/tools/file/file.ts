import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "../../agent.ts";

export interface FileReadResult {
	content: string;
	offset: number;
	limit: number;
	linesRead: number;
	bytesRead: number;
	eof: boolean;
	next: { offset: number; limit: number } | null;
}

export const readFileTool: AgentTool = {
	name: "read_file",
	description: "Read a UTF-8 text file in pages of at most 1000 lines or 25 KB of content. offset is a 1-based line number; limit defaults to 1000. Returns JSON with content, offset, limit, linesRead, bytesRead, eof, and next. When next is not null, call read_file again on the same path with next.offset and next.limit to continue. Do not reread previous pages.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read." },
			offset: { type: "integer", minimum: 1, description: "Starting line (1-based). Defaults to 1." },
			limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum lines to read. Defaults to 1000." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	execute: async (args, signal) => {
		if (typeof args.path !== "string" || !args.path.trim()) {
			throw new Error("path must be a non-empty string");
		}
		const offset = args.offset ?? 1;
		const limit = args.limit ?? 1000;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1) {
			throw new Error("offset must be a positive safe integer");
		}
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
			throw new Error("limit must be an integer between 1 and 1000");
		}
		const text = await readFile(args.path, { encoding: "utf8", signal });
		const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		const selected: string[] = [];
		let bytesRead = 0;
		for (let index = offset - 1; index < lines.length && selected.length < limit; index++) {
			const line = lines[index]!;
			const bytes = Buffer.byteLength(line, "utf8");
			if (bytesRead + bytes > 25 * 1024) {
				if (selected.length === 0) {
					throw new Error(`Line ${offset} exceeds the 25 KB read limit; use a tool that can split or search long lines`);
				}
				break;
			}
			selected.push(line);
			bytesRead += bytes;
		}
		const eof = offset - 1 + selected.length >= lines.length;
		const result: FileReadResult = {
			content: selected.join(""),
			offset,
			limit,
			linesRead: selected.length,
			bytesRead,
			eof,
			next: eof ? null : { offset: offset + selected.length, limit },
		};
		return JSON.stringify(result);
	},
};

export const writeFileTool: AgentTool = {
	name: "write_file",
	description: "Write UTF-8 text to a file, creating it or replacing its contents.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to write." },
			content: { type: "string", description: "Complete text to write." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	execute: async (args, signal) => {
		if (typeof args.path !== "string" || !args.path.trim()) {
			throw new Error("path must be a non-empty string");
		}
		if (typeof args.content !== "string") throw new Error("content must be a string");
		await writeFile(args.path, args.content, { encoding: "utf8", signal });
		return `Wrote file: ${args.path}`;
	},
};
