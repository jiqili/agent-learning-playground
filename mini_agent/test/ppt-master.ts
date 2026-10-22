import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Agent } from "../agent.ts";
import { discoverSkills } from "../skills.ts";
import { bashTool, redactShellOutput } from "../tools/bash/bash.ts";
import { readFileTool, writeFileTool } from "../tools/file/file.ts";

async function findDecks(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await findDecks(full));
		else if (entry.name.endsWith(".pptx") && path.basename(directory) === "exports") files.push(full);
	}
	return files;
}

async function main(): Promise<void> {
	const output = process.argv[2];
	const source = process.argv[3];
	if (!output || !source || !path.isAbsolute(output) || !path.isAbsolute(source)) {
		throw new Error("Usage: npm run test:skills:ppt -- <absolute-output-directory> <absolute-six-page-source.json>");
	}
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	const model = process.env.OPENROUTER_MODEL?.trim();
	if (!apiKey || !model) throw new Error("Configure OPENROUTER_API_KEY and OPENROUTER_MODEL in .env");
	const pack: unknown = JSON.parse(await readFile(source, "utf8"));
	if (typeof pack !== "object" || pack === null || !("pages" in pack) || !Array.isArray(pack.pages) || pack.pages.length !== 6) {
		throw new Error("Source must be a JSON content pack with exactly six pages");
	}
	await mkdir(output, { recursive: true });
	if ((await readdir(output)).length) throw new Error("Choose an empty output directory so existing decks cannot count as this run");
	const sourcePath = path.join(output, "source.json");
	await copyFile(source, sourcePath);
	const skills = await discoverSkills();
	const pptSkill = skills.find((skill) => skill.name === "ppt-master");
	if (!pptSkill) throw new Error("ppt-master is not installed");
	const startedAt = new Date().toISOString();
	const calls: { name: string; arguments: Record<string, unknown>; isError?: boolean }[] = [];
	const agent = new Agent({
		backendUrl: "https://openrouter.ai/api", apiKey, model, skills,
		tools: [readFileTool, writeFileTool, bashTool],
		maxTurns: 180,
		compaction: {
			strategy: "per-message",
			messageThresholdCharacters: 60_000,
			archiveDirectory: path.join(output, "compaction"),
		},
		systemPrompt: [
			"You are a local presentation author. Reply in Chinese and complete the authorized task end-to-end using tools.",
			"Use the skill catalog to load the matching skill. Respect user constraints over skill defaults.",
			"Never start an editor, console, preview server, confirmation UI, daemon, HTTP server, or any listening service.",
			"User delegates all design and confirmation choices. Use the skill's delegated default Generate workflow.",
			"Read required references in paginated read_file results without repeating already-read pages.",
			"Do not use multiple tools to perform the same action; wait for a tool result before retrying or switching tools.",
			"Write only inside the requested output directory. Do not edit the installed skill, agent code, sources, or credentials.",
			"Do not read .env or credentials; provider auth is already configured. No network research or image API calls are needed.",
			"Use native Windows absolute paths, quote them for Bash, and use the installed python executable rather than the Windows python3 stub.",
			"Author the six complete SVG pages yourself with write_file, never copy an existing deck or generate pages with a program.",
			"Run all required offline quality gates, repair issues, and export with the official converter. Do not claim completion before a successful export.",
			"Do not install dependencies automatically. Report any missing dependency explicitly.",
		].join("\n"),
		lifecycle: {
			beforeToolCall: ({ toolCall }) => {
				calls.push({ name: toolCall.name, arguments: toolCall.arguments });
				if (toolCall.name === "bash" && /(?:svg_editor|confirm_ui|http\.server|--daemon)/i.test(String(toolCall.arguments.command))) {
					return { block: true, reason: "The user forbids the editing console, confirmation UI, servers and daemons. Continue offline with delegated confirmation." };
				}
			},
			afterToolCall: ({ result }) => { calls[calls.length - 1]!.isError = result.isError; },
		},
	});
	const abort = () => agent.abort();
	process.on("SIGINT", abort);
	const timer = setTimeout(abort, 45 * 60_000);
	let failure: string | undefined;
	try {
		console.info(`[ppt-trial] model=${model}; skills=${skills.map((skill) => skill.name)}; console=disabled; output=${output}`);
		await agent.prompt([
			"使用 ppt-master skill 制作六页中文、16:9、可编辑的 PPT，主题为「mini-agent 是否应该支持 Skill 自动加载」。",
			`内容来源文件：${sourcePath}。先读取内容，不进行外部事实扩展。所有项目和交付物写入：${output}。`,
			"沿用六页主题：建议、历史现状、Pi 与 OpenCode、成本、风险、最小实现。",
			"这是基于前轮内容的视觉对比，不是当前代码审计。对原内容的泛化说法要加限定：",
			"1673 与 2747 是历史 GitHub 工具查询的三次平均输入 token，不是 Skill 成本测试；许可证按具体项目版本核对，不能泛化。",
			"所有设计和确认均授权你代选；自由设计，先想三个方向再选最适合技术评审的一种。",
			"不用生图，不用外部图片，使用原生文字和关系图；不要启动编辑控制台、网页确认、实时预览或任何服务器。",
			"SKILL 如果要求自动启动预览，请明确记录用户禁止并跳过，不要因为该步骤停下。",
			"需要清晰的字号层级、留白、多样布局、讲稿，并特别检查流程箭头是否穿过方框或文字。",
			"本次只做 PPT，不修改 mini-agent。完成后给出实际 PPTX 路径和未验证项目。",
		].join("\n"));
		const loaded = calls.some((call) => call.name === "read_file"
			&& typeof call.arguments.path === "string"
			&& path.resolve(call.arguments.path) === path.resolve(pptSkill.path)
			&& !call.isError);
		if (!loaded) throw new Error("The model did not load ppt-master through read_file");
		const decks = await findDecks(output);
		if (!decks.length) throw new Error("The model finished without exporting a PPTX");
		for (const deck of decks) {
			const result = await promisify(execFile)("python", ["-c",
				"import sys; from pptx import Presentation; p=Presentation(sys.argv[1]); assert len(p.slides)==6; assert abs(p.slide_width/p.slide_height-16/9)<0.001; assert all(s.has_notes_slide for s in p.slides); print('PASS: six 16:9 slides with notes')",
				deck,
			]);
			console.info(`[ppt-trial] ${deck}: ${result.stdout.trim()}`);
		}
	} catch (error) {
		failure = redactShellOutput(error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", abort);
		await writeFile(path.join(output, "run.json"), redactShellOutput(JSON.stringify({
			startedAt, finishedAt: new Date().toISOString(), model,
			consoleEnabled: false, failure, usage: agent.usage, calls, messages: agent.messages,
		}, null, 2)));
	}
}

try {
	await main();
} catch (error) {
	console.error("[ppt-trial] failed:", redactShellOutput(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
