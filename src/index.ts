/**
 * 微信读书笔记同步 - 思源笔记插件壳。
 *
 * 职责（T01+T02）：
 * - 注册顶栏图标（菜单：立即同步 / 打开设置）与命令。
 * - 构建思源 Setting 容器，承载 Svelte 5 设置页（mount/unmount）。
 * - API Key 持有策略（冻结）：默认仅会话内存；勾选“记住”才写 localStorage。
 * - 账号命名空间（T02）：用户显式配置，参与 sourceKey 身份；不以 Key 哈希定义。
 * - 立即同步：装配 SyncEngine（插件存储 + fetchSyncPost + forwardProxy 传输），
 *   结果以 showMessage 摘要呈现（计数与状态，不含任何远端正文/凭证）。
 *
 * 安全约束：不输出任何日志；API Key 不进入 console/日志/诊断内容。
 */
import { Plugin, Setting, showMessage, Menu, Dialog } from "siyuan";
import { mount, unmount } from "svelte";
import SettingsPage from "./settings/settings-page.svelte";
import { ApiKeyStore } from "./settings/api-key-store";
import { AccountStore } from "./settings/account-store";
import { createSettingsText, type SettingsText } from "./settings/i18n";
import { createKernelForwardProxyTransport } from "./core/net/forward-proxy-transport";
import { kernelForwardProxy } from "./adapters/siyuan/kernel";
import { isValidWereadApiKey } from "./adapters/weread/client";
import { SyncEngine, AccountMismatchError } from "./sync/engine";
import { initReviewSession } from "./review/queue";
import { mountReviewDialog } from "./review/ui/review-dialog";
import { createPluginPersistence, kernelCall } from "./sync/runtime";
import { validateSourceSegment } from "./sync/identity";
import "./index.scss";

export default class WereadNoteSyncPlugin extends Plugin {
    /** API Key 存储：会话内存优先，见 src/settings/api-key-store.ts（冻结策略）。 */
    #apiKeyStore: ApiKeyStore = new ApiKeyStore();

    /** 账号命名空间存储（非机密）。 */
    #accountStore: AccountStore = new AccountStore();

    /** 设置页文案（内核 i18n + 内置兜底）。 */
    #text: SettingsText | null = null;

    /** Svelte 5 mount 返回的组件实例（无导出成员，仅用于 unmount）。 */
    #settingsApp: object | null = null;

    /** 同步进行中标记（防重入）。 */
    #syncing = false;

    onload(): void {
        this.#text = createSettingsText(this.i18n);
        const text = this.#text;

        this.addTopBar({
            icon: "iconSettings",
            title: text.topBarTip,
            position: "right",
            callback: (event: MouseEvent) => this.#openMenu(event),
        });

        this.addCommand({
            langKey: "commandOpenSetting",
            langText: text.commandOpenSetting,
            hotkey: "",
            callback: () => this.openSetting(),
        });

        this.addCommand({
            langKey: "commandSyncNow",
            langText: text.commandSyncNow,
            hotkey: "",
            callback: () => void this.#syncNow(),
        });

        this.addCommand({
            langKey: "commandReviewChanges",
            langText: text.commandReviewChanges,
            hotkey: "",
            callback: () => this.#openReviewDialog(),
        });

        this.#setupSetting();
    }

    onunload(): void {
        // 仅清会话内存；用户勾选“记住”时 localStorage 保留（策略见 api-key-store.ts）
        this.#apiKeyStore.dispose();
        if (this.#settingsApp !== null) {
            unmount(this.#settingsApp);
            this.#settingsApp = null;
        }
    }

    /**
     * 覆写以统一入口（顶栏菜单 / 命令 / 思源插件设置齿轮）：
     * 打开承载 Svelte 设置页的 Setting 对话框（与内核默认实现一致）。
     */
    openSetting(): void {
        if (!this.setting) {
            return;
        }
        this.setting.open(this.displayName || this.name);
    }

    #openMenu(event: MouseEvent): void {
        const text = this.#text;
        if (text === null) {
            return;
        }
        const menu = new Menu("weread-note-sync-topbar");
        menu.addItem({
            icon: "iconRefresh",
            label: text.commandSyncNow,
            click: () => void this.#syncNow(),
        });
        menu.addItem({
            icon: "iconDiff",
            label: text.commandReviewChanges,
            click: () => this.#openReviewDialog(),
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconSettings",
            label: text.commandOpenSetting,
            click: () => this.openSetting(),
        });
        menu.open({ x: event.clientX, y: event.clientY });
    }

