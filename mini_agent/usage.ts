export interface AgentUsage {
	requests: number;
	reportedRequests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	costUsd: number;
	costReportedRequests: number;
}

export function emptyUsage(): AgentUsage {
	return { requests: 0, reportedRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, costReportedRequests: 0 };
}

export function addUsage(total: AgentUsage, payload: unknown): void {
	if (!isRecord(payload) || !isRecord(payload.usage)) return;
	const usage = payload.usage;
	if (isCount(usage.prompt_tokens) && isCount(usage.completion_tokens) && isCount(usage.total_tokens)) {
		total.reportedRequests++;
		total.promptTokens += usage.prompt_tokens;
		total.completionTokens += usage.completion_tokens;
		total.totalTokens += usage.total_tokens;
	}
	if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
		total.costUsd += usage.cost;
		total.costReportedRequests++;
	}
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
