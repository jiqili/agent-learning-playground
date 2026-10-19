const DEFAULT_BACKEND_URL = "http://127.0.0.1:3001";

export interface CompactionOptions {
	backendUrl?: string;
	apiKey?: string;
	model?: string;
	signal: AbortSignal;
}

export async function summarize(
	options: CompactionOptions,
	systemPrompt: string,
	userContent: string,
): Promise<string> {
	const baseUrl = (options.backendUrl ?? DEFAULT_BACKEND_URL).replace(/\/$/, "");
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
		},
		signal: options.signal,
		body: JSON.stringify({
			...(options.model ? { model: options.model } : {}),
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
			stream: false,
		}),
	});

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		if (options.signal.aborted) throw options.signal.reason ?? error;
		throw new Error("Compaction backend returned invalid JSON", { cause: error });
	}
	if (!response.ok) {
		const backendError = isRecord(payload) ? payload.error : undefined;
		const detail = typeof backendError === "string"
			? backendError
			: isRecord(backendError) && typeof backendError.message === "string"
				? backendError.message
				: `status ${response.status}`;
		throw new Error(`Compaction request failed: ${detail}`);
	}
	if (!isRecord(payload) || !Array.isArray(payload.choices)) {
		throw new Error("Compaction backend returned an invalid chat completion response");
	}
	const firstChoice = payload.choices[0];
	if (!isRecord(firstChoice) || !isRecord(firstChoice.message) || typeof firstChoice.message.content !== "string") {
		throw new Error("Compaction backend did not return summary text");
	}
	const summary = firstChoice.message.content.trim();
	if (!summary) throw new Error("Compaction backend returned an empty summary");
	return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
