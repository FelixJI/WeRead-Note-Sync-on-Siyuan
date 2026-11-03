/**
 * 状态存储：双世代写入 + 上一有效代回退（docs/design/t02-sync-core.md §2）。
 *
 * - save 先把当前世代挪到 <name>.prev，再写 <name>。
 * - load：存储缺失（null/undefined）→ 返回 undefined（首次运行/重建路径）；
 *   当前世代存在但解析失败 → 回退 .prev；两级都坏 → StateCorruptionError（保护模式）。
 * - PR9[2]：读失败（持久化层抛错）与"无数据"严格区分——读取抛错绝不当首次
 *   （否则引擎重建状态会丢 tombstone，本地已删摘录复活）；任一代读取失败且
 *   无有效另一代兜底 → StateCorruptionError，由引擎既有保护模式接住停写。
 * - 持久化经注入接口（Plugin loadData/saveData），本模块不依赖 siyuan 包 → 可测试。
 */

export interface StatePersistence {
    load(name: string): Promise<unknown>;
    save(name: string, content: unknown): Promise<void>;
}

export class StateCorruptionError extends Error {
    constructor(
        public readonly storageName: string,
        detail?: string,
    ) {
        super(
            `状态存储 ${storageName} 双世代均无可用有效数据` +
                (detail !== undefined ? `（${detail}）` : "") +
                "，进入保护模式",
        );
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

/** 单个世代的读取结果（PR9[2]：四态区分，读失败不得混入"缺失"）。 */
type GenerationRead<T> =
    | { kind: "absent" }
    | { kind: "valid"; value: T }
    | { kind: "invalid" }
    | { kind: "read-error"; error: unknown };

function describeGeneration<T>(outcome: GenerationRead<T>): string {
    switch (outcome.kind) {
        case "absent":
            return "缺失";
        case "valid":
            return "有效";
        case "invalid":
            return "存在但解析/校验失败";
        case "read-error":
            return `读取失败：${(outcome.error as Error).message}`;
    }
}

export class GenerationStore<T extends Versioned> {
    readonly #persistence: StatePersistence;
    readonly #name: string;
    readonly #isValid?: (value: unknown) => boolean;

    constructor(persistence: StatePersistence, name: string, isValid?: (value: unknown) => boolean) {
        this.#persistence = persistence;
        this.#name = name;
        this.#isValid = isValid;
    }

    get storageName(): string {
        return this.#name;
    }

    /**
     * 读当前世代。
     * - 两代均缺失 → undefined（首次运行语义）；
     * - 当前代有效 → 返回当前代；
     * - 当前代缺失/损坏/读失败但 .prev 有效 → .prev 值（调用方应察觉世代回退由 save 收敛）；
     * - 其余组合（存在读失败或损坏数据且无有效兜底）→ StateCorruptionError（保护模式）。
     */
    async load(): Promise<T | undefined> {
        const current = await this.#readGeneration(this.#name);
        if (current.kind === "valid") {
            return current.value;
        }
        const prev = await this.#readGeneration(`${this.#name}.prev`);
        if (prev.kind === "valid") {
            return prev.value;
        }
        if (current.kind === "absent" && prev.kind === "absent") {
            return undefined;
        }
        // 读失败与损坏同等对待：无法提供有效数据且不能证明是首次 → 保护模式，
        // 绝不返回 undefined（调用方会走重建路径，丢 tombstone 后本地删除复活）。
        throw new StateCorruptionError(
            this.#name,
            `当前世代=${describeGeneration(current)}；上一世代=${describeGeneration(prev)}`,
        );
    }

    /**
     * 双世代写入：当前 → .prev，新值 → 当前。
     * - 只有当前世代**读取成功且**通过有效性校验才晋升为 .prev
     *   （读失败/损坏/缺失的当前世代不晋升，防止未知内容覆盖最后有效世代）；
     * - 任一持久化失败即抛错（调用方不得推进内存基线）。
     */
    async save(next: T): Promise<void> {
        const current = await this.#readGeneration(this.#name);
        if (current.kind === "valid") {
            await this.#persistence.save(`${this.#name}.prev`, current.value);
        }
        await this.#persistence.save(this.#name, next);
    }

    /** 读取单个世代：穿透持久化层错误（PR9[2]），区分缺失/有效/损坏/读失败四态。 */
    async #readGeneration(name: string): Promise<GenerationRead<T>> {
        let raw: unknown;
        try {
            raw = await this.#persistence.load(name);
        } catch (e) {
            return { kind: "read-error", error: e };
        }
        if (raw === undefined || raw === null) {
            return { kind: "absent" };
        }
        if (!isVersionedObject(raw)) {
            return { kind: "invalid" };
        }
        if (this.#isValid !== undefined && !this.#isValid(raw)) {
            return { kind: "invalid" };
        }
        return { kind: "valid", value: raw as unknown as T };
    }
}
