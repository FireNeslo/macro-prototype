// `jsx! { <div>...</div> }`: Solid 2 templates compiled by a macro, instead of babel-preset-solid.
//
// The macro emits the same runtime calls Solid's compiler does (`template`, `insert`, `effect`,
// `createComponent`, ...). The runtime is referenced as one hygienic binding: expansions import
// `@solidjs/web` directly (resolved from this module), so this module is not a runtime dependency.
import { TokenStream } from "std:compiler";
import * as web from "@solidjs/web";

export macro jsx(tokens: TokenStream): TokenStream {
    // Compile-time only dependency: not part of the runtime module graph
    const { compile } = import.meta.compile.import("./compiler.ts") as typeof import("./compiler.ts");
    return compile(tokens, {
        runtime: import.meta.compile.identifier(web),
        hoist: (expression, name) => import.meta.compile.hoist(expression, name),
    });
}
