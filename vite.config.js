import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const host = process.env.TAURI_DEV_HOST;
export default defineConfig(async () => ({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    resolve: {
        dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
        include: ["react", "react-dom", "@phosphor-icons/react"],
    },
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: "ws", host, port: 1421 }
            : undefined,
        watch: {
            // Vite's HMR watcher must NOT see writes AKA itself makes while
            // it's running. The two paths that matter:
            //   • src-tauri — Rust build artefacts.
            //   • .äkä — every project AKA tracks gets a `.äkä/config.json`
            //     written on session-switch / agent-select / model-select.
            //     If the open AKA project is this very repo (self-hosting
            //     in dev), those writes land inside Vite's watch tree and
            //     trigger a page reload, which re-runs init, which re-
            //     writes config, which reloads again — infinite blink.
            //
            // Glob-string ignores like "**/.äkä/**" are unreliable on macOS
            // because the filesystem returns paths in decomposed Unicode
            // form ("a" + combining diaeresis) while the pattern is in
            // composed form ("ä"). The two are byte-different even though
            // they render identically. A function-based ignore that
            // normalises both sides before comparison sidesteps the issue.
            ignored: (path) => {
                const normalized = path.normalize("NFC");
                return (normalized.includes("/.äkä/") ||
                    normalized.endsWith("/.äkä") ||
                    normalized.includes("/src-tauri/") ||
                    normalized.endsWith("/src-tauri"));
            },
        },
    },
}));
