# Solid 2, compiled by a `jsx!` macro

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)

A Solid 2 app built with **compile-time macros**, a prototype for a TC39 strawman on native macros
(`export macro`, `#[attribute]`, `name! { … }`):

- **Templates**: `jsx! { … }` compiles JSX-like markup straight to Solid 2 DOM code. The app has no
  JSX for Solid's compiler.
- **Server functions**: `#[server]` (POST), `#[server(GET)]` (cacheable reads) and `#[live]`
  (a value stream that reconnects) lower to Solid 2's own `"use server"` functions, which Solid's
  Vite plugin compiles. The macros compose with the framework's compiler instead of replacing it.

Everything runs in the browser on StackBlitz (WebContainers): `npm install`, Vite 8, a fork of the
Oxc parser that understands macro syntax (compiled to WebAssembly), and a Vite plugin that expands
the macros. Server functions run in Node inside the WebContainer: adding a todo writes `todos.json`.

## What to look at

| File | What |
| --- | --- |
| `src/App.ts` | The app: components written with `jsx! { … }` |
| `src/api.ts` | Server functions: `#[server]`, `#[server(GET)]`, `#[live]` |
| `packages/solid-server-macros/server.ts` | The server function macros (they emit `"use server"`) |
| `packages/solid-jsx-macro/jsx.ts` | The macro: `export macro jsx(tokens) { … }` |
| `packages/solid-jsx-macro/compiler.ts` | Compile-time code: parses JSX from token trees, emits Solid 2 DOM calls |
| `packages/vite-plugin-macros/` | The Vite plugin that runs macros in an isolated compile VM |
| `packages/oxc-parser/` | The forked Oxc parser, as WebAssembly |

Edit `src/App.ts` or the compiler and the app recompiles. To see what the macro generated, open
`/src/App.ts` on the preview URL (for example `https://…webcontainer-api.io/src/App.ts`).

The runtime only contains Solid: the macros, the JSX compiler and the plugin run at compile time.
