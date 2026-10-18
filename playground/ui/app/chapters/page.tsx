import Link from "next/link";
import { Suspense } from "react";
import { requireUser } from "@/lib/auth";
import { chapters, levelKey } from "@/lib/curriculum";
import { getUserProgress, levelStatuses, type LevelStatus } from "@/lib/progress";

const statusLabel: Record<LevelStatus, string> = {
	passed: "已通过",
	available: "进行中",
	locked: "未解锁",
};

export default function ChaptersPage() {
	return (
		<main className="page">
			<h1 style={{ marginTop: 0 }}>章节</h1>
			<Suspense fallback={<p className="muted">加载中…</p>}>
				<ChapterList />
			</Suspense>
		</main>
	);
}

async function ChapterList() {
	const user = await requireUser();
	const statuses = levelStatuses(await getUserProgress(user.id));

	return (
		<>
			{chapters.map((chapter, chapterIndex) => {
				const passedCount = chapter.levels.filter((level) => statuses.get(levelKey(chapter.id, level.id)) === "passed").length;
				return (
					<section key={chapter.id} className="chapter">
						<div className="chapter-header">
							<h2>第 {chapterIndex + 1} 章 · {chapter.title}</h2>
							<span className="muted">{passedCount} / {chapter.levels.length} 关</span>
						</div>
						<p className="muted" style={{ margin: "4px 0 0" }}>{chapter.summary}</p>
						<ol className="level-list">
							{chapter.levels.map((level, index) => {
								const status = statuses.get(levelKey(chapter.id, level.id)) ?? "locked";
								const content = (
									<>
										<span className="level-index">{index + 1}</span>
										<span className="level-body">
											<div className="level-title">{level.title}</div>
											<div className="level-summary">{level.summary}</div>
										</span>
										<span className={`badge ${status}`}>{statusLabel[status]}</span>
									</>
								);
								return (
									<li key={level.id}>
										{status === "locked" ? (
											<div className="level-item locked" aria-disabled="true">{content}</div>
										) : (
											<Link href={`/chapters/${chapter.id}/${level.id}`} className="level-item">{content}</Link>
										)}
									</li>
								);
							})}
						</ol>
					</section>
				);
			})}
			<p className="muted">更多章节即将推出…</p>
		</>
	);
}
