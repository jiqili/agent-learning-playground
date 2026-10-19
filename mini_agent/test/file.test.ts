import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readFileTool, writeFileTool, type FileReadResult } from "../tools/file/file.ts";

test("file tools write and read complete UTF-8 content", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-file-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, "content.txt");
	const signal = new AbortController().signal;
	const content = "File contents: 42\n".repeat(5_000);

	await writeFileTool.execute({ path: filePath, content }, signal);
	let offset = 1;
	const pages: string[] = [];
	do {
		const page: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath, offset }, signal));
		assert.ok(page.linesRead <= 1000);
		assert.ok(page.bytesRead <= 25 * 1024);
		assert.equal(page.offset, offset);
		assert.equal(page.limit, 1000);
		pages.push(page.content);
		if (!page.next) break;
		assert.equal(page.next.offset, offset + page.linesRead);
		offset = page.next.offset;
	} while (true);
	assert.equal(pages.length, 5);
	assert.equal(pages.join(""), content);
	assert.equal(await readFile(filePath, "utf8"), content);
	await writeFileTool.execute({ path: filePath, content: "" }, signal);
	const empty: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath }, signal));
	assert.equal(empty.content, "");
	assert.equal(empty.eof, true);
	assert.equal(empty.next, null);
});

test("file tools reject invalid arguments and propagate filesystem errors", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-file-errors-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const signal = new AbortController().signal;
	await assert.rejects(readFileTool.execute({ path: "" }, signal), /path must be a non-empty string/);
	await assert.rejects(readFileTool.execute({ path: "unused", offset: 0 }, signal), /offset/);
	await assert.rejects(readFileTool.execute({ path: "unused", limit: 1001 }, signal), /limit/);
	await assert.rejects(writeFileTool.execute({ path: 42, content: "" }, signal), /path must be a non-empty string/);
	await assert.rejects(writeFileTool.execute({ path: "unused" }, signal), /content must be a string/);
	await assert.rejects(readFileTool.execute({ path: path.join(directory, "missing.txt") }, signal), { code: "ENOENT" });
	await assert.rejects(readFileTool.execute({ path: import.meta.filename }, AbortSignal.abort()));
});

test("read_file enforces UTF-8 byte limits and preserves CRLF across pages", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-file-pages-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, "pages.txt");
	const signal = new AbortController().signal;
	const line = "\u4f60".repeat(4000) + "\r\n";
	await writeFileTool.execute({ path: filePath, content: line.repeat(3) }, signal);
	const first: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath }, signal));
	assert.equal(first.content, line.repeat(2));
	assert.equal(first.bytesRead, Buffer.byteLength(first.content));
	assert.deepEqual(first.next, { offset: 3, limit: 1000 });
	const last: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath, ...first.next }, signal));
	assert.equal(last.content, line);
	assert.equal(last.eof, true);
	const beyond: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath, offset: 10 }, signal));
	assert.equal(beyond.content, "");
	assert.equal(beyond.next, null);
	const limited: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath, limit: 1 }, signal));
	assert.equal(limited.content, line);
	assert.deepEqual(limited.next, { offset: 2, limit: 1 });
	await writeFileTool.execute({ path: filePath, content: "x".repeat(25 * 1024) }, signal);
	const exact: FileReadResult = JSON.parse(await readFileTool.execute({ path: filePath }, signal));
	assert.equal(exact.bytesRead, 25 * 1024);
	await writeFileTool.execute({ path: filePath, content: "x".repeat(25 * 1024 + 1) }, signal);
	await assert.rejects(readFileTool.execute({ path: filePath }, signal), /Line 1 exceeds the 25 KB/);
});
