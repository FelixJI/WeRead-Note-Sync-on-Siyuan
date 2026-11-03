/**
 * T06 单写入端守卫（Issue #7 AC1/AC2）。
 *
 * 语义：index 持 writerId（本端随机 ID+名称+时间戳）；任一端同步前核对——
 * - 无 writerId → 认领（首次）；
 * - writerId=本端 → 正常；
 * - writerId=他端且 lease 未过期（默认 30 分钟内有活动）→ 本端停写（返回 WriterConflict，绝不写）；
 * - 他端 lease 过期 → 可接管，但记录 takeover 上报（显式、可追溯，非静默）。
 * 普通配置标志不是分布式锁：边界如实写入文档（不承诺跨端互斥零窗口）。
 */
import type { SyncIndex } from "../sync/model";

export const WRITER_LEASE_MS = 30 * 60 * 1000;

export interface WriterIdentity {
    writerId: string;
    label: string;
}

export interface WriterClaim {
    writerId: string;
    label: string;
    claimedAt: number;
    lastSeenAt: number;
}

export type WriterCheck =
    | { ok: true; claim: WriterClaim; takeover: boolean }
    | { ok: false; reason: "conflict"; holder: WriterClaim }
    | { ok: false; reason: "error"; message: string };

export function newWriterIdentity(label: string): WriterIdentity {
    return {
        writerId: `w-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
        label,
    };
}

export function checkOrClaimWriter(
    index: SyncIndex,
    self: WriterIdentity,
    nowMs: number,
    leaseMs: number = WRITER_LEASE_MS,
): WriterCheck {
    const existing = (index as SyncIndex & { writer?: WriterClaim }).writer;
    if (existing === undefined || typeof existing.writerId !== "string" || existing.writerId.length === 0) {
        return {
            ok: true,
            takeover: false,
            claim: { writerId: self.writerId, label: self.label, claimedAt: nowMs, lastSeenAt: nowMs },
        };
    }
    if (existing.writerId === self.writerId) {
        return { ok: true, takeover: false, claim: { ...existing, lastSeenAt: nowMs } };
    }
    if (nowMs - existing.lastSeenAt < leaseMs) {
        return { ok: false, reason: "conflict", holder: existing };
    }
    // 过期接管：显式、可追溯
    return {
        ok: true,
        takeover: true,
        claim: { writerId: self.writerId, label: self.label, claimedAt: nowMs, lastSeenAt: nowMs },
    };
}
