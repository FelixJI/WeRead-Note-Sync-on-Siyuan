/**
 * 审阅会话（UI 装配层，设计契约 §4）：
 *
 * - 插件加载时 initReviewSession(deps) 注入运行时依赖（一次）；
 * - buildReviewQueue()/applyDecision() 为 UI 调用的无参单例（未初始化即抛错）；
 * - 会话缓存决策时快照 expectedLocal（按 sourceKey），applyDecision 内部比对实现"过期计划"判定（AC4）；
 *   队列重建（刷新/重开对话框）即刷新快照——旧决策自然失效。
 */
import type { SyncEngine } from "../sync/engine";
import type { ReviewCandidate, ApplyResult } from "../sync/engine";

export type { ReviewCandidate, ApplyResult };

export interface ReviewSessionDeps {
    engine: SyncEngine;
}

type DecisionAction = "apply-remote" | "keep-local" | "manual-merge" | "save-copy" | "defer";

let engineRef: SyncEngine | undefined;
const expectedLocalCache = new Map<string, string>();
const expectedFingerprintCache = new Map<string, string>();

export function initReviewSession(deps: ReviewSessionDeps): void {
    engineRef = deps.engine;
    expectedLocalCache.clear();
}

function requireEngine(): SyncEngine {
    if (engineRef === undefined) {
        throw new Error("审阅会话未初始化（插件未加载）");
    }
    return engineRef;
}

export async function buildReviewQueue(): Promise<{ items: ReviewCandidate[] }> {
    const items = await requireEngine().buildReviewQueue();
    // 刷新决策时快照：只对仍在队列的条目保留/更新，已消失的清除
    const alive = new Set(items.map((i) => i.sourceKey));
    for (const key of [...expectedLocalCache.keys()]) {
        if (!alive.has(key)) {
            expectedLocalCache.delete(key);
            expectedFingerprintCache.delete(key);
        }
    }
    for (const item of items) {
        expectedLocalCache.set(item.sourceKey, item.local);
        expectedFingerprintCache.set(item.sourceKey, item.remoteFingerprint);
    }
    return { items };
}

export async function applyDecision(
    sourceKey: string,
    action: DecisionAction,
    manualText?: string,
): Promise<ApplyResult> {
    const expected = expectedLocalCache.get(sourceKey);
    if (expected === undefined) {
        return { ok: false, kind: "stale", message: "决策快照缺失（队列已刷新），请重新审阅" };
    }
    const result = await requireEngine().applyDecision(
        sourceKey,
        action,
        manualText,
        expected,
        expectedFingerprintCache.get(sourceKey),
    );
    if (result.ok) {
        expectedLocalCache.delete(sourceKey);
        expectedFingerprintCache.delete(sourceKey);
    }
    return result;
}
