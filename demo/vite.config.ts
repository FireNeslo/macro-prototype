import { defineConfig } from "vite";
import macros from "vite-plugin-macros";

// No vite-plugin-solid / babel-preset-solid: JSX is compiled by the `jsx!` macro.
export default defineConfig({
    plugins: [macros()],
});
