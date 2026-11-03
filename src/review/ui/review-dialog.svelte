<script lang="ts" module>
    /**
     * 挂载辅助（冻结签名）：由主代理在思源 Dialog 容器中调用，例如
     * `const close = mountReviewDialog(host, { onClose, i18n: this.i18n })`。
     *
     * - Svelte 5 mount/unmount；返回卸载函数（unmount 组件；onClose 由调用方在关闭 Dialog 时触发）。
     * - opts.i18n 可选：传入内核 plugin.i18n（Record<string, string>）即按用户语言本地化；
     *   缺省回落 createSettingsText({})（内置中文兜底，键见 src/settings/i18n.ts，两份 JSON 同步）。
     */
    import { mount, unmount } from "svelte";
    import { createSettingsText } from "../../settings/i18n";
    import ReviewDialogBody from "./review-dialog-body.svelte";

    export function mountReviewDialog(
        host: HTMLElement,
        opts: { onClose: () => void; i18n?: Record<string, string> },
    ): () => void {
        const text = createSettingsText(opts.i18n ?? {});
        const app = mount(ReviewDialogBody, {
            target: host,
            props: {
                text,
                onClose: opts.onClose,
            },
        });
        return () => {
            unmount(app);
        };
    }
</script>

<script lang="ts">
    /**
     * 审阅变更对话框主组件（默认导出，与 mountReviewDialog 挂载的组件同构）。
     * 实际 UI 与交互逻辑见 review-dialog-body.svelte（T03 设计 §4）。
     */
    import type { SettingsText } from "../../settings/i18n";

    interface Props {
        text: SettingsText;
        onClose: () => void;
    }

    let { text, onClose }: Props = $props();
</script>

<ReviewDialogBody {text} {onClose} />
