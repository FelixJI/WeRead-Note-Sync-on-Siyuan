/**
 * T05 统计服务：拉取 /readdata/detail（四周期）、构建热力图、渲染总览 stats 槽位快照文本。
 * 失败独立上报（statsError），绝不回滚/影响笔记同步（AC5）。
 */
import type { Transport } from "../core/net/transport";
import { executeGatewayCall } from "../adapters/weread/gateway";
import {
    buildHeatmapYear,
    renderStatsSnapshot,
    streakDays,
    type HeatmapYear,
} from "./pure";

export interface ReaddataDetail {
    baseTime?: number;
    totalReadTime?: number;
    readDays?: number;
    /** 分桶：weekly/monthly 按天；annually 按月 */
    readTimes?: Record<string, number>;
    /** 年度日明细（可选） */
    dailyReadTimes?: Record<string, number>;
}

export interface StatsResult {
    weekly?: ReaddataDetail;
    monthly?: ReaddataDetail;
    annually?: ReaddataDetail;
    overall?: ReaddataDetail;
    heatmapYear: HeatmapYear;
    snapshotText: string;
    fetchedAtIso: string;
}

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapObj(v: unknown): Record<string, number> | undefined {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return undefined;
    }
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const n = num(val);
        if (n !== undefined) {
            out[k] = n;
        }
    }
    return out;
}

function parseDetail(obj: Record<string, unknown>): ReaddataDetail {
    return {
        baseTime: num(obj.baseTime),
        totalReadTime: num(obj.totalReadTime),
        readDays: num(obj.readDays),
        readTimes: mapObj(obj.readTimes),
        dailyReadTimes: mapObj(obj.dailyReadTimes),
    };
}

export async function fetchReaddata(
    transport: Transport,
    apiKey: string,
    mode: "weekly" | "monthly" | "annually" | "overall",
    baseTime?: number,
): Promise<ReaddataDetail> {
    // 审阅整改 MAJOR-1：显式传 baseTime（契约关键参数），消除网关默认值依赖
    const params: Record<string, unknown> = { mode };
    if (baseTime !== undefined) {
        params.baseTime = baseTime;
    }
    const obj = await executeGatewayCall(transport, apiKey, "/readdata/detail", params);
    return parseDetail(obj);
}

/** 单书累计（/book/getprogress：recordReadingTime 秒 + progress 0-100）——审阅整改 MAJOR-2 */
export interface BookProgress {
    bookId: string;
    totalSeconds?: number;
    progressPercent?: number;
}

export async function fetchBookProgress(transport: Transport, apiKey: string, bookId: string): Promise<BookProgress> {
    const obj = await executeGatewayCall(transport, apiKey, "/book/getprogress", { bookId });
    const book = typeof obj.book === "object" && obj.book !== null ? (obj.book as Record<string, unknown>) : {};
    const t = typeof book.recordReadingTime === "number" && Number.isFinite(book.recordReadingTime) ? book.recordReadingTime : undefined;
    const pr = typeof book.progress === "number" && Number.isFinite(book.progress) ? book.progress : undefined;
    return { bookId, totalSeconds: t, progressPercent: pr };
}

/** 有界退避（审阅整改 MINOR-4）：连续整败后 10 分钟内跳过统计调用 */
let statsCooldownUntil = 0;
const STATS_COOLDOWN_MS = 10 * 60 * 1000;

export function statsInCooldown(nowMs: number): boolean {
    return nowMs < statsCooldownUntil;
}

/** 测试钩子：重置冷却状态（避免模块级全局态的顺序敏感） */
export function resetStatsCooldownForTest(): void {
    statsCooldownUntil = 0;
}

/** 拉四周期 + 本年热力图 + 快照文本；任一周期失败 → 该周期 undefined（热力图仍尽力）。 */
export async function collectStats(
    transport: Transport,
    apiKey: string,
    nowSeconds: number,
    year?: number,
): Promise<StatsResult> {
    const nowMs = nowSeconds * 1000;
    const inCooldown = statsInCooldown(nowMs);
    const currentYear = new Date(nowMs).getUTCFullYear();
    const y = year ?? currentYear;
    // 串行拉取（MINOR-4：避免 4 并发在 429 风暴时放大请求）
    const fetchOr = async (mode: "weekly" | "monthly" | "annually" | "overall", baseTime?: number) => {
        try {
            return await fetchReaddata(transport, apiKey, mode, baseTime);
        } catch {
            return undefined;
        }
    };
    const weekly = inCooldown ? undefined : await fetchOr("weekly", nowSeconds);
    const monthly = inCooldown ? undefined : await fetchOr("monthly", nowSeconds);
    const overall = inCooldown ? undefined : await fetchOr("overall", 0);
    // MAJOR-1：历史年份用该年 1 月 1 日 UTC 作 baseTime 重取；当年显式传 baseTime
    const yearStart = Date.UTC(y, 0, 1) / 1000;
    const annually = inCooldown ? undefined : await fetchOr("annually", yearStart);
    let heatmapYear = buildHeatmapYear(y, annually?.dailyReadTimes, annually?.readTimes, nowSeconds);
    // 复核随行：!inCooldown 守卫——冷却期内不发请求（四者恒 undefined），
    // 若无守卫每次调用都会重置冷却导致"再武装死锁"（永远无法恢复）
    if (
        !inCooldown &&
        weekly === undefined &&
        monthly === undefined &&
        annually === undefined &&
        overall === undefined
    ) {
        statsCooldownUntil = nowMs + STATS_COOLDOWN_MS; // 四周期整败才进入冷却（有界退避、可自然退出）
    }
    const snapshotText = renderStatsSnapshot({
        weekly: weekly === undefined ? undefined : { label: "本周", totalSeconds: weekly.totalReadTime, readDays: weekly.readDays },
        monthly: monthly === undefined ? undefined : { label: "本月", totalSeconds: monthly.totalReadTime, readDays: monthly.readDays },
        annually: annually === undefined ? undefined : { label: "本年", totalSeconds: annually.totalReadTime, readDays: annually.readDays },
        overall: overall === undefined ? undefined : { label: "累计", totalSeconds: overall.totalReadTime },
        yearStreak: heatmapYear.source === "daily" ? streakDays(heatmapYear.days) : undefined,
        generatedAtIso: new Date(nowSeconds * 1000).toISOString(),
        notes: inCooldown
            ? "统计冷却中（近期连续失败，10 分钟后自动重试；不影响笔记同步）"
            : heatmapYear.source === "none"
              ? "年度日明细缺失，热力图暂不可用"
              : undefined,
    });
    return {
        weekly,
        monthly,
        annually,
        overall,
        heatmapYear,
        snapshotText,
        fetchedAtIso: new Date(nowSeconds * 1000).toISOString(),
    };
}
