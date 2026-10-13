import "dotenv/config";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;
const allowedOrigins = new Set(
	(process.env.CORS_ORIGINS ?? "http://localhost:5173")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
);
const upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";

app.disable("x-powered-by");
app.use((req, res, next) => {
	const origin = req.header("origin");
	if (origin && allowedOrigins.has(origin)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	}
	if (req.method === "OPTIONS") {
		return res.sendStatus(origin && !allowedOrigins.has(origin) ? 403 : 204);
	}
	next();
});
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
	res.json({
		status: "ok",
		configured: Boolean(apiKey && model),
	});
});

app.post("/v1/chat/completions", async (req: Request, res: Response) => {
	if (!apiKey || !model) {
		return res.status(503).json({ error: "Model proxy is not configured" });
	}

	const body: unknown = req.body;
	if (!isRecord(body) || !Array.isArray(body.messages)) {
		return res.status(400).json({ error: "Request body must include a messages array" });
	}
	if (body.stream !== undefined && typeof body.stream !== "boolean") {
		return res.status(400).json({ error: "stream must be a boolean" });
	}

	const controller = new AbortController();
	const abortUpstream = () => controller.abort();
	res.on("close", () => {
		if (!res.writableEnded) abortUpstream();
	});

	try {
		const upstream = await fetch(upstreamUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost",
				"X-Title": process.env.OPENROUTER_APP_NAME ?? "Agent Learning Playground",
			},
			body: JSON.stringify({ ...body, model }),
			signal: controller.signal,
		});

		if (!upstream.ok) {
			const errorText = await upstream.text();
			let message = `Model provider returned ${upstream.status}`;
			try {
				const errorBody: unknown = JSON.parse(errorText);
				if (isRecord(errorBody) && isRecord(errorBody.error) && typeof errorBody.error.message === "string") {
					message = errorBody.error.message;
				}
			} catch {
				// Keep the provider response body out of client-facing errors.
			}
			return res.status(upstream.status).json({ error: message });
		}

		if (body.stream !== true) {
			const result: unknown = await upstream.json();
			return res.status(upstream.status).json(result);
		}

		if (!upstream.body) {
			return res.status(502).json({ error: "Model provider returned an empty stream" });
		}

		res.status(upstream.status);
		res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		const reader = upstream.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!res.write(value)) {
					await new Promise<void>((resolve) => res.once("drain", resolve));
				}
			}
			res.end();
		} finally {
			reader.releaseLock();
		}
	} catch (error) {
		if (controller.signal.aborted) return;
		console.error("Model proxy request failed:", error instanceof Error ? error.message : "Unknown error");
		if (res.headersSent) {
			res.end();
		} else {
			res.status(502).json({ error: "Unable to reach model provider" });
		}
	}
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
	if (error instanceof SyntaxError) {
		return res.status(400).json({ error: "Request body contains invalid JSON" });
	}
	if (error instanceof Error && "type" in error && error.type === "entity.too.large") {
		return res.status(413).json({ error: "Request body exceeds the 1 MB limit" });
	}
	console.error("Backend request failed:", error instanceof Error ? error.message : "Unknown error");
	return res.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);

app.listen(port, "127.0.0.1", () => {
	console.log(`Model proxy listening on http://127.0.0.1:${port}`);
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
