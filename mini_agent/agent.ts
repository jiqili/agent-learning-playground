export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface SystemMessage {
	role: "system";
	content: string;
	timestamp?: number;
}

export interface UserMessage {
	role: "user";
	content: string;
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: string;
	toolCalls?: ToolCall[];
	timestamp?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

export interface ToolCallContext {
	turn: number;
	assistantMessage: AssistantMessage;
	toolCall: ToolCall;
}

export interface ToolCallOutcome extends ToolCallContext {
	result: ToolResultMessage;
}

export interface AgentLifecycle {
	onAgentStart?: () => void | Promise<void>;
	onAgentEnd?: (event: { messages: readonly AgentMessage[]; error?: unknown }) => void | Promise<void>;
	onTurnStart?: (event: { turn: number }) => void | Promise<void>;
	onTurnEnd?: (event: {
		turn: number;
		assistantMessage?: AssistantMessage;
		toolResults: readonly ToolResultMessage[];
		error?: unknown;
	}) => void | Promise<void>;
	onMessageStart?: (event: { message: AgentMessage; turn?: number }) => void | Promise<void>;
	onMessageEnd?: (event: { message: AgentMessage; turn?: number }) => void | Promise<void>;
	beforeToolCall?: (
		event: ToolCallContext,
	) => void | { block: true; reason?: string } | Promise<void | { block: true; reason?: string }>;
	afterToolCall?: (event: ToolCallOutcome) => void | Promise<void>;
	onContextCompacted?: (event: { previousMessageCount: number; nextMessageCount: number }) => void | Promise<void>;
}

export function createConsoleLifecycle(): AgentLifecycle {
	return {
		onAgentStart: () => console.info("[agent] started"),
		onAgentEnd: ({ error }) => {
			if (error) console.error("[agent] failed", error);
			else console.info("[agent] finished");
		},
		onTurnStart: ({ turn }) => console.info(`[agent] turn ${turn} started`),
		beforeToolCall: ({ toolCall }) => console.info(`[agent] tool started: ${toolCall.name}`),
		afterToolCall: ({ toolCall, result }) => {
			if (result.isError) console.warn(`[agent] tool failed: ${toolCall.name}`);
			else console.info(`[agent] tool finished: ${toolCall.name}`);
		},
	};
}

export interface AgentOptions {
	backendUrl?: string;
	tools?: AgentTool[];
	initialMessages?: AgentMessage[];
	systemPrompt?: string;
	maxTurns?: number;
	compactContext?: (
		messages: readonly AgentMessage[],
		signal: AbortSignal,
	) => Promise<AgentMessage[] | undefined>;
	lifecycle?: AgentLifecycle;
}

export class Agent {
	private transcript: AgentMessage[];
	private readonly backendUrl: string;
	private readonly tools: AgentTool[];
	private readonly maxTurns: number;
	private readonly compactContext?: AgentOptions["compactContext"];
	private readonly lifecycle: AgentLifecycle;
	private activeController?: AbortController;

	constructor(options: AgentOptions) {
		this.backendUrl = (options.backendUrl ?? "http://127.0.0.1:3001").replace(/\/$/, "");
		this.tools = options.tools?.slice() ?? [];
		this.maxTurns = options.maxTurns ?? 12;
		this.compactContext = options.compactContext;
		this.lifecycle = { ...createConsoleLifecycle(), ...options.lifecycle };
		this.transcript = options.initialMessages?.slice() ?? [];

		if (options.systemPrompt && this.transcript[0]?.role !== "system") {
			this.transcript.unshift({
				role: "system",
				content: options.systemPrompt,
				timestamp: Date.now(),
			});
		}
	}

	get messages(): readonly AgentMessage[] {
		return this.transcript.slice();
	}

	get isRunning(): boolean {
		return this.activeController !== undefined;
	}

	abort(): void {
		this.activeController?.abort();
	}

	reset(): void {
		if (this.isRunning) throw new Error("Cannot reset while the agent is running");
		this.transcript = this.transcript.filter((message) => message.role === "system");
	}

	async prompt(input: string): Promise<AssistantMessage> {
		if (this.isRunning) throw new Error("Agent is already running");

		const controller = new AbortController();
		this.activeController = controller;
		let runError: unknown;

		try {
			await this.lifecycle.onAgentStart?.();
			await this.appendMessage({ role: "user", content: input, timestamp: Date.now() });

			for (let turn = 1; turn <= this.maxTurns; turn++) {
				this.throwIfAborted(controller.signal);
				const turnResult = await this.runTurn(turn, controller.signal);
				if ((turnResult.assistantMessage.toolCalls?.length ?? 0) === 0) {
					return turnResult.assistantMessage;
				}
			}

			throw new Error(`Agent exceeded the maximum of ${this.maxTurns} turns`);
		} catch (error) {
			runError = error;
			throw error;
		} finally {
			this.activeController = undefined;
			await this.lifecycle.onAgentEnd?.({ messages: this.messages, error: runError });
		}
	}

