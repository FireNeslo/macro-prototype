# Compile-time macros in a Solid 2 app

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/FireNeslo/macro-prototype/tree/main/demo?file=src%2FApp.ts)

This is a prototype of **native compile-time macros for JavaScript**: functions that run while code
is being compiled, take source code as input, and return new source code. It is a feasibility
experiment for a possible TC39 proposal, not a proposal that has been submitted.

The demo is a Solid 2 app that uses macros for two things:

- **Templates.** `jsx! { … }` compiles JSX-like markup straight to Solid's DOM code. The app has no
  JSX for Solid's compiler to see.
- **Server functions.** `#[server]`, `#[server(GET)]` and `#[live]` mark functions whose code runs
  on the server. They lower to Solid 2's own server functions.

Everything runs in your browser: `npm install`, Vite 8, a fork of the Oxc parser that understands
macro syntax (compiled to WebAssembly), and a Vite plugin that expands the macros. The server
functions run in Node, also inside the browser tab (StackBlitz's WebContainer).

## The syntax

```ts
// Define an expression macro. It receives the tokens between the braces.
export macro html(tokens: TokenStream): TokenStream { … }

// Use it
const card = html! { <p>Hello</p> };

// Define an attribute macro. It receives the declaration it is attached to.
export macro attribute server(item: TokenStream): TokenStream { … }

// Use it
#[server]
export async function save(todo: Todo) { … }
```

A macro is a normal function, exported from a normal module, and imported by name. It does not get
the source as a string. It gets **token trees**: identifiers, punctuation, literals, and groups
delimited by `()`, `[]` or `{}`. It returns tokens too, usually built with a tagged template:

```ts
return tokenStream`${name}(${args})`;
```

Interpolated values become tokens, never source text. A string becomes a string literal, so
`${userInput}` cannot inject code. `import.meta.compile` gives a macro information about the
compilation: the target (`"client"` or `"server"`), and safe references to its own helpers.

## How it works

A Vite plugin (`packages/vite-plugin-macros`) runs before every other transform. For each module
it does four things:

1. **Parse.** The forked Oxc parser (`packages/oxc-parser`) reads the module, including the macro
   syntax. Macro bodies are captured as token trees and are not parsed as JavaScript. That is why
   `jsx! { … }` can contain markup.
2. **Load the macro.** The plugin evaluates the module that defines the macro in a separate
   compile-time environment, one per target (browser and server), so a macro can produce
   different code for each. Macro modules are never sent to the browser.
3. **Expand.** The plugin calls the macro with the tokens, prints the tokens it returns as code,
   and puts that code where the invocation was. When a macro refers to one of its own helpers,
   for example Solid's `insert` function, the plugin adds an import for it under a name that
   cannot clash with names in your code.
4. **Hand off.** The result is ordinary TypeScript. Vite, and Solid's plugin for server functions,
   compile it as usual.

### Example: `jsx!`

`src/App.ts` contains (simplified):

```ts
return jsx! {
    <section class={count() >= 5 ? "counter hot" : "counter"}>
        <h2>{props.label}: <output>{count()}</output></h2>
        <button id="increment" onClick={() => setCount((c) => c + 1)}>+1</button>
        …
    </section>
};
```

The macro is defined in `packages/solid-jsx-macro/jsx.ts`:

```ts
import * as web from "@solidjs/web";
import { compile } from "./compiler.ts";

export macro jsx(tokens: TokenStream): TokenStream {
    return compile(tokens, {
        runtime: import.meta.compile.identifier(web),
        hoist: (expression, name) => import.meta.compile.hoist(expression, name),
    });
}
```

`compiler.ts` reads the markup from the tokens and generates the same calls Solid's own compiler
would. It is imported normally: only the macro uses it, so the plugin drops that import from
everything that runs in the browser. The browser receives this (shortened):

```js
import * as $m_web from "/node_modules/.vite/deps/@solidjs_web.js";
const $h_tmpl = $m_web.template("<section><h2><!>: <output></output></h2><button id=\"increment\">+1</button>…</section>");

return (() => {
    const _el$ = $h_tmpl();
    const _el$_1 = _el$.firstChild;
    …
    $m_web.effect(() => count() >= 5 ? "counter hot" : "counter", (value, previous) => $m_web.className(_el$, value, previous));
    $m_web.insert(_el$_1, () => props.label, _el$_2);
    $m_web.addEvent(_el$_4, "click", () => setCount((c) => c + 1), true);
    return _el$;
})();
```

- The static HTML becomes a template, created once per module (`import.meta.compile.hoist`).
- Dynamic parts become effects and inserts, so only they update when signals change.
- `$m_web` and `_el$` are names the plugin picked so they cannot clash with yours.
- Your code does not import Solid's DOM functions; the macro brings them along.

### Example: server functions

`src/api.ts` contains (simplified):

```ts
#[server(GET)]
export async function loadTodos(): Promise<Todo[]> {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile("todos.json", "utf8"));
}
```

The `server` macro (`packages/solid-server-macros/server.ts`) rewrites this to Solid 2's own form:

```ts
export const loadTodos = $m_GET(async function loadTodos(): Promise<Todo[]> {
    "use server";
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile("todos.json", "utf8"));
});
```

Solid's Vite plugin then compiles `"use server"` as it normally would. The server build keeps the
function body. The browser gets only a reference that calls it over HTTP:

```js
export const loadTodos = $m_GET(createServerReference_1("loadTodos-9832c6f0", "loadTodos"));
```

So the macros do not reimplement server functions. They give them a syntax and hand them to the
framework's existing compiler.

| Macro | Becomes | Used for |
| --- | --- | --- |
| `#[server]` | a `"use server"` function (POST) | writes: `saveTodos` |
| `#[server(GET)]` | `GET(…)` | reads that can be cached: `loadTodos`, `serverInfo` |
| `#[live]` | `live(…)` | a stream of values that reconnects: `serverClock` |

`src/App.ts` uses them with Solid 2's async primitives:
- `createMemo(() => loadTodos())` reads from the server, shown inside `<Loading>`.
- `action()` with `createOptimistic()` shows a new todo at once, saves it with `saveTodos`, then
  refreshes the list from the server.

## What runs where

| When | Where | What |
| --- | --- | --- |
| Compile time | Node, inside Vite | The plugin, the parser, and the macro modules: `jsx.ts`, `compiler.ts`, `server.ts` |
| Run time, server | Node, in Vite's server environment | The bodies of the server functions in `src/api.ts` |
| Run time, browser | The page | The expanded `src/*.ts` and Solid's runtime |

## Try it

- **See the compiled code.** In the preview's address bar, add `/src/App.ts` or `/src/api.ts` to
  the URL.
- **Change the compiler.** Edit `packages/solid-jsx-macro/compiler.ts`. The app recompiles with
  your change.
- **Watch the server work.** Add a todo: `todos.json` appears in the file tree, written by
  `saveTodos` on the server.

## Limitations

- **Editor support.** StackBlitz's editor has no grammar for macro syntax, so `#[server]`,
  `jsx! { … }` and `export macro` are highlighted oddly and may show errors. A project cannot
  add a grammar to StackBlitz's editor. In VS Code this could be fixed with a grammar extension
  and a TypeScript plugin; that has not been built yet.
- **Text in `jsx!`.** The markup is read as tokens, so text cannot contain unbalanced quotes:
  write `{"don't"}` rather than `don't`.
- **Server functions need the dev server.** This demo has no production server build.

## Files

| File | What |
| --- | --- |
| `src/App.ts` | The app: components written with `jsx! { … }` |
| `src/api.ts` | Server functions: `#[server]`, `#[server(GET)]`, `#[live]` |
| `packages/solid-jsx-macro/jsx.ts` | The `jsx` macro |
| `packages/solid-jsx-macro/compiler.ts` | Compile-time code: reads JSX from tokens, generates Solid 2 DOM code |
| `packages/solid-server-macros/server.ts` | The server function macros (they emit `"use server"`) |
| `packages/vite-plugin-macros/` | The Vite plugin that expands macros |
| `packages/oxc-parser/` | The forked Oxc parser, as WebAssembly |
