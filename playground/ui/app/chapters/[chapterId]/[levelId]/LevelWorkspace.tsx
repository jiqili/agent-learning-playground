"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CodeEditor } from "@/app/components/CodeEditor";
import type { TestRunResult } from "@/lib/test-runner";

interface LevelWorkspaceProps {
	chapterId: string;
	levelId: string;
	initialCode: string;
	starterCode: string;
	alreadyPassed: boolean;
	nextHref?: string;
}

export function LevelWorkspace({ chapterId, levelId, initialCode, starterCode, alreadyPassed, nextHref }: LevelWorkspaceProps) {
	const router = useRouter();
	const [code, setCode] = useState(initialCode);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<TestRunResult>();
	const [error, setError] = useState<string>();
	const [passed, setPassed] = useState(alreadyPassed);

	async function runTests() {
		setRunning(true);
		setError(undefined);
		try {
			const response = await fetch(`/api/levels/${encodeURIComponent(chapterId)}/${encodeURIComponent(levelId)}/submit`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			});
			const payload = (await response.json().catch(() => ({}))) as { result?: TestRunResult; error?: string };
			if (!response.ok || !payload.result) {
				if (response.status === 401) router.push("/login");
				setError(payload.error ?? `请求失败（${response.status}）`);
				return;
			}
			setResult(payload.result);
			if (payload.result.passed) {
				setPassed(true);
				router.refresh();
			}
		} catch {
			setError("网络错误，请稍后再试");
		} finally {
			setRunning(false);
		}
	}

	function resetCode() {
		if (window.confirm("确定要重置为初始代码吗？当前未提交的修改会丢失。")) {
			setCode(starterCode);
			setResult(undefined);
		}
	}

	const passedCount = result?.tests.filter((test) => test.passed).length ?? 0;

	return (
		<section className="workspace">
			<div className="workspace-toolbar">
				<span className="file-tab">
					agent.ts {passed && <span className="badge passed">已通过</span>}
				</span>
				<div className="actions">
					<span className="muted small hint">Ctrl + Enter 运行</span>
					<button type="button" className="button secondary sm" onClick={resetCode} disabled={running}>重置</button>
					<button type="button" className="button sm" onClick={runTests} disabled={running}>
						{running ? "测试运行中…" : "▶ 运行测试"}
					</button>
				</div>
			</div>
			<CodeEditor value={code} onChange={setCode} onRun={() => { if (!running) void runTests(); }} />
			{(result || error) && (
				<div className="results" aria-live="polite">
					{error && <div className="form-error">{error}</div>}
					{result && (
						<>
							<div className={`results-summary ${result.passed ? "passed" : "failed"}`}>
								<span>
									{result.passed
										? `全部 ${result.tests.length} 个测试通过！`
										: result.error ?? `${passedCount} / ${result.tests.length} 个测试通过`}
								</span>
								{result.passed && nextHref && <Link href={nextHref} className="button">下一关 →</Link>}
								{result.passed && !nextHref && <Link href="/chapters" className="button">返回章节</Link>}
							</div>
							{result.tests.map((test) => (
								<div key={test.name} className="test-case">
									<div className="test-name">
										<span className={`test-icon ${test.passed ? "passed" : "failed"}`}>{test.passed ? "✓" : "✗"}</span>
										<span>{test.name}</span>
										<span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>{test.durationMs} ms</span>
									</div>
									{test.error && <pre className="test-error">{test.error}</pre>}
								</div>
							))}
							{result.output && (
								<details open={!!result.error}>
									<summary>控制台输出</summary>
									<pre className="test-output">{result.output}</pre>
								</details>
							)}
						</>
					)}
				</div>
			)}
		</section>
	);
}
