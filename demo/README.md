# Solid 2, compiled by a `jsx!` macro

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo)

A Solid 2 app whose JSX templates are compiled by a **compile-time macro** (`jsx! { … }`) instead
of Solid's Babel compiler. It is a prototype for a TC39 strawman on native compile-time macros
(`export macro`, `#[attribute]`, `name! { … }`).

Everything runs in the browser on StackBlitz (WebContainers): `npm install`, Vite 8, a fork of the
Oxc parser that understands macro syntax (compiled to WebAssembly), and a Vite plugin that expands
the macros.

## What to look at

| File | What |
| --- | --- |
| `src/App.ts` | The app: components written with `jsx! { … }` |
| `packages/solid-jsx-macro/jsx.ts` | The macro: `export macro jsx(tokens) { … }` |
| `packages/solid-jsx-macro/compiler.ts` | Compile-time code: parses JSX from token trees, emits Solid 2 DOM calls |
| `packages/vite-plugin-macros/` | The Vite plugin that runs macros in an isolated compile VM |
| `packages/oxc-parser/` | The forked Oxc parser, as WebAssembly |

Edit `src/App.ts` or the compiler and the app recompiles. To see what the macro generated, open
`/src/App.ts` on the preview URL (for example `https://…webcontainer-api.io/src/App.ts`).

The runtime only contains Solid: the macro, its compiler and the plugin run at compile time.
