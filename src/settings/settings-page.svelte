<script lang="ts">
    /**
     * 微信读书同步设置页（Svelte 5）。
     *
     * - 由 src/index.ts 以 mount() 挂载到思源 Setting 的自定义容器中，随插件生命周期 unmount。
     * - i18n 文案通过 props 注入（源自内核 plugin.i18n，见 src/settings/i18n.ts）。
     * - 远端返回的一切文本一律使用 {text} 纯文本插值，绝不使用 {@html}。
     * - 样式为 scoped，颜色沿用思源主题变量（var(--b3-*)），深浅色自适应。
     */
    import { untrack } from "svelte";
    import { runConnectionTest, type ConnectionFailKind, type ConnectionTestOutcome } from "./connection";
    import type { ApiKeyStore } from "./api-key-store";
    import type { AccountStore } from "./account-store";
    import { validateSourceSegment } from "../sync/identity";
    import type { SettingsText, SettingsTextKey } from "./i18n";

    interface Props {
        i18n: SettingsText;
        store: ApiKeyStore;
        account: AccountStore;
    }

    let { i18n, store, account }: Props = $props();

    // 刻意只取 store 的初始值做一次性快照（后续数据流为 UI -> store 单向写入）
    let apiKey: string = $state(untrack(() => store.key));
    let remember: boolean = $state(untrack(() => store.remember));
    let namespace: string = $state(untrack(() => account.namespace));
    let keyVisible: boolean = $state(false);
    let testing: boolean = $state(false);
    let outcome: ConnectionTestOutcome | null = $state(null);
    let notice: string = $state("");

    const keyInputType: "password" | "text" = $derived(keyVisible ? "text" : "password");

    const FAIL_KIND_I18N_KEY: Record<ConnectionFailKind, SettingsTextKey> = {
        "auth": "settingFailKindAuth",
        "network": "settingFailKindNetwork",
        "upgrade": "settingFailKindUpgrade",
        "gateway": "settingFailKindGateway",
        "invalid-key": "settingFailKindInvalidKey",
    };

    function onKeyInput(event: Event): void {
        const target = event.currentTarget;
        if (target instanceof HTMLInputElement) {
            apiKey = target.value;
            store.setKey(apiKey);
        }
    }

    function onRememberChange(event: Event): void {
        const target = event.currentTarget;
        if (target instanceof HTMLInputElement) {
            remember = target.checked;
            store.setRemember(remember);
        }
    }

    function onNamespaceInput(event: Event): void {
        const target = event.currentTarget;
        if (target instanceof HTMLInputElement) {
            namespace = target.value;
            account.setNamespace(namespace);
        }
    }

    // 账号标识字符集即时校验（整改 m3：与 sourceKey 安全字符集一致，非法输入当场提示）
    const namespaceError: string | null = $derived(validateSourceSegment(namespace.trim()));

    function onToggleKeyVisible(): void {
        keyVisible = !keyVisible;
    }

    async function onTestConnection(): Promise<void> {
        if (testing) {
            return;
        }
        testing = true;
        notice = "";
        outcome = null;
        try {
            outcome = await runConnectionTest(store.key);
        } finally {
            testing = false;
        }
    }

    function onClearKey(): void {
        store.clearAll();
        apiKey = "";
        remember = false;
        keyVisible = false;
        outcome = null;
        notice = i18n.settingKeyCleared;
    }
</script>

