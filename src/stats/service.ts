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
): Promise<ReaddataDetail> {
    const obj = await executeGatewayCall(transport, apiKey, "/readdata/detail", { mode });
    return parseDetail(obj);
}

/** 拉四周期 + 本年热力图 + 快照文本；任一周期失败 → 该周期 undefined（热力图仍尽力）。 */
export async function collectStats(
    transport: Transport,
    apiKey: string,
    nowSeconds: number,
    year?: number,
): Promise<StatsResult> {
    const [weekly, monthly, annually, overall] = await Promise.all(
        (["weekly", "monthly", "annually", "overall"] as const).map(async (mode) => {
            try {
                return await fetchReaddata(transport, apiKey, mode);
            } catch {
                return undefined;
            }
        }),
    );
    const y = year ?? new Date(nowSeconds * 1000).getUTCFullYear();
    const heatmapYear = buildHeatmapYear(
        y,
        annually?.dailyReadTimes,
        annually?.readTimes,
        nowSeconds,
    );
    const snapshotText = renderStatsSnapshot({
        weekly: weekly === undefined ? undefined : { label: "本周", totalSeconds: weekly.totalReadTime, readDays: weekly.readDays },
        monthly: monthly === undefined ? undefined : { label: "本月", totalSeconds: monthly.totalReadTime, readDays: monthly.readDays },
        annually: annually === undefined ? undefined : { label: "本年", totalSeconds: annually.totalReadTime, readDays: annually.readDays },
        overall: overall === undefined ? undefined : { label: "累计", totalSeconds: overall.totalReadTime },
        yearStreak: heatmapYear.source === "daily" ? streakDays(heatmapYear.days) : undefined,
        generatedAtIso: new Date(nowSeconds * 1000).toISOString(),
        notes: heatmapYear.source === "none" ? "年度日明细缺失，热力图暂不可用" : undefined,
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
