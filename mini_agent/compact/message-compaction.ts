import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "../agent.ts";
import { summarize, type CompactionOptions } from "./summarize.ts";

const MESSAGE_COMPACTION_PROMPT = readFileSync(
	new URL("./message-compaction.prompt.zh.txt", import.meta.url),
	"utf8",
).trim();

export interface MessageCompactionOptions extends CompactionOptions {
	archiveDirectory: string;
	messageThresholdCharacters: number;
}

export async function compactLongMessages(
	messages: readonly AgentMessage[],
	options: MessageCompactionOptions,
): Promise<AgentMessage[] | undefined> {
	if (!Number.isInteger(options.messageThresholdCharacters) || options.messageThresholdCharacters < 1) {
		throw new Error("messageThresholdCharacters must be a positive integer");
	}
	if (!options.archiveDirectory.trim()) {
		throw new Error("archiveDirectory must be a non-empty path");
	}

	const replacements = await Promise.all(messages.map(async (message, index) => {
		if (
			message.role === "system"
			|| message.content.length <= options.messageThresholdCharacters
			|| message.content.includes("[Full original archived at:")
		) {
			return message;
		}

		const archivePath = await archiveMessage(message, index, options.archiveDirectory);
		const summary = await summarize(
			options,
			MESSAGE_COMPACTION_PROMPT,
			`Role: ${message.role}\nArchived original: ${archivePath}\n\nOriginal message:\n${message.content}`,
		);
		return {
			...message,
			content: `${summary}\n\n[Full original archived at: \`${archivePath}\`]`,
		};
	}));

	return replacements.some((message, index) => message !== messages[index]) ? replacements : undefined;
}

async function archiveMessage(
	message: AgentMessage,
	index: number,
	archiveDirectory: string,
): Promise<string> {
	const directory = path.resolve(process.cwd(), archiveDirectory);
	await mkdir(directory, { recursive: true });
	const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${index}-${message.role}-${randomUUID()}.md`;
	const absolutePath = path.join(directory, fileName);
	const content = [
		"# Archived original message",
		"",
		`Role: ${message.role}`,
		"",
		"```json",
		JSON.stringify(message, null, 2),
		"```",
		"",
	].join("\n");
	await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
	const relativePath = path.relative(process.cwd(), absolutePath);
	return relativePath ? relativePath.split(path.sep).join("/") : absolutePath;
}