<div class="wrns-settings">
    <div class="wrns-field">
        <label class="wrns-label" for="wrns-api-key">{i18n.settingApiKeyLabel}</label>
        <div class="wrns-key-row">
            <input
                id="wrns-api-key"
                class="b3-text-field fn__flex-1"
                type={keyInputType}
                value={apiKey}
                placeholder={i18n.settingApiKeyPlaceholder}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                oninput={onKeyInput}
            />
            <button
                type="button"
                class="b3-button b3-button--outline"
                aria-pressed={keyVisible}
                onclick={onToggleKeyVisible}
            >{keyVisible ? i18n.settingApiKeyHide : i18n.settingApiKeyShow}</button>
        </div>
        <p class="wrns-hint">{i18n.settingApiKeyHint}</p>
    </div>

    <div class="wrns-field">
        <label class="wrns-check-row" for="wrns-remember">
            <input
                id="wrns-remember"
                type="checkbox"
                class="b3-switch"
                checked={remember}
                onchange={onRememberChange}
            />
            <span>{i18n.settingRememberLabel}</span>
        </label>
        <p class="wrns-hint">{i18n.settingStorageNotice}</p>
    </div>

    <div class="wrns-field">
        <label class="wrns-label" for="wrns-account">{i18n.settingAccountLabel}</label>
        <input
            id="wrns-account"
            class="b3-text-field fn__flex-1"
            type="text"
            value={namespace}
            placeholder={i18n.settingAccountPlaceholder}
            autocomplete="off"
            spellcheck="false"
            oninput={onNamespaceInput}
        />
        {#if namespace.length > 0 && namespaceError !== null}
            <p class="wrns-result-fail">{i18n.settingAccountInvalid}：{namespaceError}</p>
        {/if}
        <p class="wrns-hint">{i18n.settingAccountHint}</p>
    </div>

    <div class="wrns-actions">
        <button
            type="button"
            class="b3-button b3-button--text"
            disabled={testing}
            onclick={() => void onTestConnection()}
        >{testing ? i18n.settingTesting : i18n.settingTestBtn}</button>
        <button
            type="button"
            class="b3-button b3-button--cancel"
            disabled={testing}
            onclick={onClearKey}
        >{i18n.settingClearKeyBtn}</button>
    </div>

    {#if notice.length > 0}
        <p class="wrns-notice" role="status">{notice}</p>
    {/if}

    {#if outcome !== null}
        <div class="wrns-result" role="status">
            {#if outcome.status === "ok"}
                <p class="wrns-result-ok">
                    ✓ {i18n.settingTestOk}{#if outcome.totalBookCount !== undefined}&nbsp;·&nbsp;{i18n.settingBooksWithNotes}: {outcome.totalBookCount}{/if}&nbsp;·&nbsp;{i18n.settingElapsed}: {outcome.elapsedMs} ms
                </p>
            {:else if outcome.status === "invalid-key"}
                <p class="wrns-result-fail">{i18n.settingInvalidKey}</p>
            {:else if outcome.status === "fail"}
                <p class="wrns-result-fail">{i18n[FAIL_KIND_I18N_KEY[outcome.kind]]}</p>
                {#if outcome.message.length > 0}
                    <p class="wrns-result-detail">{outcome.message}</p>
                {/if}
            {:else if outcome.status === "unknown-error"}
                <p class="wrns-result-fail">{i18n.settingFailUnexpected}</p>
            {/if}
        </div>
    {/if}
</div>

<style>
    /* 全部 scoped；颜色使用思源主题变量，随深浅色主题自适应 */
    .wrns-settings {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 4px 0 8px;
        max-width: 560px;
        color: var(--b3-theme-on-background);
    }
    .wrns-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .wrns-label {
        color: var(--b3-theme-on-background);
        font-weight: 500;
    }
    .wrns-key-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .wrns-check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--b3-theme-on-background);
    }
    .wrns-actions {
        display: flex;
        gap: 8px;
    }
    .wrns-hint,
    .wrns-notice {
        margin: 0;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        line-height: 1.6;
    }
    .wrns-result p {
        margin: 0;
    }
    .wrns-result-ok {
        color: var(--b3-card-success-color, var(--b3-theme-primary));
    }
    .wrns-result-fail {
        color: var(--b3-card-error-color, #d23f31);
    }
    .wrns-result-detail {
        margin-top: 4px;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        word-break: break-all;
    }
</style>
