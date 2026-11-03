/**
 * 运行时装配：把引擎依赖适配到思源插件环境。
 *
 * - persistence：Plugin.loadData/saveData（内核侧存储，随工作区同步/备份）；
 *    loadData 对缺失存储返回 null（与 GenerationStore 的"缺失"语义对齐）。
 *    PR9[2]：loadData 抛错（IO 故障）原样穿透，不得压成 null——否则读失败被
 *    GenerationStore 当"首次运行"，引擎重建状态丢 tombstone。读失败由
 *    GenerationStore 汇总判定 StateCorruptionError，引擎保护模式接住。
 * - kernel：fetchSyncPost（桌面/浏览器同路径，自动带内核鉴权）。
 */
import { fetchSyncPost } from "siyuan";
import type { KernelCallFn } from "../adapters/siyuan/writer";
import type { StatePersistence } from "./state/store";

export interface PluginStorageHost {
    loadData(storageName: string): Promise<unknown>;
    saveData(storageName: string, content: unknown): Promise<unknown>;
}

export function createPluginPersistence(plugin: PluginStorageHost): StatePersistence {
    return {
        load: async (name) => plugin.loadData(name),
        save: async (name, content) => {
            await plugin.saveData(name, content);
        },
    };
}

export const kernelCall: KernelCallFn = (path, data) =>
    fetchSyncPost(path, data) as Promise<unknown>;
