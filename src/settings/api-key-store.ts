/**
 * API Key 持有策略（冻结约定，不得更改）：
 *
 * 1. 默认仅保存在会话内存（插件实例私有字段），onunload 时清空。
 * 2. 只有用户勾选“记住”才写入 window.localStorage，键名固定 "weread-note-sync.apiKey"；
 *    UI 必须如实说明：按端本地明文存储、非加密、不随内核同步、清除即删。
 * 3. “清除 Key”按钮同时清除会话内存与 localStorage。
 *
 * 安全约束：Key 不得写入任何日志/console/诊断输出（本模块不产生任何日志）。
 */
const LOCAL_STORAGE_KEY = "weread-note-sync.apiKey";

export class ApiKeyStore {
    #key: string = "";
    #remember: boolean = false;

    constructor() {
        // 构造时若本机存有历史“记住”的 Key，则恢复到会话内存并保持“记住”勾选。
        try {
            const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
            if (stored !== null && stored.length > 0) {
                this.#key = stored;
                this.#remember = true;
            }
        } catch {
            // localStorage 不可用（如隐私模式）：保持纯会话内存模式。
        }
    }

    /** 当前会话内存中的 Key。 */
    get key(): string {
        return this.#key;
    }

    /** 是否处于“记住”模式。 */
    get remember(): boolean {
        return this.#remember;
    }

    /** 更新 Key（输入框每次变更调用）。仅当处于“记住”模式才同步持久化。 */
    setKey(key: string): void {
        this.#key = key;
        if (this.#remember) {
            if (key.length === 0) {
                this.#removePersisted();
            } else {
                this.#persist();
            }
        }
    }

    /** 切换“记住”模式：开启即持久化当前 Key，关闭即删除本机存储（会话内存保留）。 */
    setRemember(remember: boolean): void {
        this.#remember = remember;
        if (remember) {
            if (this.#key.length > 0) {
                this.#persist();
            }
        } else {
            this.#removePersisted();
        }
    }

    /** 清除 Key：会话内存与本机 localStorage 一并清除，并复位“记住”状态。 */
    clearAll(): void {
        this.#key = "";
        this.#remember = false;
        this.#removePersisted();
    }

    /** 插件卸载时调用：只清会话内存；若用户选择了“记住”，localStorage 保留。 */
    dispose(): void {
        this.#key = "";
        this.#remember = false;
    }

    #persist(): void {
        try {
            window.localStorage.setItem(LOCAL_STORAGE_KEY, this.#key);
        } catch {
            // 写入失败（如存储满/隐私模式）：保持会话内存模式即可。
        }
    }

    #removePersisted(): void {
        try {
            window.localStorage.removeItem(LOCAL_STORAGE_KEY);
        } catch {
            // 同上，忽略。
        }
    }
}
