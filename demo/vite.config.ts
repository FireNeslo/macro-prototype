import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import macros from "vite-plugin-macros";

// Templates are compiled by the `jsx!` macro: the app has no JSX for Solid's compiler.
// Server functions are attribute macros (src/api.ts) that lower to Solid's "use server" forms,
// which Solid's plugin compiles. Macros run first, so Solid's plugin sees their output.
export default defineConfig({
    plugins: [macros(), solid({ serverFunctions: true })],
    optimizeDeps: {
        // Imported by the code Solid's plugin generates for "use server", which Vite's dependency
        // scan cannot see. Pre-bundling it up front avoids a re-bundle and page reload on first load.
        include: ["@solidjs/web/server-functions"],
    },
});
