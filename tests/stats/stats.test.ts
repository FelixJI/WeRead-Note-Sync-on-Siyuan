/**
 * T05 纯函数层测试（AC1-AC3 全量）+ 服务层契约测试。
 */
import { describe, expect, it } from "vitest";
import {
    beginDialogLoad,
    buildHeatmapYear,
    formatDuration,
    formatProgress,
    initialDialogLoadState,
    renderStatsSnapshot,
    settleDialogLoad,
    streakDays,
    utcDateKey,
} from "../../src/stats/pure";
import { collectStats, fetchReaddata, resetStatsCooldownForTest, statsInCooldown } from "../../src/stats/service";
import { UpgradeRequiredError } from "../../src/adapters/weread/gateway";
import type { Transport } from "../../src/core/net/transport";
import { SyncEngine } from "../../src/sync/engine";
import { FakeKernel, FakeTransport, MemoryPersistence, fixture } from "../sync/engine.test";

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
        const y = buildHeatmapYear(2025, undefined, { "1738368000": 3600 }, 1760000000); // 月桶 key=2025-02-01（1738368000=2025-02-01 UTC）
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
        expect(text).toContain("微信读书统计");
        expect(text).toContain("2026-11-03T00:00:00Z");
        expect(utcDateKey(0)).toBe("1970-01-01");
    });

    it("PR12[7]：历史年份——年度行/连续行按所选年份标注，周/月保持当期标签", () => {
        const text = renderStatsSnapshot({
            weekly: { label: "本周", totalSeconds: 3600 },
            monthly: { label: "本月", totalSeconds: 7200 },
            annually: { label: "2024 年", totalSeconds: 360000, readDays: 40 },
            overall: { label: "累计", totalSeconds: 3600000 },
            yearStreak: 5,
            yearLabel: "2024 年",
            generatedAtIso: "2026-11-03T00:00:00Z",
        });
        expect(text).toContain("2024 年：100小时 · 40天");
        expect(text).toContain("2024 年最长连续：5天");
        expect(text).toContain("本周：1小时");
        expect(text).toContain("本月：2小时");
        expect(text).not.toContain("本年：");
        expect(text).not.toContain("本年最长连续");
    });

    it("PR12[7]：默认（当年）保持「本年」标注", () => {
        const text = renderStatsSnapshot({
            annually: { label: "本年", totalSeconds: 3600 },
            yearStreak: 2,
            generatedAtIso: "2026-11-03T00:00:00Z",
        });
        expect(text).toContain("本年：1小时");
        expect(text).toContain("本年最长连续：2天");
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

    it("AC5：引擎级——统计成功写槽不影响同步 ok；统计失败只计告警（不触碰笔记状态）", async () => {
        // 统计成功的复合 Transport（notebooks/bookmarklist/reviews 正常 + readdata 返回数值）
        const books = fixture();
        const transport = new FakeTransport(books);
        const origPost = transport.post.bind(transport);
        transport.post = async (url: string, body: unknown) => {
            const req = body as Record<string, unknown>;
            if (req.api_name === "/readdata/detail") {
                return {
                    status: 200,
                    body: JSON.stringify({ errcode: 0, mode: req.mode, totalReadTime: 3600, readDays: 1 }),
                    contentType: "application/json",
                };
            }
            return origPost(url, body);
        };
        const kernel = new FakeKernel();
        const persistence = new MemoryPersistence();
        const engine = new SyncEngine({
            persistence, kernel: kernel.call, transport,
            apiKey: KEY, accountNamespace: "测试账号",
            now: () => "2026-11-03T00:00:00Z", newOpId: () => "op-s1",
        });
        const r = await engine.syncRound();
        expect(r.ok).toBe(true);
        expect(r.projectionErrors).toBeUndefined();
        const ov = kernel.allBlocks().find((b) => b.ial["custom-wrs-overview"] === "1")!;
        const stats = kernel.allBlocks().find((b) => b.ial["custom-wrs-section"] === "stats")!;
        expect(stats.markdown).toContain("本周：1小时"); // 真实数值写入（单块代码栅栏）
        expect(stats.rootId).toBe(ov.id);
    });

    it("复核：baseTime 请求形态——当年=年初、历史年份=该年 1/1 UTC、overall=0", async () => {
        const calls: Array<{ mode: string; baseTime?: number }> = [];
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    calls.push({ mode: String(req.mode), baseTime: typeof req.baseTime === "number" ? req.baseTime : undefined });
                    return { status: 200, body: JSON.stringify({ errcode: 0 }), contentType: "application/json" };
                }
                return { status: 200, body: JSON.stringify({ errcode: -1 }), contentType: "application/json" };
            },
        };
        await fetchReaddata(t, KEY, "weekly", 123456);
        expect(calls[0]).toEqual({ mode: "weekly", baseTime: 123456 });
        await fetchReaddata(t, KEY, "overall");
        expect(calls[1]!.baseTime).toBeUndefined();
        await collectStats(t, KEY, 1767225600, 2024); // 2026 当前年，请求 2024
        const annual = calls.find((c) => c.mode === "annually");
        expect(annual?.baseTime).toBe(Date.UTC(2024, 0, 1) / 1000);
    });

    it("复核：四败冷却——进入降级、不再发请求、10 分钟后自然退出（无再武装死锁）", async () => {
        resetStatsCooldownForTest();
        let requests = 0;
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    requests += 1;
                    return { status: 200, body: JSON.stringify({ errcode: 1, errmsg: "失败" }), contentType: "application/json" };
                }
                return { status: 200, body: JSON.stringify({ errcode: 0 }), contentType: "application/json" };
            },
        };
        const r1 = await collectStats(t, KEY, 1767225600);
        expect(requests).toBe(4);
        expect(r1.snapshotText).toContain("本周：未知");
        // 冷却期内：零请求、优雅降级说明
        const r2 = await collectStats(t, KEY, 1767225600 + 300); // 5 分钟后（仍在冷却）
        expect(requests).toBe(4);
        expect(r2.snapshotText).toContain("统计冷却中");
        // 11 分钟后：自然退出，重新尝试（再次失败→重新进入冷却，非死锁）
        const r3 = await collectStats(t, KEY, 1767225600 + 660);
        expect(requests).toBe(8);
        expect(r3.snapshotText).toContain("本周：未知");
        resetStatsCooldownForTest();
    });

    it("AC5：全部周期失败 → 快照全未知，不抛错", async () => {
        const t = fakeTransport(new Set(["weekly", "monthly", "annually", "overall"]));
        const r = await collectStats(t, KEY, 1767225600);
        expect(r.snapshotText).toContain("本周：未知");
        expect(r.heatmapYear.source).toBe("none");
    });

    it("PR12[1] 回归：年份选择只作用于 annual 请求 baseTime（历史年=该年 1/1 UTC；默认当前年显式传年初）", async () => {
        resetStatsCooldownForTest();
        const calls: Array<{ mode: string; baseTime?: number }> = [];
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    calls.push({ mode: String(req.mode), baseTime: typeof req.baseTime === "number" ? req.baseTime : undefined });
                    return { status: 200, body: JSON.stringify({ errcode: 0, totalReadTime: 60 }), contentType: "application/json" };
                }
                return { status: 200, body: JSON.stringify({ errcode: -1 }), contentType: "application/json" };
            },
        };
        const now = 1767225600; // 2026-01-01 UTC
        await collectStats(t, KEY, now, 2024); // 选历史年 2024
        const byMode = (m: string): Array<number | undefined> => calls.filter((c) => c.mode === m).map((c) => c.baseTime);
        expect(byMode("annually")).toEqual([Date.UTC(2024, 0, 1) / 1000]);
        expect(byMode("weekly")).toEqual([now]); // 周/月仍按当前日期（当期口径）
        expect(byMode("monthly")).toEqual([now]);
        expect(byMode("overall")).toEqual([0]);
        calls.length = 0;
        await collectStats(t, KEY, now); // 默认当前年：保持现状（显式传当年年初）
        expect(byMode("annually")).toEqual([Date.UTC(2026, 0, 1) / 1000]);
        resetStatsCooldownForTest();
    });

    it("PR12[4] 回归：冷却期内被跳过的调用不延长冷却截止时间", async () => {
        resetStatsCooldownForTest();
        let requests = 0;
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    requests += 1;
                    return { status: 200, body: JSON.stringify({ errcode: 1, errmsg: "失败" }), contentType: "application/json" };
                }
                return { status: 200, body: JSON.stringify({ errcode: 0 }), contentType: "application/json" };
            },
        };
        const t0 = 1767225600;
        await collectStats(t, KEY, t0); // 四周期整败 → 冷却至 t0+600s
        expect(requests).toBe(4);
        expect(statsInCooldown((t0 + 599) * 1000)).toBe(true);
        await collectStats(t, KEY, t0 + 300); // 冷却期内：跳过（不发请求），不得延长截止
        expect(requests).toBe(4);
        expect(statsInCooldown((t0 + 599) * 1000)).toBe(true);
        expect(statsInCooldown((t0 + 601) * 1000)).toBe(false); // 原截止时间原样生效
        resetStatsCooldownForTest();
    });

    it("PR12[5]：upgrade_info 立即暂停——仅一次请求、升级错误向上透出、不进入冷却", async () => {
        resetStatsCooldownForTest();
        let requests = 0;
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    requests += 1;
                    return {
                        status: 200,
                        body: JSON.stringify({ errcode: 0, upgrade_info: { message: "请升级微信读书技能版本后重试" } }),
                        contentType: "application/json",
                    };
                }
                return { status: 200, body: JSON.stringify({ errcode: 0 }), contentType: "application/json" };
            },
        };
        const p = collectStats(t, KEY, 1767225600);
        await expect(p).rejects.toBeInstanceOf(UpgradeRequiredError);
        await expect(p).rejects.toThrow("请升级微信读书技能版本后重试"); // 升级指引可见（对话框 error / 引擎异常项）
        expect(requests).toBe(1); // 首个请求见 upgrade_info 即停，不再请求剩余周期
        expect(statsInCooldown(1767225600 * 1000)).toBe(false); // 升级非瞬时失败：不得被冷却降级掩盖
        resetStatsCooldownForTest();
    });

    it("PR12[7]：选历史年份时快照按该年标注年度与连续；周/月保持当期标签", async () => {
        resetStatsCooldownForTest();
        const day = Date.UTC(2024, 0, 1) / 1000;
        const daily: Record<string, number> = { [String(day)]: 600, [String(day + 86400)]: 600 };
        const t: Transport = {
            async post(_url, body) {
                void _url;
                const req = body as Record<string, unknown>;
                if (req.api_name === "/readdata/detail") {
                    return {
                        status: 200,
                        body: JSON.stringify({
                            errcode: 0,
                            totalReadTime: 3600,
                            readDays: 2,
                            dailyReadTimes: req.mode === "annually" ? daily : undefined,
                        }),
                        contentType: "application/json",
                    };
                }
                return { status: 200, body: JSON.stringify({ errcode: 0 }), contentType: "application/json" };
            },
        };
        const r = await collectStats(t, KEY, 1767225600, 2024); // 当前 2026，选 2024
        expect(r.heatmapYear.year).toBe(2024);
        expect(r.snapshotText).toContain("2024 年：1小时 · 2天");
        expect(r.snapshotText).toContain("2024 年最长连续：2天");
        expect(r.snapshotText).toContain("本周：");
        expect(r.snapshotText).not.toContain("本年：");
        expect(r.snapshotText).not.toContain("本年最长连续");
        resetStatsCooldownForTest();
    });
});

