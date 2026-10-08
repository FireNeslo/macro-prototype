// Compile-time half of `jsx!`: parses JSX from token trees and generates Solid 2 DOM code.
//
// Output mirrors babel-preset-solid 2.0 (`generate: "dom"`):
//   - static HTML goes into a `template()`, hoisted to module scope and created once,
//   - dynamic children are `insert()`ed before `<!>` markers,
//   - dynamic attributes are `effect(compute, apply)`,
//   - delegated events are set with `addEvent(el, name, handler, true)` + `delegateEvents()`,
//   - components are `createComponent(Comp, props)` with getters for reactive props.
//
// JSX is parsed from tokens, not text: `{...}` expression containers are already token groups,
// and user expressions are spliced into the output as tokens, so they keep their scope.
import { type IdentToken, type TokenStream, type TokenTree, fresh, group, ident, literal, tokenStream } from "std:compiler";

export interface CompileOptions {
    /** The `@solidjs/web` module namespace. */
    runtime: IdentToken;
    hoist: (expression: TokenStream, name?: string) => IdentToken;
}

const RUNTIME = [
    "addEvent", "className", "createComponent", "delegateEvents", "effect", "insert", "memo",
    "mergeProps", "ref", "setAttribute", "spread", "style", "template",
] as const;

/** `runtime.insert` etc., as member accesses on the runtime namespace. */
type Runtime = Record<(typeof RUNTIME)[number], TokenStream>;

interface Options {
    runtime: Runtime;
    hoist: CompileOptions["hoist"];
}

type Attribute =
    | { kind: "static"; name: string; value: string | true }
    | { kind: "dynamic"; name: string; expression: TokenStream }
    | { kind: "spread"; expression: TokenStream };

type JSXNode =
    | { type: "element"; tag: string; tagTokens: TokenStream; attributes: Attribute[]; children: JSXNode[] }
    | { type: "fragment"; children: JSXNode[] }
    | { type: "text"; value: string }
    | { type: "expression"; expression: TokenStream };

// From @solidjs/web `DelegatedEvents`
const DELEGATED_EVENTS = new Set([
    "beforeinput", "click", "dblclick", "contextmenu", "focusin", "focusout", "input", "keydown", "keyup",
    "mousedown", "mousemove", "mouseout", "mouseover", "mouseup", "pointerdown", "pointermove", "pointerout",
    "pointerover", "pointerup", "touchend", "touchmove", "touchstart",
]);

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Tokens before which `<` starts JSX rather than being a comparison (as in TSX). */
const JSX_AFTER_PUNCT = new Set(["=>", ",", "?", ":", "&&", "||", "??", "=", "!", "(", "[", "{", ";"]);
const JSX_AFTER_KEYWORD = new Set(["return", "yield", "default", "case", "else", "in", "of"]);

export function compile(tokens: TokenStream, { runtime, hoist }: CompileOptions): TokenStream {
    const members = RUNTIME.map((name) => [name, tokenStream`${runtime}.${ident(name)}`]);
    const options: Options = { runtime: Object.fromEntries(members) as Runtime, hoist };
    const parser = new Parser(tokens, options);
    const nodes: JSXNode[] = [];
    while (!parser.done()) {
        if (!parser.isPunct(0, "<")) throw parser.error("expected a JSX element");
        nodes.push(parser.element());
    }
    if (nodes.length === 0) throw new SyntaxError("jsx!: empty template");
    return generate(nodes.length === 1 ? nodes[0] : { type: "fragment", children: nodes }, options);
}

// ------------------------------------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------------------------------------

class Parser {
    readonly stream: TokenStream;
    readonly options: Options;
    readonly list: TokenTree[];
    index = 0;

    constructor(stream: TokenStream, options: Options, index = 0) {
        this.stream = stream;
        this.options = options;
        this.list = [...stream];
        this.index = index;
    }

    done(): boolean {
        return this.index >= this.list.length;
    }

    peek(offset = 0): TokenTree | undefined {
        return this.list[this.index + offset];
    }

