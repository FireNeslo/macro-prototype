// `jsx! { <div>...</div> }`: Solid 2 templates compiled by a macro, instead of babel-preset-solid.
//
// The macro emits the same runtime calls Solid's compiler does (`template`, `insert`, `effect`,
// `createComponent`, ...). The runtime is referenced as one hygienic binding: expansions import
// `@solidjs/web` directly (resolved from this module), so this module is not a runtime dependency.
import { TokenStream } from "std:compiler";
import * as web from "@solidjs/web";

// Only used inside the macro, so the plugin drops this import outside of compilation
import { compile } from "./compiler.ts";

export macro jsx(tokens: TokenStream): TokenStream {
    return compile(tokens, {
        runtime: import.meta.compile.identifier(web),
        hoist: (expression, name) => import.meta.compile.hoist(expression, name),
    });
}
