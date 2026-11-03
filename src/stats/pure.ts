/**
 * T05 统计纯函数层（docs 契约：单位统一秒、区分零/未知/未来、日桶按服务端时间戳 UTC 日切）。
 * 全部纯函数、确定性；不访问网络。
 */

/** 秒 → "X小时Y分钟"（<1 分钟显示 "X秒"；负数/NaN → "未知"）。 */
export function formatDuration(totalSeconds: number | undefined): string {
    if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return "未知";
    }
    const s = Math.floor(totalSeconds);
    if (s < 60) {
        return `${s}秒`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) {
        return `${m}分钟`;
    }
    return m === 0 ? `${h}小时` : `${h}小时${m}分钟`;
}

/** 进度 0-100 整数 → "45%"；仅 100 视为读完（契约：1=1%）。 */
export function formatProgress(progress: number | undefined): { text: string; finished: boolean } {
    if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) {
        return { text: "不可用", finished: false };
    }
    const p = Math.min(100, Math.floor(progress));
    return { text: `${p}%`, finished: p === 100 };
}

/** Unix 秒 → UTC "YYYY-MM-DD"。 */
export function utcDateKey(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export type DayKind = "zero" | "unknown" | "future" | "value";

export interface HeatmapDay {
    date: string; // YYYY-MM-DD
    seconds: number;
    kind: DayKind;
}

export interface HeatmapYear {
    year: number;
    days: HeatmapDay[];
    /** 数据完整性：true=全部 365/366 天均有日级数据 */
    complete: boolean;
    /** 覆盖日数（有日明细的天数） */
    coveredDays: number;
    /** 数据来源：daily=年度日明细补月桶 / monthly=仅月桶（不绘制假日热力图）/ none */
    source: "daily" | "monthly" | "none";
}

const MS_DAY = 86400;
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number): number => (isLeap(y) ? 366 : 365);

/**
 * 构建某年热力图日桶。
 * - dailyReadTimes：`/readdata/detail` annually 的 dailyReadTimes（key=日起始秒，value=秒）
 * - monthlyReadTimes：annually 的 readTimes（按月桶）——仅当日明细缺失时用于"完整性=月级"标注
 * - nowSeconds：用于"未来日期"判定（> 今日的桶标 future）
 * 未覆盖的日（既无日明细、也无月桶含该日）→ unknown（不伪造 0，AC2/AC3）。
 */
export function buildHeatmapYear(
    year: number,
    dailyReadTimes: Record<string, number> | undefined,
    monthlyReadTimes: Record<string, number> | undefined,
    nowSeconds: number,
): HeatmapYear {
    const start = Date.UTC(year, 0, 1) / 1000;
    const total = daysInYear(year);
    const todayKey = utcDateKey(nowSeconds);
    const days: HeatmapDay[] = [];
    let covered = 0;
    const monthHasData = new Set<string>();
    if (monthlyReadTimes !== undefined) {
        for (const k of Object.keys(monthlyReadTimes)) {
            const n = Number(k);
            if (Number.isFinite(n)) {
                monthHasData.add(utcDateKey(n).slice(0, 7));
            }
        }
    }
    for (let i = 0; i < total; i += 1) {
        const dayStart = start + i * MS_DAY;
        const date = utcDateKey(dayStart);
        if (date > todayKey) {
            days.push({ date, seconds: 0, kind: "future" });
            continue;
        }
        const value = dailyReadTimes?.[String(dayStart)];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            days.push({ date, seconds: Math.floor(value), kind: value === 0 ? "zero" : "value" });
            covered += 1;
            continue;
        }
        if (monthHasData.has(date.slice(0, 7))) {
            // 月桶含该日但无日明细：未知（不以月均摊伪造日值，AC2）
            days.push({ date, seconds: 0, kind: "unknown" });
            continue;
        }
        days.push({ date, seconds: 0, kind: "unknown" });
    }
    return {
        year,
        days,
        complete: covered === total,
        coveredDays: covered,
        source: covered > 0 ? "daily" : monthlyReadTimes !== undefined && Object.keys(monthlyReadTimes).length > 0 ? "monthly" : "none",
    };
}

/** 连续阅读天数：仅统计 kind==="value" 的连续段（unknown 断链不计，AC3 不伪造）。 */
export function streakDays(days: HeatmapDay[]): number {
    let best = 0;
    let cur = 0;
    for (const d of days) {
        if (d.kind === "value") {
            cur += 1;
            best = Math.max(best, cur);
        } else if (d.kind === "unknown") {
            // 未知中断连续性判定（保守：不把未知当阅读日，也不断言停止——重开计数）
            cur = 0;
        } else {
            cur = 0;
        }
    }
    return best;
}

/** 周期摘要文本（原生快照用）：单位秒→人类可读；缺失→"未知"。 */
export interface PeriodSummary {
    label: string;
    totalSeconds?: number;
    readDays?: number;
}

export function renderStatsSnapshot(parts: {
    weekly?: PeriodSummary;
    monthly?: PeriodSummary;
    annually?: PeriodSummary;
    overall?: PeriodSummary;
    yearStreak?: number;
    generatedAtIso: string;
    notes?: string;
}): string {
    const line = (p: PeriodSummary | undefined): string =>
        p === undefined
            ? "未知"
            : `${formatDuration(p.totalSeconds)}${p.readDays !== undefined ? ` · ${p.readDays}天` : ""}`;
    return [
        `**阅读时长（含收听）**`,
        `- 本周：${line(parts.weekly)}`,
        `- 本月：${line(parts.monthly)}`,
        `- 本年：${line(parts.annually)}`,
        `- 累计：${line(parts.overall)}`,
        parts.yearStreak !== undefined ? `- 本年最长连续：${parts.yearStreak}天` : "",
        parts.notes !== undefined ? `- ${parts.notes}` : "",
        `> 口径：微信读书统计；单位秒。生成于 ${parts.generatedAtIso}。`,
    ]
        .filter((l) => l.length > 0)
        .join("\n");
}
