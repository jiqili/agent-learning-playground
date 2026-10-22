import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentMessage } from "../agent.ts";
import { discoverSkills, skillCatalogPrompt } from "../skills.ts";
import { readFileTool } from "../tools/file/file.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(path.join(tmpdir(), "mini-agent-skills-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const add = async (name: string, text: string) => {
		const directory = path.join(root, name);
		await mkdir(directory);
		const file = path.join(directory, "SKILL.md");
		await writeFile(file, text);
		return file;
	};
	return { root, add };
}

test("discovers deterministic metadata with folded YAML, quoted colons and BOM/CRLF", async (t) => {
	const { root, add } = await fixture(t);
	await add("zeta", '---\nname: zeta\ndescription: >\n  Generate slides:\n  use only when asked.\nmetadata:\n  version: "1"\n---\nSECRET BODY NOT IN CATALOG');
	await add("alpha", '\uFEFF---\r\nname: alpha\r\ndescription: "Quoted: description"\r\n---\r\nOther body');
	await writeFile(path.join(root, "LICENSE"), "ignored root file");
	const skills = await discoverSkills(root);
	assert.deepEqual(skills.map((skill) => skill.name), ["alpha", "zeta"]);
	assert.equal(skills[1]!.description, "Generate slides: use only when asked.");
	assert.equal(skills[0]!.description, "Quoted: description");
	assert.ok(skills.every((skill) => path.isAbsolute(skill.path)));
	assert.doesNotMatch(skillCatalogPrompt(skills), /SECRET BODY/);
});

test("invalid or missing metadata and duplicate keys fail explicitly", async (t) => {
	for (const [name, text, pattern] of [
		["no-frontmatter", "plain text", /Missing YAML/],
		["wrong-name", "---\nname: another\ndescription: x\n---\n", /must match directory/],
		["bad-description", "---\nname: bad-description\ndescription: 123\n---\n", /description/],
		["duplicate", "---\nname: duplicate\nname: duplicate\ndescription: x\n---\n", /Invalid skill frontmatter/],
		["bad-name", "---\nname: Invalid\ndescription: x\n---\n", /Invalid skill name/],
	] as const) {
		await t.test(name, async (child) => {
			const { root, add } = await fixture(child);
			await add(name, text);
			await assert.rejects(discoverSkills(root), pattern);
		});
	}
	const { root } = await fixture(t);
	await mkdir(path.join(root, "missing"));
	await assert.rejects(discoverSkills(root), /ENOENT/);
	await assert.rejects(discoverSkills(path.join(root, "absent")), /ENOENT/);
});

test("empty catalogs add nothing; ambiguous names and relative paths are rejected", () => {
	assert.equal(skillCatalogPrompt([]), "");
	const skill = { name: "deck", description: "Slides", path: path.resolve("deck", "SKILL.md") };
	assert.throws(() => skillCatalogPrompt([skill, skill]), /Duplicate skill/);
	assert.throws(() => skillCatalogPrompt([{ ...skill, path: "relative.md" }]), /must be absolute/);
	assert.throws(() => new Agent({ skills: [skill] }), /require the read_file tool/);
});

test("model discovers the catalog and reads the full skill using the ordinary file tool", async (t) => {
	const { root, add } = await fixture(t);
	const skillPath = await add("deck", "---\nname: deck\ndescription: Make presentations\n---\nUnique body instructions");
	const skills = await discoverSkills(root);
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	let requests = 0;
	globalThis.fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		requests++;
		assert.match(body.messages[0].content, /Base instructions/);
		assert.match(body.messages[0].content, /Make presentations/);
		assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ["read_file"]);
		if (requests === 1) {
			assert.doesNotMatch(JSON.stringify(body), /Unique body instructions/);
			return Response.json({ choices: [{ message: { content: null, tool_calls: [{
				id: "load", function: { name: "read_file", arguments: JSON.stringify({ path: skillPath }) },
			}] } }] });
		}
		assert.match(body.messages.at(-1).content, /Unique body instructions/);
		return Response.json({ choices: [{ message: { content: "Loaded" } }] });
	};
	const initial: AgentMessage[] = [{ role: "system", content: "Base instructions" }];
	const agent = new Agent({ skills, tools: [readFileTool], initialMessages: initial });
	assert.equal((await agent.prompt("Make slides")).content, "Loaded");
	assert.equal(initial[0]!.content, "Base instructions", "must not mutate caller-owned messages");
	agent.reset();
	assert.equal(agent.messages.length, 1);
	assert.match(agent.messages[0]!.content, /Available skills/);
	assert.equal(requests, 2);
});

test("skill catalog survives conversation compaction without duplicating system instructions", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	let requests = 0;
	globalThis.fetch = async (_input, init) => {
		requests++;
		if (requests % 2) return Response.json({ choices: [{ message: { content: "Summary" } }] });
		const body = JSON.parse(String(init?.body));
		assert.equal(body.messages.filter((message: { role: string }) => message.role === "system").length, 1);
		assert.match(body.messages[0].content, /Available skills/);
		return Response.json({ choices: [{ message: { content: "Done" } }] });
	};
	const agent = new Agent({
		tools: [readFileTool],
		skills: [{ name: "deck", description: "Make presentations", path: path.resolve("deck", "SKILL.md") }],
		compaction: { conversationThresholdCharacters: 1 },
	});
	await agent.prompt("First");
	await agent.prompt("Second");
	assert.equal(requests, 4);
});

test("discovers an installed PPT Master package without requiring a bundled download", async (t) => {
	const { root, add } = await fixture(t);
	await add("ppt-master", "---\nname: ppt-master\ndescription: Generate editable PPTX\n---\n");
	const skills = await discoverSkills(root);
	assert.deepEqual(skills.map((skill) => skill.name), ["ppt-master"]);
	assert.match(skills[0]!.description, /editable PPTX/);
});
