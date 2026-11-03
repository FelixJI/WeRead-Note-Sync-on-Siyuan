/**
 * T06 单写入端守卫测试（AC1/AC2 核心语义）。
 */
import { describe, expect, it } from "vitest";
import { checkOrClaimWriter, newWriterIdentity, WRITER_LEASE_MS } from "../../src/sync/writer-guard";
import type { SyncIndex } from "../../src/sync/model";

function indexWithWriter(writer?: { writerId: string; label: string; claimedAt: number; lastSeenAt: number }): SyncIndex {
    return {
        schemaVersion: 1,
        accountNamespace: "测试账号",
        books: {},
        ...(writer !== undefined ? { writer } : {}),
    } as SyncIndex;
}

describe("T06 单写入端守卫", () => {
    const NOW = 1770000000000;

    it("AC1：无持有者 → 认领；自己 → 续约", () => {
        const self = newWriterIdentity("桌面端");
        const r1 = checkOrClaimWriter(indexWithWriter(undefined), self, NOW);
        expect(r1.ok).toBe(true);
        if (r1.ok) {
            expect(r1.claim.writerId).toBe(self.writerId);
            expect(r1.takeover).toBe(false);
        }
        const r2 = checkOrClaimWriter(indexWithWriter({ writerId: self.writerId, label: "桌面端", claimedAt: NOW - 1000, lastSeenAt: NOW - 1000 }), self, NOW);
        expect(r2.ok).toBe(true);
    });

    it("AC1：他端租约未过期 → 停写（conflict，含持有者信息）", () => {
        const self = newWriterIdentity("浏览器端");
        const other = newWriterIdentity("桌面端");
        const idx = indexWithWriter({ writerId: other.writerId, label: "桌面端", claimedAt: NOW - 60_000, lastSeenAt: NOW - 60_000 });
        const r = checkOrClaimWriter(idx, self, NOW);
        expect(r.ok).toBe(false);
        if (!r.ok && r.reason === "conflict") {
            expect(r.holder.label).toBe("桌面端");
        }
    });

    it("AC2：他端租约过期 → 显式接管（takeover=true，可追溯）", () => {
        const self = newWriterIdentity("新端");
        const idx = indexWithWriter({ writerId: "w-old", label: "旧端", claimedAt: NOW - WRITER_LEASE_MS * 2, lastSeenAt: NOW - WRITER_LEASE_MS * 2 });
        const r = checkOrClaimWriter(idx, self, NOW);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.takeover).toBe(true);
            expect(r.claim.writerId).toBe(self.writerId);
        }
    });

    it("边界：租约恰好过期（=leaseMs）→ 可接管；差 1ms 未过期 → 冲突", () => {
        const self = newWriterIdentity("X");
        const idx = indexWithWriter({ writerId: "w-o", label: "O", claimedAt: 0, lastSeenAt: NOW - WRITER_LEASE_MS });
        expect(checkOrClaimWriter(idx, self, NOW).ok).toBe(true);
        const idx2 = indexWithWriter({ writerId: "w-o", label: "O", claimedAt: 0, lastSeenAt: NOW - WRITER_LEASE_MS + 1 });
        const r2 = checkOrClaimWriter(idx2, self, NOW);
        expect(r2.ok).toBe(false);
    });
});
