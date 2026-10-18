import { getCurrentUser } from "@/lib/auth";
import { HttpError, isRecord, isSameOrigin, jsonError, readJsonBody } from "@/lib/http";

const upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";

export async function POST(request: Request) {
	if (!isSameOrigin(request)) return jsonError(403, "Cross-origin requests are not allowed");
	if (!(await getCurrentUser())) return jsonError(401, "Login required");

	const apiKey = process.env.OPENROUTER_API_KEY;
	const model = process.env.OPENROUTER_MODEL;
	if (!apiKey || !model) return jsonError(503, "Model proxy is not configured");

	let body: unknown;
	try {
		body = await readJsonBody(request, 1024 * 1024);
	} catch (error) {
		if (error instanceof HttpError) {
			return jsonError(error.status, error.status === 413 ? "Request body exceeds the 1 MB limit" : "Request body contains invalid JSON");
		}
		throw error;
	}
	if (!isRecord(body) || !Array.isArray(body.messages)) {
		return jsonError(400, "Request body must include a messages array");
	}
	if (body.stream !== undefined && typeof body.stream !== "boolean") {
		return jsonError(400, "stream must be a boolean");
	}

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
				"X-Title": process.env.OPENROUTER_APP_NAME ?? "Agent Learning Playground",
			},
			body: JSON.stringify({ ...body, model }),
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		const cause = error instanceof Error ? error.cause : undefined;
		console.error(
			"Model proxy request failed:",
			error instanceof Error ? error.message : "Unknown error",
			isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined,
		);
		return jsonError(502, "Unable to reach model provider");
	}

	if (!upstream.ok) {
		let message = `Model provider returned ${upstream.status}`;
		try {
			const errorBody: unknown = await upstream.json();
			if (isRecord(errorBody) && isRecord(errorBody.error) && typeof errorBody.error.message === "string") {
				message = errorBody.error.message;
			}
		} catch {
			// Keep the provider response body out of client-facing errors.
		}
		return jsonError(upstream.status, message);
	}

	if (body.stream !== true) {
		return Response.json(await upstream.json(), { status: upstream.status });
	}
	if (!upstream.body) return jsonError(502, "Model provider returned an empty stream");

	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
