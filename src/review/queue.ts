/**
 * 审阅会话（UI 装配层，设计契约 §4）：
 *
 * - 插件加载时 initReviewSession(deps) 注入运行时依赖（一次）；
 * - buildReviewQueue()/applyDecision() 为 UI 调用的无参单例（未初始化即抛错）。
 * - 决策快照纪律（PR10[2] 整改）：决策必须锚定"展示时快照"——applyDecision 显式携带
 *   expected（UI 条目视图的 local / remoteFingerprint，即用户实际看到并据以决策的内容）；
 *   会话缓存仅作未携带快照调用的兜底，且只在条目首次进入会话时落位，存活期间不被
 *   队列重建（refreshItem / 手动刷新）覆盖——否则其它条目会以刷新出的新缓存通过过期
 *   检查，静默覆盖用户在展示之后做出的编辑。宁可过期拒绝（重审），绝不静默放行
 *   （AGENTS.md L19：既有正文变化须先经审阅）。
 */
import type { SyncEngine } from "../sync/engine";
import type { ReviewCandidate, ApplyResult } from "../sync/engine";

export type { ReviewCandidate, ApplyResult };

export interface ReviewSessionDeps {
    engine: SyncEngine;
}

/** 决策时（展示时）快照：随决策显式携带，防止队列重建刷新共享缓存后静默放行。 */
export interface DecisionSnapshot {
    /** 展示时本地块内容（用户看到的 local） */
    local: string;
    /** 展示时远端指纹（用户审阅的远端版本；缺失则不校验远端新鲜度） */
    remoteFingerprint?: string;
}

type DecisionAction = "apply-remote" | "keep-local" | "manual-merge" | "save-copy" | "defer";

let engineRef: SyncEngine | undefined;
const expectedLocalCache = new Map<string, string>();
const expectedFingerprintCache = new Map<string, string>();

export function initReviewSession(deps: ReviewSessionDeps): void {
    engineRef = deps.engine;
    expectedLocalCache.clear();
    expectedFingerprintCache.clear();
}

function requireEngine(): SyncEngine {
    if (engineRef === undefined) {
        throw new Error("审阅会话未初始化（插件未加载）");
    }
    return engineRef;
}

export async function buildReviewQueue(): Promise<{ items: ReviewCandidate[] }> {
    const items = await requireEngine().buildReviewQueue();
    // 快照缓存纪律：只清理已消失条目；存活条目保留"首次展示时"的快照，不因重建刷新
    // （refreshItem 只刷新单个条目的展示数据，绝不能替换其它条目的展示时快照缓存；
    //  本地快照与远端指纹两个缓存同守此规）。展示时快照由决策显式携带。
    const alive = new Set(items.map((i) => i.sourceKey));
    for (const key of [...expectedLocalCache.keys()]) {
        if (!alive.has(key)) {
            expectedLocalCache.delete(key);
            expectedFingerprintCache.delete(key);
        }
    }
    for (const item of items) {
        if (!expectedLocalCache.has(item.sourceKey)) {
            expectedLocalCache.set(item.sourceKey, item.local);
            expectedFingerprintCache.set(item.sourceKey, item.remoteFingerprint);
        }
    }
    return { items };
}

export async function applyDecision(
    sourceKey: string,
    action: DecisionAction,
    manualText?: string,
    expected?: DecisionSnapshot,
): Promise<ApplyResult> {
    // 展示时快照优先随决策携带；未携带时回退会话缓存（首次展示值，宁过期不冒进）
    const expectedLocal = expected?.local ?? expectedLocalCache.get(sourceKey);
    if (expectedLocal === undefined) {
        return { ok: false, kind: "stale", message: "决策快照缺失（队列已刷新），请重新审阅" };
    }
    const expectedFingerprint = expected?.remoteFingerprint ?? expectedFingerprintCache.get(sourceKey);
    const result = await requireEngine().applyDecision(
        sourceKey,
        action,
        manualText,
        expectedLocal,
        expectedFingerprint,
    );
    if (result.ok) {
        expectedLocalCache.delete(sourceKey);
        expectedFingerprintCache.delete(sourceKey);
    }
    return result;
}