describe("T05 统计对话框加载状态机（PR12[9]：请求代际守卫）", () => {
    it("旧请求（历史年）晚于新请求（当前年）完成 → 丢弃旧结果，不得覆盖新结果", () => {
        let s = initialDialogLoadState<{ year: number }>();
        s = beginDialogLoad(s); // 历史年请求
        const stale = s.generation;
        s = beginDialogLoad(s); // 加载中刷新 → 当前年请求（最新代）
        const fresh = s.generation;
        expect(s.loading).toBe(true);
        expect(s.error).toBe("");
        // 新请求先完成：正常落位
        s = settleDialogLoad(s, fresh, { ok: true, value: { year: 2026 } });
        expect(s.loading).toBe(false);
        expect(s.result).toEqual({ year: 2026 });
        // 旧请求随后完成：必须整批丢弃（不得回写 2024、不得改 loading/error）
        const before = s;
        s = settleDialogLoad(s, stale, { ok: true, value: { year: 2024 } });
        expect(s).toBe(before);
        expect(s.result).toEqual({ year: 2026 });
        expect(s.loading).toBe(false);
    });

    it("旧请求先完成 → 不得提前清 loading（新请求仍在途），也不得写入旧结果", () => {
        let s = initialDialogLoadState<{ year: number }>();
        s = beginDialogLoad(s); // 历史年请求（慢）
        const stale = s.generation;
        s = beginDialogLoad(s); // 刷新 → 当前年请求（快）
        const fresh = s.generation;
        s = settleDialogLoad(s, stale, { ok: true, value: { year: 2024 } }); // 旧请求先回
        expect(s.loading).toBe(true); // 仍有一个在途请求：loading 不得被旧代际清掉
        expect(s.result).toBeNull(); // 旧结果不得写入
        s = settleDialogLoad(s, fresh, { ok: true, value: { year: 2026 } });
        expect(s.loading).toBe(false);
        expect(s.result).toEqual({ year: 2026 });
    });

    it("最新代失败 → error 可见且保留既有结果；旧代失败/成功 → 均被丢弃", () => {
        let st = initialDialogLoadState<{ year: number }>();
        st = beginDialogLoad(st);
        const stale = st.generation;
        st = beginDialogLoad(st);
        const fresh = st.generation;
        st = settleDialogLoad(st, fresh, { ok: false, message: "微信读书接口要求升级：请升级" });
        expect(st.loading).toBe(false);
        expect(st.error).toBe("微信读书接口要求升级：请升级");
        expect(st.result).toBeNull(); // 失败不伪造结果
        const snapshot = st;
        st = settleDialogLoad(st, stale, { ok: false, message: "旧请求失败" });
        expect(st).toBe(snapshot); // 旧代错误不得覆盖新代状态
        expect(st.error).toBe("微信读书接口要求升级：请升级");
    });

    it("beginDialogLoad：清空上次 error、进入 loading、保留旧结果供展示；代际单调递增", () => {
        let s = initialDialogLoadState<{ year: number }>();
        expect(s).toEqual({ generation: 0, loading: false, result: null, error: "" });
        s = { ...s, result: { year: 2025 }, error: "旧错误" };
        s = beginDialogLoad(s);
        expect(s.generation).toBe(1);
        expect(s.loading).toBe(true);
        expect(s.error).toBe("");
        expect(s.result).toEqual({ year: 2025 }); // 加载中仍显示旧快照
        s = beginDialogLoad(s);
        expect(s.generation).toBe(2);
    });
});
