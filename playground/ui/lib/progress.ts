import "server-only";
import { chapters, findLevel, levelKey } from "./curriculum";
import { readDb, updateDb, type ProgressRecord } from "./db";

export type LevelStatus = "locked" | "available" | "passed";

export async function getUserProgress(userId: string): Promise<Map<string, ProgressRecord>> {
	return readDb((db) => new Map(
		db.progress.filter((record) => record.userId === userId).map((record) => [record.levelKey, { ...record }]),
	));
}

export function levelStatuses(progress: Map<string, ProgressRecord>): Map<string, LevelStatus> {
	const statuses = new Map<string, LevelStatus>();
	for (const chapter of chapters) {
		let previousPassed = true;
		for (const level of chapter.levels) {
			const key = levelKey(chapter.id, level.id);
			const passed = progress.get(key)?.passed === true;
			statuses.set(key, passed ? "passed" : previousPassed ? "available" : "locked");
			previousPassed = passed;
		}
	}
	return statuses;
}

export async function isLevelUnlocked(userId: string, chapterId: string, levelId: string): Promise<boolean> {
	const found = findLevel(chapterId, levelId);
	if (!found) return false;
	if (!found.previous) return true;
	const previousKey = levelKey(chapterId, found.previous.id);
	return readDb((db) => db.progress.some(
		(record) => record.userId === userId && record.levelKey === previousKey && record.passed,
	));
}

export async function saveAttempt(userId: string, key: string, code: string, passed: boolean): Promise<void> {
	const now = new Date().toISOString();
	await updateDb((db) => {
		const existing = db.progress.find((record) => record.userId === userId && record.levelKey === key);
		if (existing) {
			existing.code = code;
			existing.updatedAt = now;
			if (passed && !existing.passed) {
				existing.passed = true;
				existing.passedAt = now;
			}
			return;
		}
		db.progress.push({ userId, levelKey: key, code, passed, updatedAt: now, ...(passed ? { passedAt: now } : {}) });
	});
}