    isPunct(offset: number, value: string): boolean {
        const token = this.peek(offset);
        return token?.type === "punct" && token.value === value;
    }

    /** No whitespace between token `index - 1` and token `index`. */
    adjacent(index: number): boolean {
        return this.stream.whitespaceBefore(index) === "";
    }

    error(message: string): SyntaxError {
        const near = this.stream.slice(this.index, this.index + 6).toString();
        return new SyntaxError(`jsx!: ${message}, near \`${near}\``);
    }

    expectPunct(value: string): void {
        if (!this.isPunct(0, value)) throw this.error(`expected \`${value}\``);
        this.index++;
    }

    /** Tag or attribute name: `div`, `my-element`, `Foo.Bar`, `on:click`, `aria-label`. */
    name(separators: string): { text: string; tokens: TokenStream } {
        const start = this.index;
        const first = this.peek();
        if (first?.type !== "ident") throw this.error("expected a name");
        let text = first.value;
        this.index++;
        while (true) {
            const separator = this.peek();
            const next = this.peek(1);
            if (
                separator?.type === "punct" &&
                separators.includes(separator.value) &&
                next?.type === "ident" &&
                this.adjacent(this.index) &&
                this.adjacent(this.index + 1)
            ) {
                text += separator.value + next.value;
                this.index += 2;
            } else {
                break;
            }
        }
        return { text, tokens: this.stream.slice(start, this.index) };
    }

    /** Cursor at `<`. */
    element(): JSXNode {
        this.expectPunct("<");
        if (this.isPunct(0, ">")) {
            this.index++;
            return { type: "fragment", children: this.children("") };
        }
        const { text: tag, tokens: tagTokens } = this.name("-.:");
        const attributes: Attribute[] = [];
        while (true) {
            const token = this.peek();
            if (!token) throw this.error(`unterminated <${tag}>`);
            if (this.isPunct(0, "/") && this.isPunct(1, ">")) {
                this.index += 2;
                return { type: "element", tag, tagTokens, attributes, children: [] };
            }
            if (this.isPunct(0, ">")) {
                this.index++;
                const children = VOID_ELEMENTS.has(tag) ? [] : this.children(tag);
                return { type: "element", tag, tagTokens, attributes, children };
            }
            if (token.type === "group" && token.delimiter === "{}") {
                const inner = [...token.tokens];
                if (inner[0]?.type !== "punct" || inner[0].value !== "...") throw this.error("expected {...spread}");
                attributes.push({ kind: "spread", expression: expressions(token.tokens.slice(1), this.options) });
                this.index++;
                continue;
            }
            const { text: name } = this.name("-:");
            if (!this.isPunct(0, "=")) {
                attributes.push({ kind: "static", name, value: true });
                continue;
            }
            this.index++;
            const value = this.peek();
            if (value?.type === "literal" && value.kind === "string") {
                attributes.push({ kind: "static", name, value: value.value as string });
            } else if (value?.type === "group" && value.delimiter === "{}") {
                attributes.push({ kind: "dynamic", name, expression: expressions(value.tokens, this.options) });
            } else {
                throw this.error(`expected a string or {expression} as the value of ${name}`);
            }
            this.index++;
        }
    }

