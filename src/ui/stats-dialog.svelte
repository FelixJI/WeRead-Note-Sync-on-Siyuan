<script lang="ts">
    /**
     * T05 阅读统计对话框（Svelte 5）：周期摘要 + 年度热力图（轻量 SVG）。
     * - 数据经注入的 loadData（collectStats）；远端数值纯文本插值（零 @html）。
     * - 热力图区分 value/zero/unknown/future（不只靠颜色：unknown 带纹理符号、future 空白+说明）。
     * - 年份切换重新加载；年份提示经 title 属性（无悬浮环境亦可见文本行）。
     * - PR12[9]：请求代际守卫（纯状态机在 stats/pure，可独立测试）——加载中禁用刷新，
     *   且旧请求（历史年）即使晚于新请求完成也无法覆盖新结果/提前清 loading。
     */
    import type { StatsResult } from "../stats/service";
    import {
        beginDialogLoad,
        formatDuration,
        formatProgress,
        initialDialogLoadState,
        settleDialogLoad,
        type DialogLoadState,
    } from "../stats/pure";

    export interface BookStatRow {
        title: string;
        totalSeconds?: number;
        progressPercent?: number;
    }

    interface Props {
        i18n: Record<string, string>;
        loadData: (year?: number) => Promise<StatsResult>;
        loadBooks?: () => Promise<BookStatRow[]>;
        onClose: () => void;
    }

    let { i18n, loadData, loadBooks, onClose }: Props = $props();

    let books = $state<BookStatRow[]>([]);
    let loadState = $state<DialogLoadState<StatsResult>>(initialDialogLoadState());
    const loading = $derived(loadState.loading);
    const error = $derived(loadState.error);
    const result = $derived(loadState.result);

    const levelOf = (seconds: number): number =>
        seconds === 0 ? 0 : seconds < 1800 ? 1 : seconds < 3600 ? 2 : seconds < 10800 ? 3 : 4;

    const KIND_FILL: Record<string, string> = {
        value: "var(--b3-theme-primary)",
        zero: "var(--b3-theme-surface)",
        unknown: "transparent",
        future: "transparent",
    };

    async function load(year?: number): Promise<void> {
        loadState = beginDialogLoad(loadState);
        const generation = loadState.generation; // 本次请求的代际：完成后仅当仍是最新才回写
        try {
            const value = await loadData(year);
            loadState = settleDialogLoad(loadState, generation, { ok: true, value });
        } catch (e) {
            loadState = settleDialogLoad(loadState, generation, { ok: false, message: (e as Error).message });
        }
    }

    void load(undefined);
    if (loadBooks !== undefined) {
        void loadBooks().then((rows) => {
            books = rows;
        });
    }
</script>

