/**
 * T05 纯函数层测试（AC1-AC3 全量）+ 服务层契约测试。
 */
import { describe, expect, it } from "vitest";
import {
    buildHeatmapYear,
    formatDuration,
    formatProgress,
    renderStatsSnapshot,
    streakDays,
    utcDateKey,
} from "../../src/stats/pure";
import { collectStats } from "../../src/stats/service";
import type { Transport } from "../../src/core/net/transport";

describe("T05 统计纯函数", () => {
    it("AC1：秒→X小时Y分钟；缺字段→不可用/未知", () => {
        expect(formatDuration(0)).toBe("0秒");
        expect(formatDuration(59)).toBe("59秒");
        expect(formatDuration(60)).toBe("1分钟");
        expect(formatDuration(3600)).toBe("1小时");
        expect(formatDuration(7380)).toBe("2小时3分钟");
        expect(formatDuration(undefined)).toBe("未知");
        expect(formatProgress(1).text).toBe("1%"); // 1=1% 而非 100%
        expect(formatProgress(1).finished).toBe(false);
        expect(formatProgress(100).finished).toBe(true);
        expect(formatProgress(undefined).text).toBe("不可用");
    });

    it("AC2：仅月桶不伪造日值（unknown）；有日明细才 daily", () => {
        const y = buildHeatmapYear(2025, undefined, { "1738368000": 3600 }, 1760000000); // 月桶 key=2025-02-02 起
        expect(y.source).toBe("monthly");
        expect(y.days.every((d) => d.kind === "unknown" || d.kind === "future")).toBe(true);
        expect(y.complete).toBe(false);
    });

    it("AC2/AC3：日明细区分 zero/value/unknown/future；闰年 366 天", () => {
        const start = Date.UTC(2024, 0, 1) / 1000; // 2024 闰年
        const daily: Record<string, number> = {
            [String(start)]: 0,
            [String(start + 86400)]: 1200,
        };
        const y = buildHeatmapYear(2024, daily, undefined, Date.UTC(2024, 1, 15) / 1000); // 2月15日
        expect(y.days).toHaveLength(366);
        expect(y.days[0]!.kind).toBe("zero");
        expect(y.days[1]!.kind).toBe("value");
        expect(y.days[1]!.seconds).toBe(1200);
        expect(y.days[60]!.kind).toBe("future"); // 3月1日之后为未来
        expect(y.coveredDays).toBe(2);
        expect(streakDays(y.days)).toBe(1); // 零值不算连续
    });

    it("AC3：连续天数不被 unknown 伪造拉长", () => {
        const start = Date.UTC(2025, 0, 1) / 1000;
        const daily: Record<string, number> = {
            [String(start)]: 100,
            [String(start + 86400)]: 100,
        };
        const y = buildHeatmapYear(2025, daily, undefined, Date.UTC(2025, 0, 10) / 1000);
        expect(streakDays(y.days)).toBe(2); // 第 3 天起 unknown 中断
    });

    it("快照文本：周期行 + 口径 + 生成时间；缺失→未知", () => {
        const text = renderStatsSnapshot({
            weekly: { label: "本周", totalSeconds: 3600, readDays: 2 },
            generatedAtIso: "2026-11-03T00:00:00Z",
        });
        expect(text).toContain("本周：1小时 · 2天");
        expect(text).toContain("本月：未知");
        expect(text).toContain("含听书");
        expect(text).toContain("2026-11-03T00:00:00Z");
        expect(utcDateKey(0)).toBe("1970-01-01");
    });
});

describe("T05 统计服务", () => {
    const KEY = "wrk-test-key-0001";

    function fakeTransport(failModes: Set<string> = new Set()): Transport {
        return {
            async post(url, body) {
                void url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    if (failModes.has(String(req.mode))) {
                        return { status: 200, body: JSON.stringify({ errcode: 1, errmsg: "统计暂不可用" }), contentType: "application/json" };
                    }
                    return {
                        status: 200,
                        body: JSON.stringify({
                            errcode: 0,
                            mode: req.mode,
                            totalReadTime: req.mode === "overall" ? 360000 : 7200,
                            readDays: 3,
                            dailyReadTimes: req.mode === "annually" ? { "1760000000": 600 } : undefined,
                        }),
                        contentType: "application/json",
                    };
                }
                return { status: 200, body: JSON.stringify({ errcode: -1, errmsg: "未知接口" }), contentType: "application/json" };
            },
        };
    }

    it("AC4：拉取四周期+热力图+快照；单周期失败独立降级（其余可用）", async () => {
        const t = fakeTransport(new Set(["overall"]));
        const r = await collectStats(t, KEY, 1767225600); // 2026-01-01
        expect(r.weekly?.totalReadTime).toBe(7200);
        expect(r.overall).toBeUndefined();
        expect(r.snapshotText).toContain("本周：2小时");
        expect(r.snapshotText).toContain("累计：未知");
        expect(r.heatmapYear.days).toHaveLength(365);
    });

    it("AC5：全部周期失败 → 快照全未知，不抛错", async () => {
        const t = fakeTransport(new Set(["weekly", "monthly", "annually", "overall"]));
        const r = await collectStats(t, KEY, 1767225600);
        expect(r.snapshotText).toContain("本周：未知");
        expect(r.heatmapYear.source).toBe("none");
    });
});
