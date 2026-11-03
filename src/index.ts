/**
 * 微信读书笔记同步 - 思源笔记插件壳。
 *
 * 职责（T01）：
 * - 注册顶栏图标与“打开设置”命令占位（无业务 eventBus 订阅）。
 * - 构建思源 Setting 容器，承载 Svelte 5 设置页（mount/unmount）。
 * - API Key 持有策略（冻结）：默认仅会话内存；勾选“记住”才写入
 *   window.localStorage（键名 weread-note-sync.apiKey）；清除按钮一并清除。
 *
 * 安全约束：不输出任何日志；API Key 不进入 console/日志/诊断内容。
 */
import { Plugin, Setting } from "siyuan";
import { mount, unmount } from "svelte";
import SettingsPage from "./settings/settings-page.svelte";
import { ApiKeyStore } from "./settings/api-key-store";
import { createSettingsText, type SettingsText } from "./settings/i18n";
import "./index.scss";

export default class WereadNoteSyncPlugin extends Plugin {
    /** API Key 存储：会话内存优先，见 src/settings/api-key-store.ts（冻结策略）。 */
    #apiKeyStore: ApiKeyStore = new ApiKeyStore();

    /** 设置页文案（内核 i18n + 内置兜底）。 */
    #text: SettingsText | null = null;

    /** Svelte 5 mount 返回的组件实例（无导出成员，仅用于 unmount）。 */
    #settingsApp: object | null = null;

    onload(): void {
        this.#text = createSettingsText(this.i18n);
        const text = this.#text;

        // 顶栏图标：打开设置页（首版无其他业务入口）
        this.addTopBar({
            icon: "iconSettings",
            title: text.topBarTip,
            position: "right",
            callback: () => this.openSetting(),
        });

        // 命令占位：命令面板中的“打开设置”
        this.addCommand({
            langKey: "commandOpenSetting",
            langText: text.commandOpenSetting,
            hotkey: "",
            callback: () => this.openSetting(),
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
     * 覆写以统一三处入口（顶栏图标 / 命令 / 思源插件设置齿轮）：
     * 打开承载 Svelte 设置页的 Setting 对话框（与内核默认实现一致）。
     */
    openSetting(): void {
        if (!this.setting) {
            return;
        }
        this.setting.open(this.displayName || this.name);
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
