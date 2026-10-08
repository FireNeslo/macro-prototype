# Compile-time macros for JavaScript

A prototype exploring native compile-time macros for ECMAScript:

```js
export macro html(tokens) { … }        // a macro, evaluated at compile time
export const card = html! { <p>hi</p> }; // an expression macro invocation
#[server] async function save() { … }    // an attribute macro
```

Macros receive token trees, run in an isolated compile-time environment, and return token
streams that replace the invocation. This repository is an early feasibility prototype, not a
proposal submitted to TC39.

## Demo

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)

**[Open the demo on StackBlitz](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)**:
a Solid 2 app whose templates are compiled by a `jsx! { … }` macro, with server functions declared
as attribute macros (`#[server]`, `#[server(GET)]`, `#[live]`) that lower to Solid 2's own
`"use server"` functions. It runs in your browser: Vite 8, a fork of the Oxc parser with macro
syntax (as WebAssembly), and a Vite plugin that expands the macros. Edit the app or a macro and it
recompiles. See [`demo/README.md`](demo/README.md).
