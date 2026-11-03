// T03 设计契约 §1（docs/design/t03-diff-review.md）：冲突分类与决策记录纯函数层。
// 全部内容比较基于 trim 后全文相等；无 IO、无随机性、不修改入参。

export type ConflictKind = "identical" | "remote-only" | "local-only" | "both-changed";

/**
 * 冲突分类（比较均取 trim 后全文相等）：
 * - identical：本地与远端都等于基线（三者一致）；
 * - remote-only：本地 == 基线 且 远端 != 基线（仅远端变化）；
 * - local-only：远端 == 基线 且 本地 != 基线（仅本地变化）；
 * - both-changed：两侧均偏离基线（即使本地与远端彼此一致，也按两侧偏离归类）。
 */
export function classifyConflict(baseline: string, local: string, remote: string): ConflictKind {
    const base = baseline.trim();
    const localUnchanged = local.trim() === base;
    const remoteUnchanged = remote.trim() === base;
    if (localUnchanged && remoteUnchanged) {
        return "identical";
    }
    if (localUnchanged) {
        return "remote-only";
    }
    if (remoteUnchanged) {
        return "local-only";
    }
    return "both-changed";
}

export type DecisionAction =
    | "apply-remote"
    | "keep-local"
    | "manual-merge"
    | "save-copy"
    | "defer";

/** 一条已落地决策的审计/校验记录（语义见设计 §2 各决策动作）。 */
export interface DecisionRecord {
    sourceKey: string;
    action: DecisionAction;
    decidedAt: string;
    expectedLocal: string;
    remoteRendered: string;
    manualText?: string;
}

/**
 * 决策过期判定：当前本地内容（trim 后）与决策时锚定的 expectedLocal（trim 后）
 * 不一致 → 过期（对应 §3 步骤 2 的并发窗口防线：过期计划不应用、保留候选）。
 */
export function isDecisionStale(record: DecisionRecord, currentLocal: string): boolean {
    return currentLocal.trim() !== record.expectedLocal.trim();
}

/**
 * 手动合并文本规范化：去除首尾空白。
 * baseline 仅为签名完整性保留——规范化不依赖基线内容（设计 §1 注明）。
 */
export function renderManualMerge(baseline: string, manualText: string): string {
    void baseline;
    return manualText.trim();
}

/** 候选排序键：书名 → 章序（缺失殿后）→ 来源键。 */
export interface CandidateSortKey {
    bookTitle: string;
    chapterIdx?: number;
    sourceKey: string;
}

/**
 * 稳定排序（Array#sort 自 ES2019 起稳定）：bookTitle 按 UTF-16 码元字典序，
 * chapterIdx 数值序且 undefined 殿后，最后按 sourceKey。
 * 返回新数组，不修改入参。
 */
export function sortCandidates<T extends CandidateSortKey>(list: T[]): T[] {
    return [...list].sort((x, y) => {
        if (x.bookTitle !== y.bookTitle) {
            return x.bookTitle < y.bookTitle ? -1 : 1;
        }
        const xi = x.chapterIdx;
        const yi = y.chapterIdx;
        if (xi !== undefined || yi !== undefined) {
            if (xi === undefined) {
                return 1;
            }
            if (yi === undefined) {
                return -1;
            }
            if (xi !== yi) {
                return xi < yi ? -1 : 1;
            }
        }
        if (x.sourceKey !== y.sourceKey) {
            return x.sourceKey < y.sourceKey ? -1 : 1;
        }
        return 0;
    });
}
