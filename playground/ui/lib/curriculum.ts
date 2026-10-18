export interface Level {
	id: string;
	title: string;
	summary: string;
	/** Lightweight markdown: paragraphs, "- " lists, `inline code` and ``` fenced blocks. */
	description: string;
	/** Test file under challenges/<chapterId>/. */
	testFile: string;
	starterCode: string;
}

export interface Chapter {
	id: string;
	title: string;
	summary: string;
	levels: Level[];
}

const agentTypes = `export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface AssistantMessage {
	role: "assistant";
	content: string;
	toolCalls?: ToolCall[];
}
`;

export const chapters: Chapter[] = [
	{
		id: "mini-agent",
		title: "Mini Agent",
		summary: "从零实现一个最小可用的 Agent：调用大模型、执行工具、暴露生命周期。",
		levels: [
			{
				id: "send-request",
				title: "发送请求给大模型",
				summary: "实现 Agent 类，通过后端代理调用大模型并维护对话历史。",
				testFile: "01-send-request.test.ts",
				description: `在本关中，你要实现并 **导出** 一个 \`Agent\` 类，它通过 Playground 的后端代理（OpenAI 兼容的 Chat Completions 接口）与大模型对话。

要求：
- \`new Agent(options)\`，\`options.backendUrl\` 为后端地址，\`options.systemPrompt\` 为可选的系统提示词。backendUrl 末尾的 \`/\` 需要去掉。
- \`agent.prompt(input)\` 向 \`\${backendUrl}/v1/chat/completions\` 发送 \`POST\` 请求，请求头包含 \`Content-Type: application/json\`。
- 请求体为 \`{ messages, stream: false }\`，\`messages\` 依次为：system 消息（如果有）、此前的历史消息、本次 user 消息，每条形如 \`{ role, content }\`。
- 从响应的 \`choices[0].message.content\` 读取回复，返回 \`{ role: "assistant", content }\`，并把 user 和 assistant 消息都追加到历史中。
- \`agent.messages\` 返回当前完整的对话历史（包含 system 消息）。
- 后端返回非 2xx 状态时抛出 \`Error\`，错误信息中需包含响应体里的 \`error\` 字段。

响应示例：
\`\`\`json
{ "choices": [{ "message": { "role": "assistant", "content": "你好！" } }] }
\`\`\`

测试会替换全局 \`fetch\`，所以请直接使用 \`fetch\` 发送请求。代码以 ES Module 运行，支持 TypeScript。`,
				starterCode: `export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface AgentOptions {
	backendUrl?: string;
	systemPrompt?: string;
}

export class Agent {
	private readonly backendUrl: string;
	private readonly history: ChatMessage[] = [];

	constructor(options: AgentOptions = {}) {
		this.backendUrl = options.backendUrl ?? "http://localhost:3000/api";
		// TODO: 去掉末尾的 "/"，并在有 systemPrompt 时写入 system 消息
	}

	get messages(): readonly ChatMessage[] {
		return this.history.slice();
	}

	async prompt(input: string): Promise<{ role: "assistant"; content: string }> {
		// TODO: 1. 追加 user 消息
		// TODO: 2. fetch(\`\${this.backendUrl}/v1/chat/completions\`, ...)
		// TODO: 3. 处理错误响应，解析 choices[0].message.content
		// TODO: 4. 追加 assistant 消息并返回
		throw new Error("Not implemented");
	}
}
`,
			},
			{
				id: "tool-calls",
				title: "让 Agent 调用工具",
				summary: "把工具描述发给模型，执行模型返回的 tool_calls，并把结果回传给模型。",
				testFile: "02-tool-calls.test.ts",
				description: `大模型本身不能读文件、跑命令，需要 Agent 帮它执行 **工具**。在上一关的基础上扩展 \`Agent\`：

要求：
- \`options.tools\` 是工具数组，每个工具形如 \`{ name, description, parameters, execute(args, signal) }\`，\`execute\` 返回 \`Promise<string>\`。
- 请求体增加 \`tools\` 字段，格式为 \`{ type: "function", function: { name, description, parameters } }\`。
- 如果模型返回的 \`message.tool_calls\` 不为空：解析每个调用的 \`function.arguments\`（JSON 字符串），执行对应工具，然后再次请求模型；直到模型不再调用工具，\`prompt\` 才返回最后的 assistant 消息。
- 返回的 assistant 消息上带有 \`toolCalls: [{ id, name, arguments }]\`（没有工具调用时可以省略）。
- 工具结果在历史中记录为 \`{ role: "toolResult", toolCallId, toolName, content, isError }\`；发送给模型时转换为 \`{ role: "tool", tool_call_id, content }\`。
- 带工具调用的 assistant 消息发送给模型时，需要包含 \`tool_calls\`（OpenAI 格式，\`arguments\` 为 JSON 字符串），\`content\` 为空时发送 \`null\`。
- 工具抛出异常或找不到工具时，不要中断 Agent：把错误信息作为 \`content\`、\`isError: true\` 返回给模型。
- \`options.maxTurns\`（默认 12）限制请求模型的最大次数，超过时 \`prompt\` 抛出异常。

模型返回的工具调用示例：
\`\`\`json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [{
    "id": "call-1",
    "type": "function",
    "function": { "name": "read", "arguments": "{\\"path\\":\\"README.md\\"}" }
  }]
}
\`\`\``,
				starterCode: `${agentTypes}
// 在上一关代码的基础上，实现工具调用循环。
export class Agent {
}
`,
			},
			{
				id: "lifecycle",
				title: "生命周期钩子",
				summary: "暴露 Agent 运行过程中的事件，并允许在执行工具前拦截。",
				testFile: "03-lifecycle.test.ts",
				description: `为了观察和控制 Agent，需要在关键节点触发 **生命周期钩子**。在上一关的基础上支持 \`options.lifecycle\`，其中每个钩子都是可选的，并且可以是异步函数（需要 \`await\`）。

钩子列表：
- \`onAgentStart()\` / \`onAgentEnd({ messages, error })\`：一次 \`prompt\` 的开始与结束（失败时也要触发 end）。
- \`onTurnStart({ turn })\` / \`onTurnEnd({ turn, assistantMessage, toolResults, error })\`：每次请求模型为一个 turn，从 1 开始计数。
- \`onMessageStart({ message, turn })\` / \`onMessageEnd({ message, turn })\`：每条消息（user、assistant、toolResult）加入历史时依次触发。
- \`beforeToolCall({ turn, assistantMessage, toolCall })\`：执行工具前触发；返回 \`{ block: true, reason }\` 时不执行工具，而是把 \`reason\` 作为错误结果（\`isError: true\`）返回给模型。
- \`afterToolCall({ turn, assistantMessage, toolCall, result })\`：工具执行完成、结果消息加入历史之前触发。

一次带一个工具调用的 \`prompt\`，事件顺序应为：
\`\`\`text
agent:start
message:user:start, message:user:end
turn:1:start
message:assistant:start, message:assistant:end
tool:before, tool:after
message:toolResult:start, message:toolResult:end
turn:1:end
turn:2:start
message:assistant:start, message:assistant:end
turn:2:end
agent:end
\`\`\``,
				starterCode: `${agentTypes}
// 在上一关代码的基础上，加入生命周期钩子。
export class Agent {
}
`,
			},
		],
	},
];

export function levelKey(chapterId: string, levelId: string): string {
	return `${chapterId}/${levelId}`;
}

export function findLevel(chapterId: string, levelId: string) {
	const chapter = chapters.find((candidate) => candidate.id === chapterId);
	const index = chapter?.levels.findIndex((candidate) => candidate.id === levelId) ?? -1;
	if (!chapter || index < 0) return undefined;
	return {
		chapter,
		level: chapter.levels[index],
		index,
		previous: index > 0 ? chapter.levels[index - 1] : undefined,
		next: chapter.levels[index + 1],
	};
}
