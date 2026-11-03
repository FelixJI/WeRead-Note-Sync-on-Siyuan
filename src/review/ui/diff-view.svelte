<script lang="ts">
    /**
     * 行内字符级 diff 渲染（local vs remote）。
     *
     * - 按 DiffOp 分段渲染 span：equal 原样；insert 加 "+" 前缀 + 实线下划线；delete 加 "-" 前缀 + 删除线。
     * - 双色（思源成功/错误色）仅作辅助，信息同时由 +/- 符号与线条样式承载，不只靠红绿（AC5）。
     * - 全部 {text} 纯文本插值，零 @html，无 HTML 注入面。
     */
    import type { DiffOp } from "../../diff/chars";
    import type { SettingsText } from "../../settings/i18n";

    interface Props {
        ops: DiffOp[];
        text: SettingsText;
    }

    let { ops, text }: Props = $props();
</script>

{#each ops as op}
    {#if op.type === "insert"}
        <span class="wrns-rv-op wrns-rv-op-ins" title={text.reviewDiffInsLabel}>+{op.text}</span>
    {:else if op.type === "delete"}
        <span class="wrns-rv-op wrns-rv-op-del" title={text.reviewDiffDelLabel}>-{op.text}</span>
    {:else}
        <span class="wrns-rv-op wrns-rv-op-eq">{op.text}</span>
    {/if}
{/each}

<style>
    /* 全部 scoped；颜色使用思源主题变量并带回退，深浅色自适应 */
    .wrns-rv-op {
        white-space: pre-wrap;
        word-break: break-word;
    }
    .wrns-rv-op-ins {
        color: var(--b3-card-success-color, #2ea86f);
        background-color: var(--b3-card-success-background, rgba(46, 168, 111, 0.12));
        text-decoration-line: underline;
        text-decoration-style: solid;
        text-decoration-thickness: 2px;
        text-underline-offset: 3px;
    }
    .wrns-rv-op-del {
        color: var(--b3-card-error-color, #d23f31);
        background-color: var(--b3-card-error-background, rgba(210, 63, 49, 0.1));
        text-decoration-line: line-through;
        text-decoration-style: solid;
        text-decoration-thickness: 1.5px;
    }
</style>