    /** Children up to and including `</tag>` (`</>` for fragments). */
    children(tag: string): JSXNode[] {
        const children: JSXNode[] = [];
        const addText = (raw: string) => {
            const value = jsxText(raw);
            if (value) children.push({ type: "text", value });
        };
        let afterText = false;
        while (true) {
            const token = this.peek();
            if (!token) throw this.error(`unterminated <${tag}>`);
            const startsChild = this.isPunct(0, "<") || (token.type === "group" && token.delimiter === "{}");
            // Whitespace between two non-text children, e.g. `<b>a</b> <i>b</i>`
            if (startsChild && !afterText) addText(this.stream.whitespaceBefore(this.index) ?? "");
            afterText = false;
            if (this.isPunct(0, "<") && this.isPunct(1, "/")) {
                this.index += 2;
                const closing = tag === "" ? "" : this.name("-.:").text;
                if (closing !== tag) throw this.error(`expected </${tag}>, found </${closing}>`);
                this.expectPunct(">");
                return children;
            }
            if (this.isPunct(0, "<")) {
                children.push(this.element());
            } else if (token.type === "group" && token.delimiter === "{}") {
                if (token.tokens.length > 0) {
                    children.push({ type: "expression", expression: expressions(token.tokens, this.options) });
                }
                this.index++;
            } else {
                // Text: tokens up to the next `<` or `{`, with the whitespace around and between them
                const start = this.index;
                while (
                    !this.done() &&
                    !this.isPunct(0, "<") &&
                    !(this.peek()!.type === "group" && (this.peek() as { delimiter: string }).delimiter === "{}")
                ) {
                    this.index++;
                }
                const raw =
                    (this.stream.whitespaceBefore(start) ?? "") +
                    this.stream.slice(start, this.index).toString() +
                    (this.stream.whitespaceBefore(this.index) ?? "");
                addText(raw);
                afterText = true;
            }
        }
    }
}

/** JSX whitespace rules (as Babel's `cleanJSXElementLiteralChild`). */
function jsxText(raw: string): string {
    const lines = raw.split(/\r\n|\n|\r/);
    let lastNonEmpty = 0;
    lines.forEach((line, index) => {
        if (/[^ \t]/.test(line)) lastNonEmpty = index;
    });
    let text = "";
    lines.forEach((line, index) => {
        let trimmed = line.replace(/\t/g, " ");
        if (index !== 0) trimmed = trimmed.replace(/^[ ]+/, "");
        if (index !== lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, "");
        if (trimmed) {
            if (index !== lastNonEmpty) trimmed += " ";
            text += trimmed;
        }
    });
    return text;
}

/** Compile JSX nested inside an expression, e.g. `{items.map((item) => <li>{item}</li>)}`. */
function expressions(stream: TokenStream, options: Options): TokenStream {
    let result = stream;
    let list = [...result];
    for (let index = 0; index < list.length; index++) {
        const token = list[index];
        if (token.type === "group") {
            const inner = expressions(token.tokens, options);
            if (inner !== token.tokens) {
                result = result.splice(index, 1, group(token.delimiter, inner));
                list = [...result];
            }
        } else if (startsJSX(list, index)) {
            const parser = new Parser(result, options, index);
            const compiled = generate(parser.element(), options);
            result = result.splice(index, parser.index - index, compiled);
            list = [...result];
            index += compiled.length - 1;
        }
    }
    return result;
}

function startsJSX(list: TokenTree[], index: number): boolean {
    const token = list[index];
    const next = list[index + 1];
    if (token.type !== "punct" || token.value !== "<") return false;
    if (!(next?.type === "ident" || (next?.type === "punct" && next.value === ">"))) return false;
    const previous = list[index - 1];
    if (!previous) return true;
    if (previous.type === "punct") return JSX_AFTER_PUNCT.has(previous.value);
    return previous.type === "ident" && JSX_AFTER_KEYWORD.has(previous.value);
}

// ------------------------------------------------------------------------------------------------
// Code generation
// ------------------------------------------------------------------------------------------------

function generate(node: JSXNode, options: Options): TokenStream {
    switch (node.type) {
        case "text":
            return tokenStream`${node.value}`;
        case "expression":
            return node.expression;
        case "fragment":
            return node.children.length === 1
                ? childValue(node.children[0], options)
                : tokenStream`[${join(node.children.map((child) => childValue(child, options)))}]`;
        case "element":
            return isComponent(node.tag) ? component(node, options) : element(node, options);
    }
}

function isComponent(tag: string): boolean {
    return /^[A-Z]/.test(tag) || tag.includes(".");
}

/** Value of a fragment or component child. */
function childValue(node: JSXNode, options: Options): TokenStream {
    if (node.type === "expression" && !isStatic(node.expression)) {
        return tokenStream`${options.runtime.memo}(() => ${node.expression})`;
    }
    return generate(node, options);
}