	private async runTurn(
		turn: number,
		signal: AbortSignal,
	): Promise<{ assistantMessage: AssistantMessage; toolResults: ToolResultMessage[] }> {
		await this.lifecycle.onTurnStart?.({ turn });
		let assistantMessage: AssistantMessage | undefined;
		const toolResults: ToolResultMessage[] = [];
		let turnError: unknown;

		try {
			await this.compactTranscript(signal);
			this.throwIfAborted(signal);
			assistantMessage = await this.requestModel(signal);
			this.throwIfAborted(signal);
			if (assistantMessage.role !== "assistant") {
				throw new Error("Model must return an assistant message");
			}
			await this.appendMessage(assistantMessage, turn);

			for (const toolCall of assistantMessage.toolCalls ?? []) {
				this.throwIfAborted(signal);
				const result = await this.executeToolCall(turn, assistantMessage, toolCall, signal);
				toolResults.push(result);
				await this.appendMessage(result, turn);
			}

			return { assistantMessage, toolResults };
		} catch (error) {
			turnError = error;
			throw error;
		} finally {
			await this.lifecycle.onTurnEnd?.({
				turn,
				assistantMessage,
				toolResults,
				error: turnError,
			});
		}
	}

	private async requestModel(signal: AbortSignal): Promise<AssistantMessage> {
		const response = await fetch(`${this.backendUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal,
			body: JSON.stringify({
				messages: this.transcript.map(toApiMessage),
				tools: this.tools.map((tool) => ({
					type: "function",
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					},
				})),
				stream: false,
			}),
		});

		const payload: unknown = await response.json();
		if (!response.ok) {
			const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
				? payload.error.message
				: `Backend request failed with status ${response.status}`;
			throw new Error(message);
		}
		if (!isRecord(payload) || !Array.isArray(payload.choices)) {
			throw new Error("Backend returned an invalid chat completion response");
		}

		const firstChoice = payload.choices[0];
		if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
			throw new Error("Backend response did not contain an assistant message");
		}

		const apiMessage = firstChoice.message;
		const content = typeof apiMessage.content === "string" ? apiMessage.content : "";
		const toolCalls = Array.isArray(apiMessage.tool_calls)
			? apiMessage.tool_calls.map(parseToolCall)
			: undefined;

		return {
			role: "assistant",
			content,
			...(toolCalls?.length ? { toolCalls } : {}),
			timestamp: Date.now(),
		};
	}

	private async compactTranscript(signal: AbortSignal): Promise<void> {
		if (!this.compactContext) return;

		const previousMessageCount = this.transcript.length;
		const compacted = await this.compactContext(this.messages, signal);
		if (!compacted) return;

		this.transcript = compacted.slice();
		await this.lifecycle.onContextCompacted?.({
			previousMessageCount,
			nextMessageCount: this.transcript.length,
		});
	}

	private async executeToolCall(
		turn: number,
		assistantMessage: AssistantMessage,
		toolCall: ToolCall,
		signal: AbortSignal,
	): Promise<ToolResultMessage> {
		const context = { turn, assistantMessage, toolCall };
		let content: string;
		let isError = false;

		try {
			const decision = await this.lifecycle.beforeToolCall?.(context);
			if (decision?.block) throw new Error(decision.reason ?? "Tool execution was blocked");
			this.throwIfAborted(signal);

			const tool = this.tools.find((candidate) => candidate.name === toolCall.name);
			if (!tool) throw new Error(`Tool not found: ${toolCall.name}`);
			content = await tool.execute(toolCall.arguments, signal);
		} catch (error) {
			if (signal.aborted) throw error;
			content = error instanceof Error ? error.message : String(error);
			isError = true;
		}

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content,
			isError,
			timestamp: Date.now(),
		};
		await this.lifecycle.afterToolCall?.({ ...context, result });
		return result;
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw signal.reason ?? new Error("Agent run aborted");
	}

	private async appendMessage(message: AgentMessage, turn?: number): Promise<void> {
		this.transcript.push(message);
		await this.lifecycle.onMessageStart?.({ message, turn });
		await this.lifecycle.onMessageEnd?.({ message, turn });
	}
}

function toApiMessage(message: AgentMessage): Record<string, unknown> {
	switch (message.role) {
		case "toolResult":
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content,
			};
		case "assistant":
			return {
				role: "assistant",
				content: message.content || null,
				...(message.toolCalls?.length
					? {
						tool_calls: message.toolCalls.map((toolCall) => ({
							id: toolCall.id,
							type: "function",
							function: {
								name: toolCall.name,
								arguments: JSON.stringify(toolCall.arguments),
							},
						})),
					}
					: {}),
			};
		case "system":
		case "user":
			return { role: message.role, content: message.content };
	}
}

function parseToolCall(value: unknown): ToolCall {
	if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.function)) {
		throw new Error("Backend returned an invalid tool call");
	}
	if (typeof value.function.name !== "string" || typeof value.function.arguments !== "string") {
		throw new Error("Backend returned an invalid function call");
	}

	let args: unknown;
	try {
		args = JSON.parse(value.function.arguments);
	} catch {
		throw new Error(`Tool call ${value.function.name} returned invalid JSON arguments`);
	}
	if (!isRecord(args)) throw new Error(`Tool call ${value.function.name} arguments must be a JSON object`);
	return { id: value.id, name: value.function.name, arguments: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}