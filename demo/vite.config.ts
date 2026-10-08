import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import macros from "vite-plugin-macros";

// Templates are compiled by the `jsx!` macro: the app has no JSX for Solid's compiler.
// Server functions are attribute macros (src/api.ts) that lower to Solid's "use server" forms,
// which Solid's plugin compiles. Macros run first, so Solid's plugin sees their output.
export default defineConfig({
    plugins: [macros(), solid({ serverFunctions: true })],
});
