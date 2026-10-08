/**
* `std:compiler` — compile-phase implementation.
*
* This module is evaluated inside the compile VM (a Vite module runner), once per compilation
* target. Macro modules import it as `std:compiler`.
*
* - Annex surface: `TokenStream`, `tokenStream`, and the `TokenTree` shapes.
* - Prototype extensions are marked `@extension`. They are things the spec examples call but the
*   annex does not define, or gaps found while implementing.
* - Exports prefixed with `__` are used by the host plugin and by code the plugin generates.
*/
import { MACRO_BRAND, hiddenExportName } from "./shared.js";
const POSITION = Symbol("std:compiler.position");
const REFERENCE = Symbol("std:compiler.reference");
const FRESH = Symbol("std:compiler.fresh");
const HOISTED = Symbol("std:compiler.hoisted");
function makeToken(fields, position, reference, hidden) {
	if (position) Object.defineProperty(fields, POSITION, { value: position });
	if (reference) Object.defineProperty(fields, REFERENCE, { value: reference });
	if (hidden?.[FRESH]) Object.defineProperty(fields, FRESH, { value: hidden[FRESH] });
	if (hidden?.[HOISTED]) Object.defineProperty(fields, HOISTED, { value: hidden[HOISTED] });
	return Object.freeze(fields);
}
function positionOf(token) {
	return token[POSITION];
}
function referenceOf(token) {
	return token[REFERENCE];
}
function isTokenTree(value) {
	if (typeof value !== "object" || value === null) return false;
	const type = value.type;
	return type === "ident" || type === "punct" || type === "literal" || type === "group";
}
let getGaps;
export class TokenStream {
	#tokens;
	/**
	* Whitespace and comments before each token, as written in its source (`null` if unknown).
	* Stored per stream, not per token: a token spliced into a template takes the template's text
	* around the `${}`, not the text around it in the source it came from. This keeps statement
	* boundaries (ASI) as the template author wrote them.
	*/
	#gaps;
	static {
		getGaps = (stream) => stream.#gaps;
	}
	constructor(tokens = [], gaps) {
		const list = [...tokens];
		for (const token of list) {
			if (!isTokenTree(token)) throw new TypeError(`TokenStream: not a token tree: ${String(token)}`);
		}
		this.#tokens = Object.freeze(list);
		this.#gaps = Object.freeze(gaps ?? new Array(list.length + 1).fill(null));
	}
	/** @extension Convert any interpolation value into a stream. */
	static from(value) {
		if (value instanceof TokenStream) return value;
		const { tokens, gaps } = interpolationTokens(value);
		return new TokenStream(tokens, [...gaps, null]);
	}
	[Symbol.iterator]() {
		return this.#tokens[Symbol.iterator]();
	}
	/** @extension */
	get length() {
		return this.#tokens.length;
	}
	/** @extension */
	at(index) {
		return this.#tokens.at(index);
	}
	/** @extension */
	slice(start, end) {
		const tokens = this.#tokens.slice(start, end);
		const from = start === undefined ? 0 : start < 0 ? Math.max(this.length + start, 0) : start;
		return new TokenStream(tokens, this.#gaps.slice(from, from + tokens.length + 1));
	}
	/**
	* @extension Whitespace and comments before token `index` as written in source
	* (`index === length`: before the closing delimiter), or `null` if unknown.
	* The annex only records spacing after punctuators, which is not enough to recover text
	* (e.g. JSX text) or to tell `a-b` from `a -b`.
	*/
	whitespaceBefore(index) {
		return this.#gaps[index] ?? null;
	}
	/**
	* @extension Copy of this stream with `deleteCount` tokens at `start` replaced by `replacement`.
	* Unlike rebuilding a stream from tokens, this keeps the whitespace between the other tokens,
	* so statement boundaries (ASI) are preserved.
	*/
	splice(start, deleteCount, replacement) {
		const tokens = [...this.#tokens];
		const gaps = [...this.#gaps];
		const inserted = replacement === undefined ? {
			tokens: [],
			gaps: []
		} : interpolationTokens(replacement);
		if (inserted.tokens.length > 0) {
			inserted.gaps[0] = gaps[start];
		} else {
			gaps[start + deleteCount] = joinGaps(gaps[start], gaps[start + deleteCount]);
		}
		tokens.splice(start, deleteCount, ...inserted.tokens);
		gaps.splice(start, deleteCount, ...inserted.gaps);
		return new TokenStream(tokens, gaps);
	}
	/** @extension Print as source code, preserving original formatting where tokens are contiguous. */
	toString() {
		return printStream(this, null);
	}
	// Helpers called by the spec's `#[server]` example (§4, example 1). Not defined by the annex.
	/** @extension Name of the function, class, or variable declared by this item. */
	extractIdentifier() {
		const index = this.#declaredNameIndex();
		return this.#tokens[index];
	}
	/**
	* @extension Parameter list of the function declared by this item.
	* `declaration`: tokens inside `( )`. `names`: comma-separated parameter names, for forwarding.
	*/
	extractParameters() {
		const tokens = this.#tokens;
		let index = this.#declaredNameIndex() + 1;
		// Skip type parameters `<...>`
		if (isPunct(tokens[index], "<")) {
			let depth = 0;
			for (; index < tokens.length; index++) {
				const token = tokens[index];
				if (token.type !== "punct") continue;
				for (const char of token.value) {
					if (char === "<") depth++;
					else if (char === ">") depth--;
				}
				if (depth === 0) break;
			}
			index++;
		}
		const params = tokens[index];
		if (params?.type !== "group" || params.delimiter !== "()") {
			throw new SyntaxError("extractParameters: expected a function parameter list");
		}
		return {
			declaration: params.tokens,
			names: parameterNames(params.tokens)
		};
	}
	/** @extension Body `{ ... }` of the function or class declared by this item (the last top-level brace group). */
	extractBody() {
		for (let index = this.#tokens.length - 1; index >= 0; index--) {
			const token = this.#tokens[index];
			if (token.type === "group" && token.delimiter === "{}") return token;
		}
		throw new SyntaxError("extractBody: item has no body");
	}
	#declaredNameIndex() {
		const tokens = this.#tokens;
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			if (token.type !== "ident") continue;
			if ([
				"function",
				"class",
				"const",
				"let",
				"var"
			].includes(token.value)) {
				let next = index + 1;
				if (isPunct(tokens[next], "*")) next++;
				if (tokens[next]?.type === "ident") return next;
			}
		}
		throw new SyntaxError("extractIdentifier: item does not declare a function, class, or variable");
	}
}
function isPunct(token, value) {
	return token?.type === "punct" && token.value === value;
}
const PARAMETER_MODIFIERS = new Set([
	"public",
	"private",
	"protected",
	"readonly",
	"override"
]);
function parameterNames(params) {
	const names = [];
	const gaps = [""];
	const segments = [[]];
	for (const token of params) {
		if (isPunct(token, ",")) segments.push([]);
		else segments.at(-1).push(token);
	}
	for (const segment of segments) {
		let index = 0;
		while (segment[index]?.type === "ident" && PARAMETER_MODIFIERS.has(segment[index].value) && segment[index + 1]?.type === "ident") {
			index++;
		}
		const first = segment[index];
		if (first === undefined) continue;
		if (first.type === "ident" && first.value === "this") continue;
		if (names.length > 0) {
			names.push(makeToken({
				type: "punct",
				value: ",",
				spacing: "alone"
			}));
			gaps.push("", " ");
		}
		if (isPunct(first, "...")) {
			names.push(first);
			gaps.push("");
			index++;
		}
		const name = segment[index];
		if (name?.type !== "ident") {
			throw new SyntaxError("extractParameters: destructured parameters have no name to forward");
		}
		names.push(name);
	}
	return new TokenStream(names, gaps.slice(0, names.length + 1));
}
// ---------------------------------------------------------------------------------------------
// tokenStream`...` (annex §1)
// ---------------------------------------------------------------------------------------------
let nonceCounter = 0;
/**
* Build a token stream from a template. Interpolations are spliced in as tokens, never as text:
*
* - `TokenStream` / `TokenTree`: spliced as-is.
* - `string`: a string literal token (so `${userInput}` cannot inject code).
* - `number`, `boolean`, `bigint`: a literal token.
* - Arrays (extension): elements spliced in order.
*
* Inside a string or template literal of the template (e.g. `"${fnName}"`), the interpolation's
* text is inserted, escaped for that literal.
*/
export function tokenStream(strings, ...values) {
	const nonce = (nonceCounter++).toString(36);
	// Padded with spaces so a placeholder never lexes together with a neighbor (`${a}${b}`, `x${a}`).
	// `substitute` removes the padding from the recorded gaps.
	const placeholder = (index) => ` $__splice_${nonce}_${index}$ `;
	let text = "";
	strings.raw.forEach((raw, index) => {
		// Raw text is used so escapes like `\n` inside generated string literals stay escapes.
		// `\`` and `\${` can only be written escaped, so unescape them.
		text += raw.replace(/\\([`$])/g, "$1");
		if (index < values.length) text += placeholder(index);
	});
	const stream = tokenizeSource(text, "<tokenStream>");
	return substitute(stream, values, {
		token: new RegExp(`^\\$__splice_${nonce}_(\\d+)\\$$`),
		text: new RegExp(` \\$__splice_${nonce}_(\\d+)\\$ `, "g")
	});
}
/**
* @extension Identifier token with the given name. Token trees cannot concatenate identifiers
* (`${name}Tag` is two tokens), so macros that generate names need this (cf. Rust's `format_ident!`).
*/
export function ident(name) {
	const [token, ...rest] = typeof name === "string" ? tokenizeSource(name, "<ident>") : [];
	if (token?.type !== "ident" || rest.length > 0) throw new SyntaxError(`ident: not an identifier: ${String(name)}`);
	return makeToken({
		type: "ident",
		value: token.value
	});
}
/**
* @extension A new identifier that is printed under a name no other identifier in the consuming
* module has, so bindings a macro introduces (`const el = ...`) cannot capture or shadow names in
* user code spliced next to them. The annex only offers hygiene for references to the macro's
* own module (`identifier()`), not for bindings it introduces.
*/
export function fresh(base = "tmp") {
	return makeToken({
		type: "ident",
		value: base
	}, undefined, undefined, { [FRESH]: { base } });
}
/** @extension Delimited group token. The annex has no way to construct one except `tokenStream`. */
export function group(delimiter, tokens) {
	return makeToken({
		type: "group",
		delimiter,
		tokens: TokenStream.from(tokens)
	});
}
/** @extension Token stream for a JSON-compatible value (`[[0, 1]]`, `{ a: "b" }`, ...). */
export function literal(value) {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError(`literal: value is not JSON-compatible: ${String(value)}`);
	return tokenizeSource(json, "<literal>");
}
function joinGaps(first, second) {
	return first === null ? second : second === null ? first : first + second;
}
function substitute(stream, values, placeholders) {
	const tokens = [];
	const gaps = [];
	const sourceGaps = getGaps(stream);
	let pendingGap = null;
	let afterPlaceholder = false;
	let index = 0;
	const unpad = (gap, start, end) => gap === null ? null : gap.slice(start ? 1 : 0, end ? gap.length - 1 : gap.length);
	for (const token of stream) {
		const match = token.type === "ident" ? placeholders.token.exec(token.value) : null;
		const gapBefore = joinGaps(pendingGap, unpad(sourceGaps[index++], afterPlaceholder, match !== null));
		pendingGap = null;
		afterPlaceholder = match !== null;
		if (match) {
			const value = values[Number(match[1])];
			const spliced = interpolationTokens(value);
			if (spliced.tokens.length === 0) {
				pendingGap = gapBefore;
				continue;
			}
			spliced.tokens.forEach((spliceToken, spliceIndex) => {
				tokens.push(spliceToken);
				gaps.push(spliceIndex === 0 ? gapBefore : spliced.gaps[spliceIndex]);
			});
			continue;
		}
		if (token.type === "group") {
			const inner = substitute(token.tokens, values, placeholders);
			tokens.push(inner === token.tokens ? token : makeToken({
				type: "group",
				delimiter: token.delimiter,
				tokens: inner
			}, positionOf(token)));
		} else if (token.type === "literal" && (token.kind === "string" || token.kind === "template")) {
			tokens.push(substituteInLiteral(token, values, placeholders.text));
		} else {
			tokens.push(token);
		}
		gaps.push(gapBefore);
	}
	gaps.push(joinGaps(pendingGap, unpad(sourceGaps[index], afterPlaceholder, false)));
	const unchanged = tokens.length === stream.length && tokens.every((token, i) => token === stream.at(i));
	return unchanged ? stream : new TokenStream(tokens, gaps);
}
function substituteInLiteral(token, values, pattern) {
	pattern.lastIndex = 0;
	if (!pattern.test(token.raw)) return token;
	const quote = token.raw[0];
	const raw = token.raw.replace(pattern, (_, index) => {
		const text = interpolationText(values[Number(index)]);
		const escaped = text.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
		if (quote === "`") return escaped.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
		return escaped.replaceAll(quote, `\\${quote}`);
	});
	const [replaced] = tokenizeSource(raw, "<tokenStream>");
	return replaced;
}
/** Text of an interpolation inserted into a string literal, e.g. `"${fnName}"`. */
function interpolationText(value) {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	if (isTokenTree(value)) {
		if (value.type === "ident" || value.type === "punct") return value.value;
		if (value.type === "literal") return String(value.value);
	}
	return TokenStream.from(value).toString();
}
/** Tokens of an interpolation, with the gap before each one. */
function interpolationTokens(value) {
	if (value instanceof TokenStream) {
		return {
			tokens: [...value],
			gaps: getGaps(value).slice(0, value.length)
		};
	}
	if (isTokenTree(value)) return {
		tokens: [value],
		gaps: [null]
	};
	if (Array.isArray(value)) {
		const tokens = [];
		const gaps = [];
		for (const element of value) {
			const inner = interpolationTokens(element);
			tokens.push(...inner.tokens);
			gaps.push(...inner.gaps);
		}
		return {
			tokens,
			gaps
		};
	}
	switch (typeof value) {
		case "string": return {
			tokens: [makeToken({
				type: "literal",
				kind: "string",
				value,
				raw: JSON.stringify(value)
			})],
			gaps: [null]
		};
		case "boolean": return {
			tokens: [makeToken({
				type: "literal",
				kind: "boolean",
				value,
				raw: String(value)
			})],
			gaps: [null]
		};
		case "number":
		case "bigint": {
			// Negative numbers, `NaN` and `Infinity` are not single literal tokens, so use the lexer
			const stream = tokenizeSource(typeof value === "bigint" ? `${value}n` : String(value), "<number>");
			return interpolationTokens(stream);
		}
	}
	throw new TypeError(`tokenStream: cannot interpolate ${value === null ? "null" : typeof value}`);
}
/**
* Convert a `MacroGroupToken` from the parser into a stream of its contents.
* `offset` is added to the parser's spans to get offsets into `text`.
*/
export function __fromOxc(group, text, id, offset = 0) {
	const source = {
		text,
		id
	};
	let seq = 0;
	const convertGroup = (group, contentStart, contentEnd) => {
		const tokens = [];
		const gaps = [];
		let previousEnd = contentStart;
		for (const token of group.tokens) {
			const start = token.start + offset;
			const end = token.end + offset;
			gaps.push(text.slice(previousEnd, start));
			previousEnd = end;
			if (token.type === "MacroGroupToken") {
				const seqStart = seq++;
				const inner = convertGroup(token, start + 1, end - 1);
				const position = {
					source,
					start,
					end,
					seqStart,
					seqEnd: seq++
				};
				tokens.push(makeToken({
					type: "group",
					delimiter: token.delimiter,
					tokens: inner
				}, position));
				continue;
			}
			const seqStart = seq++;
			const position = {
				source,
				start,
				end,
				seqStart,
				seqEnd: seqStart
			};
			if (token.type === "MacroIdentToken") {
				tokens.push(makeToken({
					type: "ident",
					value: token.value
				}, position));
			} else if (token.type === "MacroPunctToken") {
				tokens.push(makeToken({
					type: "punct",
					value: token.value,
					spacing: token.spacing
				}, position));
			} else {
				const kind = token.kind;
				const value = kind === "number" ? token.number : kind === "boolean" ? token.value === "true" : token.value;
				tokens.push(makeToken({
					type: "literal",
					kind,
					value,
					raw: token.raw
				}, position));
			}
		}
		gaps.push(text.slice(previousEnd, contentEnd));
		return new TokenStream(tokens, gaps);
	};
	const delimited = group.delimiter !== "none";
	const start = group.start + offset + (delimited ? 1 : 0);
	const end = group.end + offset - (delimited ? 1 : 0);
	return convertGroup(group, start, end);
}
function tokenizeSource(text, id) {
	if (!config.tokenize) throw new Error("std:compiler: no tokenizer configured (not running in the compile VM?)");
	return __fromOxc(config.tokenize(text), text, id);
}
export function __createPrintContext(reserved) {
	return {
		reserved: new Set(reserved),
		used: new Set(),
		aliases: new Map(),
		references: new Map(),
		fresh: new Map(),
		hoisted: new Map(),
		hoistedByCode: new Map()
	};
}
function allocate(base, context) {
	let name = base;
	for (let n = 1; context.reserved.has(name) || context.used.has(name); n++) name = `${base}_${n}`;
	context.used.add(name);
	return name;
}
/** Print a macro's output as code. References from `import.meta.compile.identifier()` print as aliases. */
export function __print(value, context) {
	return printStream(toStream(value), context);
}
function toStream(value) {
	if (value instanceof TokenStream) return value;
	if (isTokenTree(value)) return new TokenStream([value]);
	if (value !== null && typeof value === "object" && Symbol.iterator in value) {
		return new TokenStream(value);
	}
	throw new TypeError(`macro must return a TokenStream, got ${value === null ? "null" : typeof value}`);
}
function isContiguous(before, after) {
	return before !== undefined && after !== undefined && before.source === after.source && after.seqStart === before.seqEnd + 1;
}
function printStream(stream, context) {
	const gaps = getGaps(stream);
	let code = "";
	let previous;
	let index = 0;
	for (const token of stream) {
		const text = printToken(token, context);
		if (previous) code += separator(previous, token, gaps[index], code, text);
		code += text;
		previous = token;
		index++;
	}
	return code;
}
const WORD_CHAR = /[\p{ID_Continue}$\u200C\u200D\\]/u;
const PUNCT_CHAR = /[+\-*/%&|^!~<>=?.:#@]/;
/**
* Text between two printed tokens: the recorded gap if known, otherwise a space.
* Tokens that were not next to each other in their source get a space if they would otherwise
* lex as one token (`${keyword}${name}`, `${a}${b}` where a = `+` and b = `+`).
*/
function separator(before, after, gap, left, right) {
	if (gap === null) return " ";
	if (gap !== "" || isContiguous(positionOf(before), positionOf(after))) return gap;
	const last = left.at(-1) ?? "";
	const first = right[0] ?? "";
	const merges = WORD_CHAR.test(last) && WORD_CHAR.test(first) || PUNCT_CHAR.test(last) && PUNCT_CHAR.test(first);
	return merges ? " " : "";
}
function printToken(token, context) {
	switch (token.type) {
		case "ident": {
			if (!context) return token.value;
			const hidden = token;
			if (hidden[REFERENCE]) return aliasFor(hidden[REFERENCE], context);
			if (hidden[FRESH]) {
				let name = context.fresh.get(hidden[FRESH]);
				if (name === undefined) context.fresh.set(hidden[FRESH], name = allocate(`_${hidden[FRESH].base}$`, context));
				return name;
			}
			if (hidden[HOISTED]) {
				const code = printStream(hidden[HOISTED].stream, context);
				let name = context.hoistedByCode.get(code);
				if (name === undefined) {
					name = allocate(`$h_${hidden[HOISTED].base}`, context);
					context.hoistedByCode.set(code, name);
					context.hoisted.set(name, code);
				}
				return name;
			}
			return token.value;
		}
		case "punct": return token.value;
		case "literal": return token.raw;
		case "group": {
			const [open, close] = token.delimiter;
			const gaps = getGaps(token.tokens);
			const length = token.tokens.length;
			const leading = length > 0 ? gaps[0] ?? "" : "";
			return open + leading + printStream(token.tokens, context) + (gaps[length] ?? "") + close;
		}
	}
}
function aliasFor(reference, context) {
	const key = `${reference.module}\0${reference.exportName}`;
	let alias = context.aliases.get(key);
	if (alias === undefined) {
		alias = allocate(`$m_${reference.binding}`, context);
		context.aliases.set(key, alias);
		context.references.set(alias, reference);
	}
	return alias;
}
let config = { target: "client" };
/** Configure this compile VM. Called by the host plugin after loading this module. */
export function __configure(options) {
	config = {
		...config,
		...options
	};
}
/** Run `fn` with `import.meta.compile.callSite` set. */
export function __withCallSite(callSite, fn) {
	const previous = config.callSite;
	config.callSite = callSite;
	try {
		return fn();
	} finally {
		config.callSite = previous;
	}
}
/** `import.meta.compile` for module `moduleId`. The plugin rewrites `import.meta.compile` to this. */
export function __createCompileMeta(moduleId) {
	return Object.freeze({
		get target() {
			return config.target;
		},
		get callSite() {
			return config.callSite;
		},
		import(specifier) {
			// The plugin replaces `import.meta.compile.import("literal")` with a preloaded namespace.
			throw new TypeError(`import.meta.compile.import(${JSON.stringify(specifier)}): the specifier must be a string literal, ` + "so the dependency can be resolved and loaded before the macro runs");
		},
		hoist(expression, name = "hoisted") {
			return makeToken({
				type: "ident",
				value: name
			}, undefined, undefined, { [HOISTED]: {
				base: name,
				stream: TokenStream.from(expression)
			} });
		},
		identifier(binding, name, imported) {
			// The plugin rewrites `identifier(foo)` to `identifier(foo, "foo")` after checking `foo` is a
			// module-level binding, adding where `foo` is imported from if it is an import.
			if (typeof name !== "string") {
				throw new TypeError("import.meta.compile.identifier() must be called with a module-level identifier, e.g. identifier(helper)");
			}
			void binding;
			return makeToken({
				type: "ident",
				value: name
			}, undefined, {
				module: moduleId,
				exportName: imported ? imported.name : hiddenExportName(name),
				binding: name,
				...imported && { specifier: imported.specifier }
			});
		}
	});
}
export function __defineMacro(kind, name, fn) {
	const meta = Object.freeze({
		kind,
		name
	});
	Object.defineProperty(fn, MACRO_BRAND, { value: meta });
	return fn;
}
export function __getMacro(value) {
	return typeof value === "function" ? value[MACRO_BRAND] : undefined;
}
