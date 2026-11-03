<script lang="ts">
    /**
     * 审阅变更对话框主体（由 review-dialog.svelte 的 mountReviewDialog 挂载，props 同构）。
     *
     * - 数据：mount 时 buildReviewQueue()（冻结接口，主代理装配），按书分组 + 筛选（全部/仅冲突/仅远端变化）+ 计数徽标。
     * - 展示：每条目三段（基线默认折叠可展开 / 本地现状 / 远端版本）+ local vs remote 行内字符级 diff
     *   （diffChars；insert "+" 前缀实线下划线、delete "-" 前缀删除线，双色但信息不依赖颜色，AC5）；
     *   容器 ≥720px 双栏对照、窄屏单栏（CSS container query，scoped）。
     * - 决策：逐条独立操作，无批量全选（AC5）；apply-remote/keep-local/manual-merge/save-copy 经 applyDecision：
     *   ok → 从队列移除；stale → 该条目提示"内容已变化，已重新加载 diff"并 buildReviewQueue 刷新该条（不自动应用，AC4）；
     *   其他失败 → 显示已脱敏 message，条目保留；defer 仅 UI 分组留存（持久化状态不变）。
     * - 安全：远端/本地/基线文本一律 {text} 纯文本插值，零 @html；样式 scoped + var(--b3-*)，深浅色自适应。
     */
    import { onMount } from "svelte";
    import { applyDecision, buildReviewQueue } from "../queue";
    import DiffView from "./diff-view.svelte";
    import {
        CONFLICT_BADGE_KEY,
        KIND_BADGE_KEY,
        applyFreshItem,
        countItems,
        filterItems,
        formatDetectedAt,
        groupByBook,
        toItemView,
        type ExecutableAction,
        type ReviewFilter,
        type ReviewItemView,
    } from "./view-model";
    import type { SettingsText } from "../../settings/i18n";

    interface Props {
        text: SettingsText;
        onClose: () => void;
    }

    let { text, onClose }: Props = $props();

    let loading: boolean = $state(true);
    let loadError: boolean = $state(false);
    let items: ReviewItemView[] = $state([]);
    let deferred: ReviewItemView[] = $state([]);
    let deferredOpen: boolean = $state(false);
    let filter: ReviewFilter = $state("all");

    const counts = $derived(countItems(items));
    const visible = $derived(filterItems(items, filter));
    const groups = $derived(groupByBook(visible));

    onMount(() => {
        void loadQueue();
    });

    /** 重新拉取整队（刷新/初次加载）。defer 为纯 UI 分组，刷新后回到待审列表（持久化状态未动）。 */
    async function loadQueue(): Promise<void> {
        loading = true;
        loadError = false;
        try {
            const queue = await buildReviewQueue();
            items = queue.items.map(toItemView);
            deferred = [];
            deferredOpen = false;
        } catch {
            loadError = true;
        } finally {
            loading = false;
        }
    }

    function removeView(sourceKey: string): void {
        items = items.filter((item) => item.sourceKey !== sourceKey);
        deferred = deferred.filter((item) => item.sourceKey !== sourceKey);
    }

    /** 稍后处理：仅 UI 分组留存，不调用 applyDecision，持久化状态不变（设计 §2 defer 语义）。 */
    function deferItem(item: ReviewItemView): void {
        if (item.busy) {
            return;
        }
        items = items.filter((i) => i.sourceKey !== item.sourceKey);
        deferred = [...deferred, item];
    }

    function restoreItem(item: ReviewItemView): void {
        deferred = deferred.filter((i) => i.sourceKey !== item.sourceKey);
        items = [...items, item];
    }

    /** stale 专用：重建队列并就地刷新该条目（diff 重算，不自动应用，AC4）。 */
    async function refreshItem(item: ReviewItemView, notice: string): Promise<void> {
        try {
            const queue = await buildReviewQueue();
            const fresh = queue.items.find((candidate) => candidate.sourceKey === item.sourceKey);
            if (fresh === undefined) {
                // 队列中已不存在（他处已决策/清理）——按已处理对待
                removeView(item.sourceKey);
                return;
            }
            applyFreshItem(item, fresh);
            item.notice = notice;
            item.noticeKind = "info";
        } catch {
            item.notice = text.reviewLoadError;
            item.noticeKind = "error";
        }
    }

    /** 条目级决策执行（防重入：busy 期间该条按钮全禁用）。 */
    async function runDecision(item: ReviewItemView, action: ExecutableAction, manualText?: string): Promise<void> {
        if (item.busy) {
            return;
        }
        item.busy = true;
        item.notice = "";
        item.noticeKind = "info";
        try {
            const result = await applyDecision(item.sourceKey, action, manualText);
            if (result.ok) {
                removeView(item.sourceKey);
                return;
            }
            if (result.kind === "stale") {
                // 过期计划：刷新 diff，交还用户重审，不自动应用（AC4）
                await refreshItem(item, text.reviewStaleNotice);
            } else {
                // message 已由底层脱敏；条目保留供重试
                item.notice = `${text.reviewApplyFailedPrefix}${result.message}`;
                item.noticeKind = "error";
            }
        } catch (e) {
            item.notice = `${text.reviewApplyFailedPrefix}${e instanceof Error ? e.message : ""}`;
            item.noticeKind = "error";
        } finally {
            item.busy = false;
        }
    }

    /** 打开手动合并编辑器：预填远端文本。 */
    function startManual(item: ReviewItemView): void {
        if (item.busy) {
            return;
        }
        item.editing = true;
        item.manualText = item.remote;
        item.notice = "";
    }

    function cancelManual(item: ReviewItemView): void {
        if (item.busy) {
            return;
        }
        item.editing = false;
    }

    /** 定位原块：打开思源块（协议由主环境处理）。 */
    function locateBlock(item: ReviewItemView): void {
        window.open(`siyuan://blocks/${item.blockId}`, "_blank");
    }