    #openReviewDialog(): void {
        const text = this.#text;
        if (text === null) {
            return;
        }
        const engine = this.#buildEngine();
        if (engine === null) {
            this.openSetting();
            return;
        }
        initReviewSession({ engine });
        const host = document.createElement("div");
        const dialog = new Dialog({
            title: text.reviewDialogTitle,
            content: "",
            width: "860px",
            height: "70%",
        });
        const unmounted = mountReviewDialog(host, {
            onClose: () => dialog.destroy(),
            i18n: text,
        });
        dialog.element.querySelector(".b3-dialog__content")?.appendChild(host);
        void unmounted;
    }

    #buildEngine(): SyncEngine | null {
        const apiKey = this.#apiKeyStore.key;
        const namespace = this.#accountStore.namespace;
        if (!isValidWereadApiKey(apiKey) || namespace.length === 0) {
            return null;
        }
        return new SyncEngine({
            persistence: createPluginPersistence(this),
            kernel: kernelCall,
            transport: createKernelForwardProxyTransport(kernelForwardProxy),
            apiKey,
            accountNamespace: namespace,
        });
    }

    async #syncNow(): Promise<void> {
        const text = this.#text;
        if (text === null || this.#syncing) {
            return;
        }
        const apiKey = this.#apiKeyStore.key;
        const namespace = this.#accountStore.namespace;
        if (!isValidWereadApiKey(apiKey)) {
            showMessage(text.syncNeedApiKey, 4000, "error");
            this.openSetting();
            return;
        }
        if (namespace.length === 0) {
            showMessage(text.syncNeedAccount, 4000, "error");
            this.openSetting();
            return;
        }
        const nsInvalid = validateSourceSegment(namespace);
        if (nsInvalid !== null) {
            showMessage(`${text.settingAccountInvalid}（${nsInvalid}）`, 5000, "error");
            this.openSetting();
            return;
        }
        // 换 Key 提醒（keyMarker 只提醒，绝不自动换账号）
        const keyChanged = await this.#accountStore.noteApiKey(apiKey);
        if (keyChanged) {
            showMessage(`⚠️ ${text.syncKeyChangedWarning}`, 6000, "info");
        }

        this.#syncing = true;
        showMessage(text.syncRunning, 2000, "info");
        try {
            const engine = this.#buildEngine();
            if (engine === null) {
                showMessage(text.syncUnexpectedError, 5000, "error");
                return;
            }
            initReviewSession({ engine });
            const outcome = await engine.syncRound();
            if (outcome.protectionMode !== undefined) {
                showMessage(`${text.syncDoneWithError}${outcome.protectionMode}`, 7000, "error");
                return;
            }
            if (outcome.abortedReason !== undefined) {
                showMessage(`${text.syncDoneWithError}${outcome.abortedReason}`, 7000, "error");
                return;
            }
            const created = outcome.books.reduce((s, b) => s + b.created, 0);
            const candidates = outcome.candidatesReport.length;
            const protectedCount = outcome.protectedReport.length;
            const itemErrors = outcome.books.reduce((s, b) => s + b.itemErrors, 0);
            // 书级失败含"跳过但带错误"（保护模式/来源拉取失败）——这类最需要用户干预，必须按错误上报（整改 M2）
            const bookErrors = outcome.books.filter((b) => b.error !== undefined).length;
            const skippedBooks = outcome.books.filter((b) => b.skipped).length;
            const parts = [
                `${text.syncCreatedCount}: ${created}`,
                `${text.syncCandidateCount}: ${candidates}`,
                `${text.syncProtectedCount}: ${protectedCount}`,
            ];
            if (itemErrors > 0) {
                parts.push(`${text.syncItemErrorCount}: ${itemErrors}`);
            }
            if (outcome.deferredBooks > 0) {
                parts.push(`${text.syncDeferredCount}: ${outcome.deferredBooks}`);
            }
            if (skippedBooks > 0) {
                // 复核随行修复：书级整书跳过（如回包异常）必须可见，不得显示为"成功+全零"
                parts.push(`${text.syncSkippedCount}: ${skippedBooks}`);
            }
            if ((outcome.projectionAnomalies?.length ?? 0) > 0) {
                // 审阅整改 MINOR-4：投影告警（复盘区缺失/歧义跳过等）必须对用户可见
                parts.push(`${text.syncProjectionAnomalyCount}: ${outcome.projectionAnomalies!.length}`);
            }
            if (!outcome.ok || bookErrors > 0 || skippedBooks > 0) {
                showMessage(
                    `${text.syncDoneWithError}${parts.join("，")}，${text.syncBookErrorCount}: ${bookErrors}`,
                    7000,
                    "error",
                );
            } else {
                showMessage(`${text.syncDoneOk}${parts.join("，")}`, 4000, "info");
            }
        } catch (e) {
            // 账号不一致是静态指引信息（不含远端文本），必须完整透出而非通用提示（整改 m3）
            if (e instanceof AccountMismatchError) {
                showMessage(`${text.syncDoneWithError}${e.message}`, 8000, "error");
                return;
            }
            // 其余异常文本可能含上下文：仅展示通用提示（脱敏在 core 层，此处不透出原始消息）
            showMessage(text.syncUnexpectedError, 5000, "error");
        } finally {
            this.#syncing = false;
        }
    }

    #setupSetting(): void {
        const text = this.#text;
        if (text === null) {
            return;
        }

        // 挂载一次、跨对话框开合复用：Setting 每次打开都会重新附加同一 actionElement。
        const host = document.createElement("div");
        host.className = "weread-note-sync-root";
        this.#settingsApp = mount(SettingsPage, {
            target: host,
            props: {
                i18n: text,
                store: this.#apiKeyStore,
                account: this.#accountStore,
            },
        });

        const setting = new Setting({
            width: "640px",
            height: "auto",
        });
        setting.addItem({
            title: text.settingTitle,
            description: text.settingDescription,
            direction: "row",
            actionElement: host,
        });
        this.setting = setting;
    }
}