/** Does not need to be wrapped in a getter or accessor to stay reactive. */
function isStatic(expression: TokenStream): boolean {
    const tokens = [...expression];
    if (tokens.length === 1) return tokens[0].type === "literal" || tokens[0].type === "ident";
    let index = tokens[0]?.type === "ident" && tokens[0].value === "async" ? 1 : 0;
    const first = tokens[index];
    if (first?.type === "ident" && first.value === "function") return true;
    if (first?.type === "ident" || (first?.type === "group" && first.delimiter === "()")) {
        const arrow = tokens[index + 1];
        return arrow?.type === "punct" && arrow.value === "=>";
    }
    return false;
}

function join(items: TokenStream[], separator = tokenStream`,`): TokenStream[] {
    return items.flatMap((item, index) => (index === 0 ? [item] : [separator, item]));
}

function propertyKey(name: string): TokenStream {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? tokenStream`${ident(name)}` : tokenStream`${name}`;
}

function component(node: Extract<JSXNode, { type: "element" }>, options: Options): TokenStream {
    const { runtime } = options;
    const segments: TokenStream[] = [];
    let entries: TokenStream[] = [];
    const flush = () => {
        if (entries.length > 0 || segments.length === 0) segments.push(tokenStream`{ ${join(entries)} }`);
        entries = [];
    };
    for (const attribute of node.attributes) {
        if (attribute.kind === "spread") {
            if (entries.length > 0) flush();
            segments.push(attribute.expression);
            continue;
        }
        const key = propertyKey(attribute.name);
        if (attribute.kind === "static") {
            entries.push(tokenStream`${key}: ${attribute.value}`);
        } else if (isStatic(attribute.expression)) {
            entries.push(tokenStream`${key}: ${attribute.expression}`);
        } else {
            entries.push(tokenStream`get ${key}() { return ${attribute.expression}; }`);
        }
    }
    const { children } = node;
    if (children.length === 1 && children[0].type === "expression" && isStatic(children[0].expression)) {
        // e.g. `<For each={items}>{(item) => ...}</For>`
        entries.push(tokenStream`children: ${children[0].expression}`);
    } else if (children.length === 1) {
        entries.push(tokenStream`get children() { return ${generate(children[0], options)}; }`);
    } else if (children.length > 1) {
        entries.push(tokenStream`get children() { return [${join(children.map((child) => childValue(child, options)))}]; }`);
    }
    flush();
    const props = segments.length === 1 ? segments[0] : tokenStream`${runtime.mergeProps}(${join(segments)})`;
    return tokenStream`${runtime.createComponent}(${node.tagTokens}, ${props})`;
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
    return value.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;");
}

