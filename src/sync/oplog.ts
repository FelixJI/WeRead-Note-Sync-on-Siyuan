// 操作日志（设计契约 §2/§4）：环形数组（默认上限 500，超出丢最旧），每次变更持久化。
// 中断恢复依据：pending 条目留待下一轮 reconcile，绝不盲目重试（engine 负责）。

export interface OpLogEntry {
    opId: string;
    ts: string;
    intent:
        | "create-notebook"
        | "create-doc"
        | "create-block"
        | "set-attrs"
        | "adopt"
        | "quarantine"
        | "update-block"
        | "decision"
        | "project";
    sourceKey?: string;
    blockId?: string;
    payloadText?: string;
    /** T03：update-block 完整 before/after 快照（审计用，不截断） */
    beforeText?: string;
    afterText?: string;
    status: "pending" | "done" | "failed";
    error?: string;
}

const DEFAULT_MAX_ENTRIES = 500;

export class OpLog {
    private readonly persistFn: (entries: OpLogEntry[]) => Promise<void>;
    private readonly items: OpLogEntry[];
    private readonly max: number;

    constructor(
        persist: (entries: OpLogEntry[]) => Promise<void>,
        initial: OpLogEntry[],
        max?: number,
    ) {
        this.persistFn = persist;
        this.items = [...initial];
        this.max = max ?? DEFAULT_MAX_ENTRIES;
    }

    /** 追加条目：补默认 status="pending"，入环（超限丢最旧）后持久化，返回完整条目副本。 */
    async append(
        entry: Omit<OpLogEntry, "status"> & { status?: "pending" | "done" | "failed" },
    ): Promise<OpLogEntry> {
        const full: OpLogEntry = { ...entry, status: entry.status ?? "pending" };
        this.items.push(full);
        while (this.items.length > this.max) {
            this.items.shift();
        }
        await this.persistFn([...this.items]);
        return { ...full };
    }

    /** 完成：默认 status→done；patch 携带 error 时 →failed。未知 opId throw。 */
    async complete(
        opId: string,
        patch: Partial<Pick<OpLogEntry, "blockId" | "error">>,
    ): Promise<void> {
        const index = this.lastIndexOfOpId(opId);
        if (index < 0) {
            throw new Error(`oplog.complete：未知 opId ${opId}`);
        }
        const failed = patch.error !== undefined;
        this.items[index] = { ...this.items[index], ...patch, status: failed ? "failed" : "done" };
        await this.persistFn([...this.items]);
    }

    /** 失败：status→failed + error。未知 opId 容忍（PR#9 评审修复：
     * store.save(pending) 与 oplog.append 之间崩溃会留下无日志条目的持久意图，
     * reconcile 期间的 fail 不再抛错卡死该书；合成一条 failed 条目保留审计痕迹）。 */
    async fail(opId: string, error: string): Promise<void> {
        const index = this.lastIndexOfOpId(opId);
        if (index < 0) {
            await this.append({ opId, ts: new Date().toISOString(), intent: "create-block", status: "failed", error: `意图无对应日志条目（写入中断）：${error}` });
            return;
        }
        this.items[index] = { ...this.items[index], error, status: "failed" };
        await this.persistFn([...this.items]);
    }

    entries(): readonly OpLogEntry[] {
        return [...this.items];
    }

    pending(): readonly OpLogEntry[] {
        return this.items.filter((entry) => entry.status === "pending");
    }

    /** 取该 opId 最新一条（opId 应唯一，重复时以最后一条为准） */
    private lastIndexOfOpId(opId: string): number {
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
            if (this.items[i].opId === opId) return i;
        }
        return -1;
    }
}