<div class="wrns-stats">
    <div class="wrns-stats-head">
        <h3 class="wrns-stats-title">{i18n.statsTitle}</h3>
        <div class="wrns-stats-actions">
            <button type="button" class="b3-button b3-button--outline" disabled={loading || result === null || result.heatmapYear.year <= 2010}
                onclick={() => void load((result?.heatmapYear.year ?? 2026) - 1)}>← {i18n.statsPrevYear}</button>
            <span class="wrns-stats-year">{result?.heatmapYear.year ?? "…"}</span>
            <button type="button" class="b3-button b3-button--outline" disabled={loading || (result !== null && result.heatmapYear.year >= new Date().getUTCFullYear())}
                onclick={() => void load((result?.heatmapYear.year ?? 2025) + 1)}>{i18n.statsNextYear} →</button>
            <button type="button" class="b3-button b3-button--outline" disabled={loading} onclick={() => void load(undefined)}>{i18n.statsRefresh}</button>
            <button type="button" class="b3-button b3-button--cancel" onclick={onClose}>✕</button>
        </div>
    </div>

    {#if loading}
        <p>{i18n.statsLoading}</p>
    {/if}
    {#if error.length > 0}
        <p class="wrns-stats-error">{error}</p>
    {/if}

    {#if books.length > 0}
        <div class="wrns-stats-books">
            <h4 class="wrns-stats-subtitle">{i18n.statsBookTimes}</h4>
            <ul class="wrns-stats-booklist">
                {#each books as b}
                    <li><span class="wrns-stats-book-title">{b.title}</span>
                        <span class="wrns-stats-book-meta">{formatDuration(b.totalSeconds)} · {formatProgress(b.progressPercent).text}{formatProgress(b.progressPercent).finished ? " · 读完" : ""}</span></li>
                {/each}
            </ul>
        </div>
    {/if}
    {#if result !== null}
        <pre class="wrns-stats-snapshot">{result.snapshotText}</pre>
        {#if result.heatmapYear.source === "none"}
            <p class="wrns-stats-note">{i18n.statsNoDaily}</p>
        {:else if result.heatmapYear.source === "monthly"}
            <p class="wrns-stats-note">{i18n.statsMonthlyOnly}</p>
        {/if}
        {#if result.heatmapYear.source === "daily"}
            <svg class="wrns-stats-heatmap" viewBox="0 0 {53 * 13} {7 * 13 + 2}" role="img" aria-label="heatmap">
                {#each result.heatmapYear.days as day, i}
                    {#if day.kind === "value"}
                        <rect x={(Math.floor(i / 7)) * 13} y={(i % 7) * 13 + 1} width="11" height="11" rx="2"
                            fill={KIND_FILL[day.kind]} fill-opacity={0.25 + levelOf(day.seconds) * 0.1875}>
                            <title>{day.date} · {Math.floor(day.seconds / 60)} 分钟</title>
                        </rect>
                    {:else if day.kind === "zero"}
                        <rect x={(Math.floor(i / 7)) * 13} y={(i % 7) * 13 + 1} width="11" height="11" rx="2"
                            fill="var(--b3-theme-surface)">
                            <title>{day.date} · 0</title>
                        </rect>
                    {:else if day.kind === "unknown"}
                        <rect x={(Math.floor(i / 7)) * 13} y={(i % 7) * 13 + 1} width="11" height="11" rx="2"
                            fill="transparent" stroke="var(--b3-border-color)" stroke-dasharray="2 2">
                            <title>{day.date} · {i18n.statsUnknownDay}</title>
                        </rect>
                    {/if}
                {/each}
            </svg>
            <p class="wrns-stats-legend">
                {i18n.statsLegend}: ■ {i18n.statsLegendValue} · ▢ {i18n.statsLegendZero} · ⬚ {i18n.statsLegendUnknown} · {i18n.statsLegendFuture}
            </p>
        {/if}
    {/if}
</div>

<style>
    .wrns-stats { display: flex; flex-direction: column; gap: 10px; padding: 8px 4px; color: var(--b3-theme-on-background); }
    .wrns-stats-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .wrns-stats-title { margin: 0; font-size: 16px; }
    .wrns-stats-actions { display: flex; align-items: center; gap: 6px; }
    .wrns-stats-year { min-width: 3.5em; text-align: center; font-weight: 600; }
    .wrns-stats-snapshot { margin: 0; padding: 8px 12px; background: var(--b3-theme-surface); border-radius: 6px;
        font-family: inherit; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .wrns-stats-heatmap { width: 100%; max-width: 760px; height: auto; }
    .wrns-stats-note, .wrns-stats-legend, .wrns-stats-error { margin: 0; font-size: 12px; color: var(--b3-theme-on-surface); }
    .wrns-stats-error { color: var(--b3-card-error-color, #d23f31); }
    .wrns-stats-subtitle { margin: 4px 0 0; font-size: 13px; }
    .wrns-stats-booklist { margin: 4px 0 0; padding: 0 0 0 18px; font-size: 13px; }
    .wrns-stats-booklist li { margin: 2px 0; }
    .wrns-stats-book-title { font-weight: 500; margin-right: 8px; }
    .wrns-stats-book-meta { color: var(--b3-theme-on-surface); }
    @media (max-width: 720px) { .wrns-stats-head { flex-direction: column; align-items: stretch; } }
</style>