</script>

<div class="wrns-rv-root">
    <header class="wrns-rv-head">
        <h2 class="wrns-rv-title">{text.reviewDialogTitle} <span class="wrns-rv-count">({counts.total})</span></h2>
        <button type="button" class="b3-button b3-button--cancel" onclick={onClose}>{text.reviewClose}</button>
    </header>

    <div class="wrns-rv-toolbar">
        <div class="wrns-rv-filters" role="group">
            <button
                type="button"
                class="b3-button b3-button--outline wrns-rv-filter"
                class:wrns-rv-filter-on={filter === "all"}
                aria-pressed={filter === "all"}
                onclick={() => (filter = "all")}
            >{text.reviewFilterAll} ({counts.total})</button>
            <button
                type="button"
                class="b3-button b3-button--outline wrns-rv-filter"
                class:wrns-rv-filter-on={filter === "both-changed"}
                aria-pressed={filter === "both-changed"}
                onclick={() => (filter = "both-changed")}
            >{text.reviewFilterBothChanged} ({counts.bothChanged})</button>
            <button
                type="button"
                class="b3-button b3-button--outline wrns-rv-filter"
                class:wrns-rv-filter-on={filter === "remote-only"}
                aria-pressed={filter === "remote-only"}
                onclick={() => (filter = "remote-only")}
            >{text.reviewFilterRemoteOnly} ({counts.remoteOnly})</button>
        </div>
        <button
            type="button"
            class="b3-button b3-button--outline"
            disabled={loading}
            onclick={() => void loadQueue()}
        >{loading ? text.reviewBusy : text.reviewRefresh}</button>
    </div>

    {#if !loading && items.length > 0}
        <p class="wrns-rv-legend">{text.reviewDiffHint}</p>
    {/if}

    <div class="wrns-rv-list">
        {#if loading}
            <p class="wrns-rv-state" role="status">{text.reviewLoading}</p>
        {:else if loadError}
            <p class="wrns-rv-state wrns-rv-state-error" role="alert">{text.reviewLoadError}</p>
        {:else if items.length === 0}
            <p class="wrns-rv-state">{text.reviewEmpty}</p>
        {:else if groups.length === 0}
            <p class="wrns-rv-state">{text.reviewNoMatchFilter}</p>
        {:else}
            {#each groups as group (group.bookId)}
                <section class="wrns-rv-book">
                    <h3 class="wrns-rv-book-title">{group.bookTitle} <span class="wrns-rv-count">({group.items.length})</span></h3>
                    {#each group.items as item (item.sourceKey)}
                        <article class="wrns-rv-card">
                            <header class="wrns-rv-card-head">
                                <div class="wrns-rv-tags">
                                    <span class="wrns-rv-badge">{text[KIND_BADGE_KEY[item.kind]]}</span>
                                    <span class="wrns-rv-badge wrns-rv-badge-{item.conflict}">
                                        {text[CONFLICT_BADGE_KEY[item.conflict]]}
                                    </span>
                                    <code class="wrns-rv-src">{item.sourceKey}</code>
                                </div>
                                <div class="wrns-rv-meta">
                                    {#if formatDetectedAt(item.detectedAt).length > 0}
                                        <span class="wrns-rv-time">{text.reviewDetectedAt}: {formatDetectedAt(item.detectedAt)}</span>
                                    {/if}
                                    <button
                                        type="button"
                                        class="b3-button b3-button--text"
                                        disabled={item.busy}
                                        onclick={() => locateBlock(item)}
                                    >{text.reviewLocateBlock}</button>
                                </div>
                            </header>

                            <div class="wrns-rv-baseline">
                                <button
                                    type="button"
                                    class="b3-button b3-button--text wrns-rv-baseline-toggle"
                                    aria-expanded={item.baselineOpen}
                                    onclick={() => (item.baselineOpen = !item.baselineOpen)}
                                >{item.baselineOpen ? "▾" : "▸"} {text.reviewBaselineLabel} · {item.baselineOpen ? text.reviewBaselineToggleHide : text.reviewBaselineToggleShow}</button>
                                {#if item.baselineOpen}
                                    <div class="wrns-rv-text">{item.baseline}</div>
                                {/if}
                            </div>

                            <div class="wrns-rv-compare">
                                <div class="wrns-rv-pane">
                                    <h4 class="wrns-rv-pane-title">{text.reviewLocalLabel}</h4>
                                    <div class="wrns-rv-text">{item.local}</div>
                                </div>
                                <div class="wrns-rv-pane">
                                    <h4 class="wrns-rv-pane-title">{text.reviewRemoteLabel}</h4>
                                    <div class="wrns-rv-text"><DiffView ops={item.diff} {text} /></div>
                                </div>
                            </div>

                            {#if item.notice.length > 0}
                                <p
                                    class="wrns-rv-notice"
                                    class:wrns-rv-notice-error={item.noticeKind === "error"}
                                    role={item.noticeKind === "error" ? "alert" : "status"}
                                >{item.notice}</p>
                            {:else if item.busy}
                                <p class="wrns-rv-notice" role="status">{text.reviewBusy}</p>
                            {/if}

                            {#if item.editing}
                                <div class="wrns-rv-manual">
                                    <p class="wrns-rv-manual-hint">{text.reviewManualMergeHint}</p>
                                    <textarea
                                        class="wrns-rv-textarea"
                                        rows="8"
                                        spellcheck="false"
                                        aria-label={text.reviewActionManualMerge}
                                        bind:value={item.manualText}
                                        disabled={item.busy}
                                    ></textarea>
                                    <div class="wrns-rv-actions">
                                        <button
                                            type="button"
                                            class="b3-button b3-button--standard"
                                            disabled={item.busy || item.manualText.trim().length === 0}
                                            onclick={() => void runDecision(item, "manual-merge", item.manualText)}
                                        >{item.busy ? text.reviewBusy : text.reviewManualConfirm}</button>
                                        <button
                                            type="button"
                                            class="b3-button b3-button--cancel"
                                            disabled={item.busy}
                                            onclick={() => cancelManual(item)}
                                        >{text.reviewManualCancel}</button>
                                    </div>
                                </div>
                            {/if}

                            <footer class="wrns-rv-actions">
                                <button
                                    type="button"
                                    class="b3-button b3-button--standard"
                                    disabled={item.busy}
                                    onclick={() => void runDecision(item, "apply-remote")}
                                >{text.reviewActionApplyRemote}</button>
                                <button
                                    type="button"
                                    class="b3-button b3-button--standard"
                                    disabled={item.busy}
                                    onclick={() => void runDecision(item, "keep-local")}
                                >{text.reviewActionKeepLocal}</button>
                                <button
                                    type="button"
                                    class="b3-button b3-button--outline"
                                    disabled={item.busy || item.editing}
                                    onclick={() => startManual(item)}
                                >{text.reviewActionManualMerge}</button>
                                <button
                                    type="button"
                                    class="b3-button b3-button--outline"
                                    disabled={item.busy}
                                    onclick={() => void runDecision(item, "save-copy")}
                                >{text.reviewActionSaveCopy}</button>
                                <button
                                    type="button"
                                    class="b3-button b3-button--text"
                                    disabled={item.busy}
                                    onclick={() => deferItem(item)}
                                >{text.reviewActionDefer}</button>
                            </footer>
                        </article>
                    {/each}
                </section>
            {/each}
        {/if}
    </div>

    {#if deferred.length > 0}
        <section class="wrns-rv-deferred">
            <button
                type="button"
                class="wrns-rv-deferred-toggle"
                aria-expanded={deferredOpen}
                onclick={() => (deferredOpen = !deferredOpen)}
            >{deferredOpen ? "▾" : "▸"} {text.reviewDeferredGroup} ({deferred.length})</button>
            {#if deferredOpen}
                <p class="wrns-rv-hint">{text.reviewDeferredHint}</p>
                <ul class="wrns-rv-deferred-list">
                    {#each deferred as item (item.sourceKey)}
                        <li>
                            <span class="wrns-rv-badge">{text[KIND_BADGE_KEY[item.kind]]}</span>
                            <span class="wrns-rv-deferred-book">{item.bookTitle}</span>
                            <code class="wrns-rv-src">{item.sourceKey}</code>
                            <button
                                type="button"
                                class="b3-button b3-button--text"
                                onclick={() => restoreItem(item)}
                            >{text.reviewRestoreDeferred}</button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
</div>

<style>
    /* 全部 scoped；颜色使用思源主题变量（var(--b3-*)）并带回退，深浅色自适应 */
    .wrns-rv-root {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        min-height: 320px;
        min-width: 280px;
        color: var(--b3-theme-on-background);
        font-size: 14px;
    }
    .wrns-rv-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }
    .wrns-rv-title {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--b3-theme-on-background);
    }
    .wrns-rv-count {
        color: var(--b3-theme-on-surface);
        font-weight: 400;
        font-size: 13px;
    }
    .wrns-rv-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
    }
    .wrns-rv-filters {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }
    .wrns-rv-filter-on {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
    .wrns-rv-legend {
        margin: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 2px;
    }
    .wrns-rv-state {
        margin: 0;
        padding: 8px 2px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-state-error {
        color: var(--b3-card-error-color, #d23f31);
    }
    .wrns-rv-book {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .wrns-rv-book-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--b3-theme-on-surface);
    }

    /* 条目卡：container query 基准（≥720px 容器双栏对照，窄屏单栏） */
    .wrns-rv-card {
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius, 6px);
        background-color: var(--b3-theme-background);
    }
    .wrns-rv-card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
    }
    .wrns-rv-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .wrns-rv-badge {
        display: inline-block;
        padding: 1px 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: 999px;
        font-size: 12px;
        white-space: nowrap;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-badge-both-changed {
        color: var(--b3-card-warning-color, #9d7c21);
        border-color: var(--b3-card-warning-color, #9d7c21);
    }
    .wrns-rv-badge-remote-only {
        color: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
    }
    .wrns-rv-badge-local-only {
        color: var(--b3-card-info-color, var(--b3-theme-primary));
        border-color: var(--b3-card-info-color, var(--b3-theme-primary));
    }
    .wrns-rv-badge-identical {
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-src {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        background-color: var(--b3-theme-surface);
        padding: 1px 6px;
        border-radius: 4px;
        word-break: break-all;
    }
    .wrns-rv-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .wrns-rv-time {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        white-space: nowrap;
    }
    .wrns-rv-baseline {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .wrns-rv-baseline-toggle {
        align-self: flex-start;
        font-size: 12px;
        padding: 2px 6px;
    }
    .wrns-rv-compare {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
    }
    @container (min-width: 720px) {
        .wrns-rv-compare {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        }
    }
    .wrns-rv-pane {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }
    .wrns-rv-pane-title {
        margin: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-text {
        margin: 0;
        padding: 8px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: 4px;
        background-color: var(--b3-theme-surface);
        color: var(--b3-theme-on-background);
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.7;
        font-size: 13px;
        max-height: 260px;
        overflow-y: auto;
    }
    .wrns-rv-notice {
        margin: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-notice-error {
        color: var(--b3-card-error-color, #d23f31);
    }
    .wrns-rv-manual {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .wrns-rv-manual-hint {
        margin: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 120px;
        resize: vertical;
        font: inherit;
        font-size: 13px;
        line-height: 1.7;
        padding: 8px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: 4px;
        background-color: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
    }
    .wrns-rv-textarea:focus {
        outline: none;
        border-color: var(--b3-theme-primary);
    }
    .wrns-rv-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .wrns-rv-deferred {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-top: 1px dashed var(--b3-border-color);
        padding-top: 8px;
    }
    .wrns-rv-deferred-toggle {
        align-self: flex-start;
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px 4px;
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-hint {
        margin: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
    .wrns-rv-deferred-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .wrns-rv-deferred-list li {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 12px;
    }
    .wrns-rv-deferred-book {
        font-weight: 500;
        color: var(--b3-theme-on-background);
    }
</style>
