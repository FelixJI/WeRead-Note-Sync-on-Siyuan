/**
 * 状态存储：双世代写入 + 上一有效代回退（docs/design/t02-sync-core.md §2）。
 *
 * - save 先把当前世代挪到 <name>.prev，再写 <name>。
 * - load：存储缺失（null/undefined）→ 返回 undefined（首次运行/重建路径）；
 *   当前世代存在但解析失败 → 回退 .prev；两级都坏 → StateCorruptionError（保护模式）。
 * - 持久化经注入接口（Plugin loadData/saveData），本模块不依赖 siyuan 包 → 可测试。
 */

export interface StatePersistence {
    load(name: string): Promise<unknown>;
    save(name: string, content: unknown): Promise<void>;
}

export class StateCorruptionError extends Error {
    constructor(public readonly storageName: string) {
        super(`状态存储 ${storageName} 当前沿与上一有效代均损坏，进入保护模式`);
        this.name = "StateCorruptionError";
    }
}

interface Versioned {
    schemaVersion: number;
}

function isVersionedObject(v: unknown): v is Record<string, unknown> & Versioned {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return false;
    }
    const rec = v as Record<string, unknown>;
    return typeof rec.schemaVersion === "number";
}

export class GenerationStore<T extends Versioned> {
    readonly #persistence: StatePersistence;
    readonly #name: string;

    constructor(persistence: StatePersistence, name: string) {
        this.#persistence = persistence;
        this.#name = name;
    }

    get storageName(): string {
        return this.#name;
    }

    /**
     * 读当前世代。
     * - 存储缺失 → undefined；
     * - 当前世代解析失败但 .prev 有效 → .prev 值（调用方应察觉世代回退由 save 收敛）；
     * - 两级均存在且无效 → StateCorruptionError。
     */
    async load(): Promise<T | undefined> {
        const current = await this.#tryLoad(this.#name);
        if (current !== undefined) {
            return current;
        }
        const prev = await this.#tryLoad(`${this.#name}.prev`);
        if (prev !== undefined) {
            return prev;
        }
        if ((await this.#rawExists(this.#name)) || (await this.#rawExists(`${this.#name}.prev`))) {
            // 存储有值但两级都无法解析为带 schemaVersion 的对象 → 损坏
            throw new StateCorruptionError(this.#name);
        }
        return undefined;
    }

    /** 双世代写入：当前 → .prev，新值 → 当前。任一持久化失败即抛错（调用方不得推进内存基线）。 */
    async save(next: T): Promise<void> {
        if (await this.#rawExists(this.#name)) {
            const current = await this.#persistence.load(this.#name);
            await this.#persistence.save(`${this.#name}.prev`, current);
        }
        await this.#persistence.save(this.#name, next);
    }

    async #rawExists(name: string): Promise<boolean> {
        try {
            const raw = await this.#persistence.load(name);
            return raw !== undefined && raw !== null;
        } catch {
            // 读取即抛错视为该世代不存在（保守：由另一世代兜底）
            return false;
        }
    }

    async #tryLoad(name: string): Promise<T | undefined> {
        let raw: unknown;
        try {
            raw = await this.#persistence.load(name);
        } catch {
            return undefined;
        }
        if (raw === undefined || raw === null) {
            return undefined;
        }
        return isVersionedObject(raw) ? (raw as unknown as T) : undefined;
    }
}
