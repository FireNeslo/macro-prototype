// Solid 2 server functions as attribute macros. They lower to Solid's own `"use server"` forms,
// which Solid's Vite plugin (`serverFunctions: true`) compiles: function ids, client references,
// the /_server endpoint, and production server builds.
//
//   #[server]         export async function save(todos) {…}    → POST (the default transport)
//   #[server(GET)]    export async function load() {…}         → GET(…): cacheable, preloadable reads
//   #[live]           export async function* clock() {…}       → live(…): a value stream that reconnects
//
// The wrappers are referenced with `import.meta.compile.identifier()`, so consumers import nothing
// from @solidjs/web themselves, and this macro module is a build-time-only dependency.
import { type TokenStream, tokenStream } from "std:compiler";
import { GET, live as liveSource } from "@solidjs/web/server-functions";

/** `[export] async function name(params) { body }` with `"use server"` first in the body, wrapped. */
function lower(item: TokenStream, wrappers: TokenStream[]): TokenStream {
    const tokens = [...item];
    const exported = tokens[0]?.type === "ident" && tokens[0].value === "export";
    const name = item.extractIdentifier();
    const body = item.extractBody();
    const head = item.slice(exported ? 1 : 0, tokens.lastIndexOf(body));
    const fn = tokenStream`${head} { "use server"; ${body.tokens} }`;
    const prefix = exported ? tokenStream`export` : tokenStream``;
    if (wrappers.length === 0) return tokenStream`${prefix} ${fn}`;
    const wrapped = wrappers.reduceRight((inner, wrap) => tokenStream`${wrap}(${inner})`, fn);
    return tokenStream`${prefix} const ${name} = ${wrapped};`;
}

function hasGET(args: TokenStream | undefined): boolean {
    return args !== undefined && [...args].some((token) => token.type === "ident" && token.value === "GET");
}

export macro attribute server(item: TokenStream, args?: TokenStream): TokenStream {
    return lower(item, hasGET(args) ? [tokenStream`${import.meta.compile.identifier(GET)}`] : []);
}

export macro attribute live(item: TokenStream, args?: TokenStream): TokenStream {
    const wrappers = [tokenStream`${import.meta.compile.identifier(liveSource)}`];
    if (hasGET(args)) wrappers.push(tokenStream`${import.meta.compile.identifier(GET)}`);
    return lower(item, wrappers);
}
