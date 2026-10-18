// Runs inside the sandboxed test process next to the learner's agent.ts.
type TestFn = () => void | Promise<void>;

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: any;
}

const RESULT_MARKER = "__ALP_RESULT__";
const TEST_TIMEOUT_MS = 5_000;
const tests: { name: string; fn: TestFn }[] = [];
const originalFetch = globalThis.fetch;

export function test(name: string, fn: TestFn): void {
	tests.push({ name, fn });
}

export async function loadAgentModule(): Promise<Record<string, any>> {
	try {
		return await import("./agent.ts");
	} catch (error) {
		await report([{ name: "加载 agent.ts", passed: false, error: formatError(error), durationMs: 0 }]);
		process.exit(0);
	}
}

export function completion(message: Record<string, unknown>): Record<string, unknown> {
	return { choices: [{ index: 0, finish_reason: "stop", message }] };
}

export function mockBackend(responses: Array<Record<string, unknown> | { status: number; body: unknown }>) {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const text = await request.text();
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {
			// keep raw text so assertions can show it
		}
		requests.push({ url: request.url, method: request.method, headers: request.headers, body });
		const next = responses.shift();
		if (!next) throw new Error("模拟后端没有更多响应了：Agent 请求模型的次数超出预期");
		if ("status" in next && typeof next.status === "number") {
			return Response.json(next.body, { status: next.status });
		}
		return Response.json(next);
	}) as typeof fetch;
	return { requests };
}

async function withTimeout(promise: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`测试超过 ${TEST_TIMEOUT_MS / 1000} 秒未完成`)), TEST_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

async function report(results: unknown[]): Promise<void> {
	await new Promise<void>((resolve) => {
		process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(results)}\n`, () => resolve());
	});
}

export async function run(): Promise<void> {
	const results: { name: string; passed: boolean; error?: string; durationMs: number }[] = [];
	for (const { name, fn } of tests) {
		const startedAt = performance.now();
		try {
			await withTimeout(Promise.resolve().then(fn));
			results.push({ name, passed: true, durationMs: Math.round(performance.now() - startedAt) });
		} catch (error) {
			results.push({ name, passed: false, error: formatError(error), durationMs: Math.round(performance.now() - startedAt) });
		} finally {
			globalThis.fetch = originalFetch;
		}
	}
	await report(results);
	process.exit(0);
}
