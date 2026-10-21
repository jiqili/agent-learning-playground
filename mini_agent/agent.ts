import { compactConversation } from "./compact/conversation-compaction.ts";
import { compactLongMessages } from "./compact/message-compaction.ts";
import { addUsage, emptyUsage, type AgentUsage } from "./usage.ts";
export type { AgentUsage } from "./usage.ts";

function countContextCharacters(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) =>
		total + message.content.length
		+ (message.role === "assistant" ? JSON.stringify(message.toolCalls ?? []).length : 0),
	0);
}

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
	onAgentEnd?: (event: { messages: readonly AgentMessage[]; usage: AgentUsage; error?: unknown }) => void | Promise<void>;
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
	onContextCompactionStart?: (event: {
		strategy: AgentCompactionOptions["strategy"];
		previousMessageCount: number;
		previousCharacters: number;
	}) => void | Promise<void>;
	onContextCompacted?: (event: {
		previousMessageCount: number;
		nextMessageCount: number;
		previousCharacters: number;
		nextCharacters: number;
	}) => void | Promise<void>;
}

export function createConsoleLifecycle(callbacks: AgentLifecycle = {}): AgentLifecycle {
	return {
		...callbacks,
		onAgentStart: () => {
			console.info("[agent] started");
			return callbacks.onAgentStart?.();
		},
		onAgentEnd: (event) => {
			if (event.error) console.error("[agent] failed", event.error);
			else console.info("[agent] finished");
			const usage = event.usage;
			const tokens = usage.requests === usage.reportedRequests
				? `input=${usage.promptTokens}, output=${usage.completionTokens}, total=${usage.totalTokens}`
				: `unknown/partial (reported ${usage.reportedRequests}/${usage.requests}; known total=${usage.totalTokens})`;
			const cost = usage.costReportedRequests === usage.requests
				? `$${usage.costUsd.toFixed(8)} USD`
				: `unknown/partial (reported ${usage.costReportedRequests}/${usage.requests}; known=$${usage.costUsd.toFixed(8)} USD)`;
			console.info(`[agent] usage: requests=${usage.requests}; tokens: ${tokens}; cost: ${cost}`);
			return callbacks.onAgentEnd?.(event);
		},
		onTurnStart: (event) => {
			console.info(`[agent] turn ${event.turn} started`);
			return callbacks.onTurnStart?.(event);
		},
		onMessageEnd: (event) => {
			if (event.message.role === "assistant") {
				console.info("[agent] assistant message:", event.message.content);
			}
			return callbacks.onMessageEnd?.(event);
		},
		beforeToolCall: (event) => {
			console.info(`[agent] tool started: ${event.toolCall.name}`, event.toolCall.arguments);
			return callbacks.beforeToolCall?.(event);
		},
		afterToolCall: (event) => {
			const { toolCall, result } = event;
			const preview = result.content.length > 500
				? `${result.content.slice(0, 500)}\n[preview truncated; ${result.content.length} characters total; full result retained in context]`
				: result.content;
			if (result.isError) console.warn(`[agent] tool failed: ${toolCall.name}`, preview);
			else console.info(`[agent] tool finished: ${toolCall.name}`, preview);
			return callbacks.afterToolCall?.(event);
		},
		onContextCompactionStart: (event) => {
			console.info(
				`[agent] compaction started (${event.strategy}): ${event.previousMessageCount} messages, ${event.previousCharacters} characters`,
			);
			return callbacks.onContextCompactionStart?.(event);
		},
		onContextCompacted: (event) => {
			console.info(
				`[agent] compaction finished: ${event.previousMessageCount} -> ${event.nextMessageCount} messages, ${event.previousCharacters} -> ${event.nextCharacters} characters`,
			);
			return callbacks.onContextCompacted?.(event);
		},
	};
}

