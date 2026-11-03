import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";

/**
 * 思源插件构建配置。
 *
 * - 仅 app（插件前端 bundle）目标：不做 kernel 包、zip 打包、dev 目录实时复制或 live-reload。
 * - 输出 CJS index.js：思源插件加载器以 require("siyuan") 方式执行 bundle，故 external siyuan/process。
 * - i18n 放在 public/i18n/，Vite 构建时自动复制到 dist/i18n/，符合思源插件 i18n 目录规范。
 */
export default defineConfig({
    define: {
        NODE_ENV: JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    plugins: [
        svelte(),
        viteStaticCopy({
            targets: [
                { src: "plugin.json", dest: "." },
                { src: "icon.png", dest: "." },
                { src: "README*.md", dest: "." },
            ],
        }),
    ],
    build: {
        outDir: "dist",
        emptyOutDir: true,
        minify: true,
        lib: {
            entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            formats: ["cjs"],
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rollupOptions: {
            external: ["siyuan", "process"],
        },
    },
});
