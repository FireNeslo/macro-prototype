# Compile-time macros for JavaScript

A prototype of native compile-time macros for ECMAScript: functions that run while code is being
compiled, receive source code as tokens, and return new code.

```js
export macro html(tokens) { … }            // define a macro
export const card = html! { <p>hi</p> };    // expression macro
#[server] async function save() { … }       // attribute macro
```

This is an early feasibility prototype, not a proposal submitted to TC39.

## Demo

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)

**[Open the demo on StackBlitz](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)**.
It is a Solid 2 app whose templates are compiled by a `jsx! { … }` macro, with server functions
declared as attribute macros (`#[server]`, `#[server(GET)]`, `#[live]`) that lower to Solid 2's
own server functions. It runs in your browser: Vite 8, a fork of the Oxc parser with macro syntax
(as WebAssembly), and a Vite plugin that expands the macros.

**[How it works](demo/README.md#how-it-works)**: the syntax, how the plugin expands macros,
what the macros generate, and what runs where.
