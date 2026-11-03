/**
 * 挂载辅助桥接模块。
 *
 * src/index.ts 以 "./review/ui/review-dialog"（无扩展名）引入 mountReviewDialog；
 * 实现位于 review-dialog.svelte 的 <script module> 导出（Svelte 组件须以 .svelte 扩展名导入），
 * 此处仅做转发，保证 tsc（Bundler 解析）与 Vite 构建均可解析同一入口。
 */
export { mountReviewDialog } from "./review-dialog.svelte";
