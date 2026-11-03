/**
 * review-dialog.svelte 的 tsc 模块声明（命名导出镜像）。
 *
 * - svelte 包内置的 `declare module "*.svelte"` 仅含默认导出，纯 tsc（check:types）看不到
 *   `<script module>` 的命名导出 mountReviewDialog；本声明提供同名同签名类型
 *   （svelte-check 经 svelte2tsx 使用真实组件与实现，二者保持一致；实现唯一来源仍是 review-dialog.svelte）。
 * - Vite 构建忽略本文件：显式 `*.svelte` 导入优先命中原组件文件。
 */
import type { Component } from "svelte";
import type { SettingsText } from "../../settings/i18n";

export interface ReviewDialogProps {
    text: SettingsText;
    onClose: () => void;
}

export function mountReviewDialog(
    host: HTMLElement,
    opts: { onClose: () => void; i18n?: Record<string, string> },
): () => void;

declare const ReviewDialog: Component<ReviewDialogProps>;
export default ReviewDialog;
