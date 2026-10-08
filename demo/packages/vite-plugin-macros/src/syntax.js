// Parsing and tokenizing with the forked oxc-parser (the parser Vite 8 uses, plus macro syntax).
import { parseSync, tokenizeSync } from "oxc-parser";
export class MacroSyntaxError extends Error {
	start;
	constructor(message, start, frame) {
		super(frame ? `${message}\n${frame}` : message);
		this.name = "MacroSyntaxError";
		this.start = start;
	}
}
function toError(error) {
	return new MacroSyntaxError(error.message, error.labels[0]?.start ?? 0, error.codeframe ?? undefined);
}
export function cleanId(id) {
	return id.replace(/[?#].*$/, "");
}
export function parseModule(id, code) {
	const result = parseSync(cleanId(id), code, {
		macros: true,
		sourceType: "module"
	});
	if (result.errors.length > 0) throw toError(result.errors[0]);
	return {
		program: result.program,
		staticImports: result.module.staticImports
	};
}
/** Token trees of `text`, which only needs balanced delimiters, not valid syntax. */
export function tokenize(text) {
	const result = tokenizeSync("tokens.ts", text);
	if (result.errors.length > 0) throw toError(result.errors[0]);
	return result.tokens;
}
/** Visit nodes depth-first. Return `false` from `enter` to skip a node's children. Token trees are not visited. */
export function walk(node, enter, parent = null) {
	if (enter(node, parent) === false) return;
	for (const key in node) {
		if (key === "parent") continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) {
				if (isNode(child)) walk(child, enter, node);
			}
		} else if (isNode(value)) {
			walk(value, enter, node);
		}
	}
}
function isNode(value) {
	return typeof value === "object" && value !== null && typeof value.type === "string" && !/^Macro\w*Token$/.test(value.type);
}
export function isImportMetaCompile(node) {
	return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "compile" && node.object.type === "MetaProperty" && node.object.meta.name === "import" && node.object.property.name === "meta";
}
export function lineColumn(code, offset) {
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < offset; index++) {
		if (code.charCodeAt(index) === 10) {
			line++;
			lineStart = index + 1;
		}
	}
	return {
		line,
		column: offset - lineStart
	};
}