function element(root: Extract<JSXNode, { type: "element" }>, options: Options): TokenStream {
    const { runtime } = options;
    const rootVariable = fresh("el");
    const variables = new Map<string, IdentToken>([["", rootVariable]]);
    const declarations: TokenStream[] = [];
    const operations: TokenStream[] = [];
    const events = new Set<string>();
    let html = "";

    /** Variable for the node at `path`, declared before any DOM is modified. */
    const nodeAt = (path: number[]): IdentToken => {
        const key = path.join(",");
        let variable = variables.get(key);
        if (!variable) {
            variable = fresh("el");
            variables.set(key, variable);
            let access = tokenStream`${rootVariable}`;
            for (const index of path) {
                access = tokenStream`${access}.firstChild`;
                for (let i = 0; i < index; i++) access = tokenStream`${access}.nextSibling`;
            }
            declarations.push(tokenStream`const ${variable} = ${access};`);
        }
        return variable;
    };

    const attribute = (target: IdentToken, name: string, expression: TokenStream) => {
        if (name.startsWith("on:")) {
            operations.push(tokenStream`${runtime.addEvent}(${target}, ${name.slice(3)}, ${expression});`);
        } else if (/^on[A-Z]/.test(name)) {
            const event = name.slice(2).toLowerCase();
            if (DELEGATED_EVENTS.has(event)) {
                events.add(event);
                operations.push(tokenStream`${runtime.addEvent}(${target}, ${event}, ${expression}, true);`);
            } else {
                operations.push(tokenStream`${runtime.addEvent}(${target}, ${event}, ${expression});`);
            }
        } else if (name === "ref") {
            const tokens = [...expression];
            if (tokens.length === 1 && tokens[0].type === "ident") {
                // `let el; <div ref={el} />` assigns; a function or array ref is called
                operations.push(
                    tokenStream`typeof ${expression} === "function" || Array.isArray(${expression}) ? ${runtime.ref}(() => ${expression}, ${target}) : ${expression} = ${target};`,
                );
            } else {
                operations.push(tokenStream`${runtime.ref}(() => ${expression}, ${target});`);
            }
        } else if (name === "class") {
            operations.push(tokenStream`${runtime.effect}(() => ${expression}, (value, previous) => ${runtime.className}(${target}, value, previous));`);
        } else if (name === "style") {
            operations.push(tokenStream`${runtime.effect}(() => ${expression}, (value, previous) => ${runtime.style}(${target}, value, previous));`);
        } else if (name === "value") {
            operations.push(tokenStream`${runtime.effect}(() => ${expression}, (value) => { ${target}.value = value ?? ""; });`);
        } else if (name === "checked") {
            operations.push(tokenStream`${runtime.effect}(() => ${expression}, (value) => { ${target}.checked = !!value; });`);
        } else {
            operations.push(tokenStream`${runtime.effect}(() => ${expression}, (value) => ${runtime.setAttribute}(${target}, ${name}, value));`);
        }
    };

    const isDynamic = (node: JSXNode) =>
        node.type === "expression" || node.type === "fragment" || (node.type === "element" && isComponent(node.tag));

    const visit = (node: Extract<JSXNode, { type: "element" }>, path: number[]) => {
        html += `<${node.tag}`;
        for (const attr of node.attributes) {
            if (attr.kind === "static") {
                html += attr.value === true ? ` ${attr.name}` : ` ${attr.name}="${escapeAttribute(attr.value)}"`;
            } else if (attr.kind === "dynamic") {
                attribute(nodeAt(path), attr.name, attr.expression);
            } else {
                const skipChildren = node.children.length > 0;
                operations.push(tokenStream`${runtime.spread}(${nodeAt(path)}, ${attr.expression}, ${skipChildren});`);
            }
        }
        html += ">";
        if (VOID_ELEMENTS.has(node.tag)) return;

        const onlyChildIsDynamic = node.children.length === 1 && isDynamic(node.children[0]);
        let index = 0;
        for (const child of node.children) {
            if (child.type === "text") {
                html += escapeText(child.value);
                index++;
            } else if (!isDynamic(child)) {
                visit(child as Extract<JSXNode, { type: "element" }>, [...path, index]);
                index++;
            } else {
                const value = child.type === "expression" && !isStatic(child.expression)
                    ? tokenStream`() => ${child.expression}`
                    : generate(child, options);
                if (onlyChildIsDynamic) {
                    operations.push(tokenStream`${runtime.insert}(${nodeAt(path)}, ${value});`);
                } else {
                    html += "<!>";
                    operations.push(tokenStream`${runtime.insert}(${nodeAt(path)}, ${value}, ${nodeAt([...path, index])});`);
                    index++;
                }
            }
        }
        html += `</${node.tag}>`;
    };

    visit(root, []);

    const templateFactory = options.hoist(tokenStream`${runtime.template}(${html})`, "tmpl");
    if (declarations.length === 0 && operations.length === 0) return tokenStream`${templateFactory}()`;
    if (events.size > 0) {
        // `delegateEvents` once per module, like Solid's compiler
        operations.push(tokenStream`${options.hoist(tokenStream`${runtime.delegateEvents}(${literal([...events].sort())})`, "events")};`);
    }
    return tokenStream`(() => {
        const ${rootVariable} = ${templateFactory}();
        ${declarations}
        ${operations}
        return ${rootVariable};
    })()`;
}
