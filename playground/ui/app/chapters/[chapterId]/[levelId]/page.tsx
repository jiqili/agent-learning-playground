import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Markdown } from "@/app/components/Markdown";
import { requireUser } from "@/lib/auth";
import { findLevel, levelKey } from "@/lib/curriculum";
import { getUserProgress } from "@/lib/progress";
import { LevelWorkspace } from "./LevelWorkspace";

export default function LevelPage({ params }: PageProps<"/chapters/[chapterId]/[levelId]">) {
	return (
		<Suspense fallback={<main className="page muted">加载中…</main>}>
			<LevelContent params={params} />
		</Suspense>
	);
}

async function LevelContent({ params }: { params: PageProps<"/chapters/[chapterId]/[levelId]">["params"] }) {
	const { chapterId, levelId } = await params;
	const found = findLevel(chapterId, levelId);
	if (!found) notFound();

	const user = await requireUser();
	const progress = await getUserProgress(user.id);
	const { chapter, level, index, previous, next } = found;
	const current = progress.get(levelKey(chapterId, levelId));
	const previousRecord = previous ? progress.get(levelKey(chapterId, previous.id)) : undefined;

	if (previous && !previousRecord?.passed) {
		return (
			<main className="page">
				<h1>关卡未解锁</h1>
				<p className="muted">请先通过上一关「{previous.title}」。</p>
				<Link href={`/chapters/${chapterId}/${previous.id}`} className="button">前往上一关</Link>
			</main>
		);
	}

	return (
		<main className="level-page">
			<article className="level-description">
				<div className="breadcrumb">
					<Link href="/chapters">章节</Link> / {chapter.title} / 第 {index + 1} 关
				</div>
				<h1>{level.title}</h1>
				<Markdown source={level.description} />
			</article>
			<LevelWorkspace
				key={levelKey(chapterId, levelId)}
				chapterId={chapterId}
				levelId={levelId}
				initialCode={current?.code ?? previousRecord?.code ?? level.starterCode}
				starterCode={level.starterCode}
				alreadyPassed={current?.passed === true}
				nextHref={next ? `/chapters/${chapterId}/${next.id}` : undefined}
			/>
		</main>
	);
}