export interface AgentOptions {
	backendUrl?: string;
	apiKey?: string;
	model?: string;
	tools?: AgentTool[];
	initialMessages?: AgentMessage[];
	systemPrompt?: string;
	maxTurns?: number;
	compaction?: Partial<AgentCompactionOptions>;
	lifecycle?: AgentLifecycle;
}

export interface AgentCompactionOptions {
	strategy: "per-message" | "conversation";
	messageThresholdCharacters: number;
	conversationThresholdCharacters: number;
	archiveDirectory: string;
}

export class Agent {
	private transcript: AgentMessage[];
	private readonly backendUrl: string;
	private readonly apiKey?: string;
	private readonly model?: string;
	private readonly tools: AgentTool[];
	private readonly maxTurns: number;
	private readonly compaction: AgentCompactionOptions;
	private readonly lifecycle: AgentLifecycle;
	private activeController?: AbortController;
	private runUsage: AgentUsage = emptyUsage();

	get usage(): AgentUsage {
		return { ...this.runUsage };
	}

	constructor(options: AgentOptions) {
		this.backendUrl = (options.backendUrl ?? "http://127.0.0.1:3001").replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.model = options.model;
		this.tools = options.tools?.slice() ?? [];
		this.maxTurns = options.maxTurns ?? 12;
		this.compaction = {
			strategy: options.compaction?.strategy ?? "conversation",
			messageThresholdCharacters: options.compaction?.messageThresholdCharacters ?? 4_000,
			conversationThresholdCharacters: options.compaction?.conversationThresholdCharacters ?? 20_000,
			archiveDirectory: options.compaction?.archiveDirectory ?? ".agent-data/compaction",
		};
		this.lifecycle = createConsoleLifecycle(options.lifecycle);
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
		this.runUsage = emptyUsage();
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
			await this.lifecycle.onAgentEnd?.({ messages: this.messages, usage: this.usage, error: runError });
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
		const usage = this.runUsage;
		usage.requests++;
		const response = await fetch(`${this.backendUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
			},
			signal,
			body: JSON.stringify({
				...(this.model ? { model: this.model } : {}),
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
		addUsage(usage, payload);
		if (!response.ok) {
			const error = isRecord(payload) ? payload.error : undefined;
			const message = typeof error === "string"
				? error
				: isRecord(error) && typeof error.message === "string"
					? error.message
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
		const usage = this.runUsage;
		const previousMessageCount = this.transcript.length;
		const previousCharacters = countContextCharacters(this.transcript);
		const shouldCompact = this.compaction.strategy === "conversation"
			? previousCharacters > this.compaction.conversationThresholdCharacters
			: this.transcript.some((message) =>
				message.role !== "system"
				&& message.content.length > this.compaction.messageThresholdCharacters
				&& !message.content.includes("[Full original archived at:"),
			);
		if (shouldCompact) {
			await this.lifecycle.onContextCompactionStart?.({
				strategy: this.compaction.strategy,
				previousMessageCount,
				previousCharacters,
			});
		}
		const compacted = this.compaction.strategy === "conversation"
			? shouldCompact
				? await compactConversation(this.messages, {
					backendUrl: this.backendUrl,
					apiKey: this.apiKey,
					model: this.model,
					signal,
					onRequest: () => { usage.requests++; },
					onResponse: (payload) => { addUsage(usage, payload); },
				})
				: undefined
			: await compactLongMessages(this.messages, {
				backendUrl: this.backendUrl,
				apiKey: this.apiKey,
				model: this.model,
				signal,
				onRequest: () => { usage.requests++; },
				onResponse: (payload) => { addUsage(usage, payload); },
				archiveDirectory: this.compaction.archiveDirectory,
				messageThresholdCharacters: this.compaction.messageThresholdCharacters,
			});
		if (!compacted) return;

		this.transcript = compacted.slice();
		await this.lifecycle.onContextCompacted?.({
			previousMessageCount,
			nextMessageCount: this.transcript.length,
			previousCharacters,
			nextCharacters: countContextCharacters(this.transcript),
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