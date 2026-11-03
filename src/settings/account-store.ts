/**
 * 账号命名空间存储（非机密，localStorage 持久）。
 *
 * 冻结语义（docs/design/t02-sync-core.md §1）：
 * - accountNamespace 是用户显式配置的账号标识，参与 sourceKey 身份；
 *   绝不以 Key 哈希定义；换 Key 不自动换账号，换账号必须显式改此值并迁移。
 * - keyMarker（Key 的 SHA-256 前 16 hex）仅用于"换 Key 提醒"，绝不参与身份。
 */
const ACCOUNT_KEY = "weread-note-sync.account";
const KEY_MARKER_KEY = "weread-note-sync.keyMarker";

function sha256Hex(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", data).then((buf) => {
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
}

export class AccountStore {
    #namespace: string;
    #keyMarker: string;

    constructor() {
        this.#namespace = this.#read(ACCOUNT_KEY);
        this.#keyMarker = this.#read(KEY_MARKER_KEY);
    }

    get namespace(): string {
        return this.#namespace;
    }

    /** 配置账号标识（立即持久化）。空串 = 清除。 */
    setNamespace(ns: string): void {
        this.#namespace = ns.trim();
        this.#write(ACCOUNT_KEY, this.#namespace);
    }

    /**
     * 记录/校验当前 Key 指纹；Key 变化返回 true（供 UI 提醒，绝不自动换账号）。
     */
    async noteApiKey(apiKey: string): Promise<boolean> {
        const marker = (await sha256Hex(apiKey)).slice(0, 16);
        const changed = this.#keyMarker.length > 0 && this.#keyMarker !== marker;
        this.#keyMarker = marker;
        this.#write(KEY_MARKER_KEY, marker);
        return changed;
    }

    #read(key: string): string {
        try {
            const v = window.localStorage.getItem(key);
            return v !== null && v.length > 0 ? v : "";
        } catch {
            return "";
        }
    }

    #write(key: string, value: string): void {
        try {
            if (value.length === 0) {
                window.localStorage.removeItem(key);
            } else {
                window.localStorage.setItem(key, value);
            }
        } catch {
            // 隐私模式等：退化为会话内存
        }
    }
}
