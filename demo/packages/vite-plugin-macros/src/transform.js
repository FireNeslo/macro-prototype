// Module transforms.
//
// Consumers: `name! { ... }` and `#[name] item` are replaced by the macro's output.
// Macro-defining modules (`export macro ...`) are rewritten per phase:
//
// - compile phase (inside the compile VM): `export macro f(t) {}` becomes
//   `export const f = __std.__defineMacro("expression", "f", function f(t) {})`, and
//   `import.meta.compile` becomes a `CompileMeta` object.
// - runtime phase (client/server bundles): macro declarations are replaced by stubs that throw,
//   `import.meta.compile` becomes `undefined`, and bindings captured with
//   `import.meta.compile.identifier()` are exported under hidden names, so expanded code can import them.
import { RolldownMagicString } from "rolldown";
import { hiddenExportName } from "./shared.js";
import { MacroSyntaxError, cleanId, isImportMetaCompile, lineColumn, parseModule, tokenize, walk } from "./syntax.js";
import { MacroError } from "./vm.js";
/** Cheap pre-check for macro syntax or `import.meta.compile`. */
export const MACRO_SYNTAX = /#\[|[\p{ID_Continue}$]!\s*\{|\bmacro\s+[\p{ID_Start}$_]|import\.meta\.compile/u;
const MAX_EXPANSION_DEPTH = 32;
function analyze(program) {
	const analysis = {
		sites: [],
		declarations: [],
		compileCalls: [],
		compileUses: []
	};
	walk(program, (node, parent) => {
		switch (node.type) {
			case "MacroInvocation":
				analysis.sites.push({
					kind: "expression",
					node
				});
				return false;
			case "AttributedStatement":
				analysis.sites.push({
					kind: "attribute",
					node
				});
				return false;
			case "MacroDeclaration":
				analysis.declarations.push({
					node,
					exportNode: parent?.type === "ExportNamedDeclaration" ? parent : null,
					name: node.function.id.name
				});
				return;
			case "CallExpression":
				if (node.callee.type === "MemberExpression" && isImportMetaCompile(node.callee.object)) {
					analysis.compileCalls.push(node);
					return false;
				}
				return;
			case "MemberExpression": if (isImportMetaCompile(node)) {
				analysis.compileUses.push(node);
				return false;
			}
		}
	});
	return analysis;
}
function topLevelBindings(program) {
	const names = new Set();
	const add = (declaration) => {
		if (!declaration) return;
		switch (declaration.type) {
			case "FunctionDeclaration":
			case "ClassDeclaration":
			case "TSEnumDeclaration":
				if (declaration.id) names.add(declaration.id.name);
				break;
			case "VariableDeclaration":
				for (const declarator of declaration.declarations) {
					if (declarator.id.type === "Identifier") names.add(declarator.id.name);
				}
				break;
			case "MacroDeclaration":
				names.add(declaration.function.id.name);
				break;
			case "ImportDeclaration":
				for (const specifier of declaration.specifiers ?? []) names.add(specifier.local.name);
				break;
		}
	};
	for (const statement of program.body) {
		add(statement);
		if (statement.type === "ExportNamedDeclaration") add(statement.declaration);
		if (statement.type === "ExportDefaultDeclaration") add(statement.declaration);
		if (statement.type === "AttributedStatement") add(statement.body);
	}
	return names;
}
function importBindings(staticImports) {
	const bindings = new Map();
	for (const declaration of staticImports) {
		for (const entry of declaration.entries) {
			if (entry.isType) continue;
			const imported = entry.importName.kind === "Name" ? entry.importName.name : entry.importName.kind === "Default" ? "default" : null;
			bindings.set(entry.localName.value, {
				specifier: declaration.moduleRequest.value,
				imported
			});
		}
	}
	return bindings;
}
/** Prefix of specifiers that resolve `specifier` as if imported from `importer` (definition-site resolution). */
export const DEFINITION_SITE_IMPORT = "macro-import:";
export function definitionSiteImport(specifier, importer) {
	return `${DEFINITION_SITE_IMPORT}${encodeURIComponent(importer)}:${encodeURIComponent(specifier)}`;
}
export function parseDefinitionSiteImport(id) {
	if (!id.startsWith(DEFINITION_SITE_IMPORT)) return null;
	const [importer, specifier] = id.slice(DEFINITION_SITE_IMPORT.length).split(":").map(decodeURIComponent);
	return {
		specifier,
		importer
	};
}
function importStatement(alias, reference) {
	const source = reference.specifier === undefined ? reference.module : definitionSiteImport(reference.specifier, reference.module);
	const name = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(reference.exportName) ? reference.exportName : JSON.stringify(reference.exportName);
	const clause = reference.exportName === "*" ? `* as ${alias}` : `{ ${name} as ${alias} }`;
	return `import ${clause} from ${JSON.stringify(source)};\n`;
}
function identifierNames(code) {
	return new Set(code.match(/[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/gu) ?? []);
}
function macroName(site) {
	return site.kind === "expression" ? site.node.callee.name : site.node.attributes[0].callee.name;
}
function within(node, ranges) {
	return ranges.some((range) => node.start >= range.start && node.end <= range.end);
}
/** Error with Vite/Rolldown location info. */
function locate(error, id, code, offset, context) {
	const err = error instanceof Error ? error : new Error(String(error));
	const { line, column } = lineColumn(code, offset);
	const where = `${cleanId(id)}:${line}:${column + 1}`;
	if (!err.loc) {
		err.message = `${context ? `${context}: ` : ""}${err.message}\n    at ${where}`;
		Object.assign(err, {
			id: cleanId(id),
			loc: {
				file: cleanId(id),
				line,
				column
			}
		});
	}
	return err;
}
export async function transformModule(code, id, context) {
	let parsed;
	try {
		parsed = parseModule(id, code);
	} catch (error) {
		throw error instanceof MacroSyntaxError ? locate(error, id, code, error.start) : error;
	}
	const { program } = parsed;
	const analysis = analyze(program);
	if (analysis.sites.length === 0 && analysis.declarations.length === 0 && analysis.compileCalls.length === 0 && analysis.compileUses.length === 0) {
		return null;
	}
	const { phase, vm } = context;
	const consumer = cleanId(id);
	const s = new RolldownMagicString(code, { filename: consumer });
	const imports = importBindings(parsed.staticImports);
	const localMacros = new Set(analysis.declarations.map((declaration) => declaration.name));
	const macroDeclarationNodes = analysis.declarations.map((declaration) => declaration.exportNode ?? declaration.node);
	const usedMacroLocals = new Set();
	/** Aliases of references that were invoked as macros. */
	const macroAliases = new Set();
	const outputs = [];
	await vm.ready();
	const print = vm.std.__createPrintContext(identifierNames(code));
	// ---- Expand invocations -------------------------------------------------------------------
	const loadMacro = async (name, kind, node, source) => {
		// A macro named in another macro's output via `import.meta.compile.identifier(macro)` resolves
		// where that macro is defined (definition-site hygiene). Other names resolve in this module.
		const reference = source === code ? undefined : print.references.get(name);
		if (reference) {
			try {
				macroAliases.add(name);
				const macro = await vm.loadMacroExport(reference.module, reference.exportName, kind);
				context.watch(macro.module);
				return macro;
			} catch (error) {
				throw locate(error, id, source, node.start);
			}
		}
		const binding = imports.get(name);
		if (!binding || binding.imported === null) {
			const reason = localMacros.has(name) ? `\`${name}\` is defined in this module. A module cannot invoke its own macros (spec §5.1).` : binding ? `\`${name}\` is a namespace import. Import the macro by name.` : source === code ? `\`${name}\` is not imported. Import the macro from the module that defines it.` : `\`${name}\` (invoked in the output of another macro) is not imported by this module. ` + `To refer to a macro from the macro that emits it, use import.meta.compile.identifier(${name}).`;
			throw locate(new MacroError(reason), id, source, node.start);
		}
		try {
			const macro = await vm.loadMacro(binding.specifier, id, binding.imported, kind);
			usedMacroLocals.add(name);
			context.watch(macro.module);
			return macro;
		} catch (error) {
			throw locate(error, id, source, node.start);
		}
	};
	const invoke = async (macro, input, args, node, source) => {
		try {
			const callSite = {
				module: consumer,
				start: node.start,
				end: node.end
			};
			const output = vm.std.__withCallSite(callSite, () => macro.fn(input, args));
			return output instanceof Promise ? await output : output;
		} catch (error) {
			throw locate(error, id, source, node.start, `Error in macro \`${macro.meta.name}\``);
		}
	};
	/** Expand one site of `source` (the module, or the output of another macro) to code. */
	const expand = async (site, source, depth) => {
		if (depth > MAX_EXPANSION_DEPTH) {
			throw locate(new MacroError(`Macro expansion exceeded depth ${MAX_EXPANSION_DEPTH}`), id, source, site.node.start);
		}
		const { node } = site;
		let output;
		if (site.kind === "expression") {
			const macro = await loadMacro(node.callee.name, "expression", node, source);
			const input = vm.std.__fromOxc(node.body, source, consumer);
			output = await invoke(macro, input, undefined, node, source);
		} else {
			// Outermost attribute first. It receives the item including any remaining attributes.
			const [attribute, ...rest] = node.attributes;
			const macro = await loadMacro(attribute.callee.name, "attribute", attribute, source);
			const itemStart = rest.length > 0 ? rest[0].start : node.body.start;
			const item = vm.std.__fromOxc(tokenize(source.slice(itemStart, node.body.end)), source, consumer, itemStart);
			const args = attribute.arguments ? vm.std.__fromOxc(attribute.arguments, source, consumer) : undefined;
			output = await invoke(macro, item, args, attribute, source);
		}
		let printed;
		try {
			printed = vm.std.__print(output, print);
		} catch (error) {
			throw locate(error, id, source, node.start);
		}
		// Always re-parse: reports invalid output at the invocation, and expands nested invocations
		try {
			return await expandNested(printed, site.kind, depth + 1, macroName(site));
		} catch (error) {
			throw locate(error, id, source, node.start);
		}
	};
	/** Validate a macro's output and expand macro invocations in it. */
	const expandNested = async (output, kind, depth, name) => {
		// Expression output is parsed in parentheses, so e.g. an object literal is not read as a block
		const prefix = kind === "expression" ? "(" : "";
		const source = kind === "expression" ? `(${output}\n)` : output;
		let nested;
		try {
			nested = analyze(parseModule(id, source).program).sites;
		} catch (error) {
			throw new MacroError(`Macro \`${name}\` produced invalid code: ${error.message}\n${output}\n`);
		}
		if (nested.length === 0) return output;
		let result = source;
		for (const site of nested.toReversed()) {
			const replacement = await expand(site, source, depth);
			result = result.slice(0, site.node.start) + replacement + result.slice(site.node.end);
		}
		return kind === "expression" ? result.slice(prefix.length, -2) : result;
	};
	if (phase === "compile") vm.pending.add(consumer);
	try {
		for (const site of analysis.sites) {
			// At runtime, macro declarations are removed, so invocations inside them are not expanded
			if (phase === "runtime" && within(site.node, macroDeclarationNodes)) continue;
			const output = await expand(site, code, 0);
			outputs.push(output);
			s.overwrite(site.node.start, site.node.end, output);
		}
	} finally {
		vm.pending.delete(consumer);
	}
	// Macros depend on everything their modules load at compile time (e.g. via
	// `import.meta.compile.import()`), so re-expand when any of it changes
	if (outputs.length > 0) {
		for (const file of vm.files()) {
			if (file !== consumer) context.watch(file);
		}
	}
	// Macros only exist at compile time: drop their import specifiers. At runtime, also drop imports
	// that only macro bodies use: they are compile-time dependencies of the macros.
	const removedImports = phase === "runtime" && analysis.declarations.length > 0 ? new Set([...usedMacroLocals, ...compileTimeImports(program, macroDeclarationNodes)]) : usedMacroLocals;
	for (const statement of program.body) {
		if (statement.type === "ImportDeclaration") removeMacroSpecifiers(s, code, statement, removedImports);
	}
	// Import bindings captured by `import.meta.compile.identifier()` under their aliases.
	// Aliases that only named macros (expanded away) are not imported.
	const hoisted = [...print.hoisted].map(([name, value]) => `const ${name} = ${value};\n`);
	const expanded = [...outputs, ...hoisted].join("\n");
	const header = [...print.references].filter(([alias]) => !macroAliases.has(alias) || new RegExp(`(?<![\\p{ID_Continue}$])${alias.replace(/\$/g, "\\$")}(?![\\p{ID_Continue}$])`, "u").test(expanded)).map(([alias, reference]) => importStatement(alias, reference));
	// ---- Macro-defining modules and `import.meta.compile` -------------------------------------
	const bindings = topLevelBindings(program);
	// Where each import of this module comes from, for `identifier()` of an imported binding
	const ownImports = new Map();
	for (const declaration of parsed.staticImports) {
		for (const entry of declaration.entries) {
			const name = entry.importName.kind === "Name" ? entry.importName.name : entry.importName.kind === "Default" ? "default" : "*";
			ownImports.set(entry.localName.value, {
				specifier: declaration.moduleRequest.value,
				name
			});
		}
	}
	const captured = new Set();
	const capture = (call) => {
		const [argument] = call.arguments;
		if (call.arguments.length !== 1 || argument.type !== "Identifier" || !bindings.has(argument.name)) {
			throw locate(new MacroError("import.meta.compile.identifier() takes one identifier naming a module-level binding of this module"), id, code, call.start);
		}
		// Imported bindings are imported from their own module, everything else from this one
		if (!ownImports.has(argument.name)) captured.add(argument.name);
		return argument.name;
	};
	if (phase === "compile") {
		let compileImports = 0;
		for (const declaration of analysis.declarations) {
			const { node, name } = declaration;
			const kind = JSON.stringify(node.kind);
			s.overwrite(node.start, node.function.start, `const ${name} = __std.__defineMacro(${kind}, ${JSON.stringify(name)}, function `);
			s.appendLeft(node.end, ");");
		}
		for (const call of analysis.compileCalls) {
			const method = call.callee.computed ? null : call.callee.property.name;
			if (method === "identifier") {
				const name = capture(call);
				const imported = ownImports.get(name);
				const extra = imported ? `, ${JSON.stringify(imported)}` : "";
				s.overwrite(call.start, call.end, `__compileMeta.identifier(${name}, ${JSON.stringify(name)}${extra})`);
			} else if (method === "import" && call.arguments.length === 1 && call.arguments[0].type === "Literal" && typeof call.arguments[0].value === "string") {
				// Resolve and load at module evaluation, so `import()` can return synchronously (annex §2)
				const local = `__compileImport${compileImports++}`;
				header.push(`import * as ${local} from ${JSON.stringify(call.arguments[0].value)};\n`);
				s.overwrite(call.start, call.end, local);
			} else {
				s.overwrite(call.callee.object.start, call.callee.object.end, "__compileMeta");
			}
		}
		for (const use of analysis.compileUses) s.overwrite(use.start, use.end, "__compileMeta");
		if (analysis.declarations.length > 0 || analysis.compileCalls.length > 0 || analysis.compileUses.length > 0) {
			header.unshift(`import * as __std from "std:compiler";\n`, `const __compileMeta = __std.__createCompileMeta(${JSON.stringify(consumer)});\n`);
		}
	} else {
		for (const declaration of analysis.declarations) {
			const { node, exportNode, name } = declaration;
			if (exportNode) {
				s.overwrite(exportNode.start, exportNode.end, `export const ${name} = /* @__PURE__ */ __std.__macroStub(${JSON.stringify(name)});`);
			} else {
				s.remove(node.start, node.end);
			}
		}
		for (const call of analysis.compileCalls) {
			const method = call.callee.computed ? null : call.callee.property.name;
			// Inside macro declarations (removed), only record captured bindings
			if (method === "identifier") capture(call);
			if (!within(call, macroDeclarationNodes)) {
				s.overwrite(call.callee.object.start, call.callee.object.end, "(void 0)");
			}
		}
		for (const use of analysis.compileUses) {
			if (!within(use, macroDeclarationNodes)) s.overwrite(use.start, use.end, "(void 0)");
		}
		if (analysis.declarations.some((declaration) => declaration.exportNode)) {
			header.unshift(`import * as __std from "std:compiler";\n`);
		}
	}
	if (captured.size > 0) {
		const specifiers = [...captured].map((name) => `${name} as ${hiddenExportName(name)}`);
		s.append(`\nexport { ${specifiers.join(", ")} };\n`);
	}
	if (header.length > 0 || hoisted.length > 0) s.prepend(header.join("") + hoisted.join(""));
	const map = s.generateMap({
		source: consumer,
		includeContent: true,
		hires: "boundary"
	});
	return {
		code: s.toString(),
		map: map.toString()
	};
}
/**
* Local names of imports that are referenced inside macro declarations and nowhere else. In the
* runtime build those declarations are removed, so these imports are only needed at compile time.
* Conservative: any other mention of the name, including in a macro invocation's tokens or as a
* property key, keeps the import.
*/
function compileTimeImports(program, macroDeclarations) {
	const imported = new Set();
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration") continue;
		for (const specifier of statement.specifiers ?? []) imported.add(specifier.local.name);
	}
	const inside = new Set();
	const outside = new Set();
	const tokenNames = (group) => {
		for (const token of group?.tokens ?? []) {
			if (token.type === "MacroIdentToken") outside.add(token.value);
			else if (token.type === "MacroGroupToken") tokenNames(token);
		}
	};
	walk(program, (node) => {
		if (node.type === "ImportDeclaration") return false;
		const inMacro = within(node, macroDeclarations);
		if (node.type === "Identifier" || node.type === "JSXIdentifier") (inMacro ? inside : outside).add(node.name);
		if (!inMacro && node.type === "MacroInvocation") tokenNames(node.body);
		if (!inMacro && node.type === "Attribute") tokenNames(node.arguments);
	});
	return [...inside].filter((name) => imported.has(name) && !outside.has(name));
}
/** Remove specifiers of macros from an import declaration, or the whole declaration if only macros remain. */
function removeMacroSpecifiers(s, code, statement, macros) {
	const specifiers = statement.specifiers ?? [];
	const isMacro = (specifier) => macros.has(specifier.local.name);
	if (!specifiers.some(isMacro)) return;
	if (specifiers.every(isMacro)) {
		s.remove(statement.start, statement.end);
		return;
	}
	const named = specifiers.filter((specifier) => specifier.type === "ImportSpecifier");
	const keptNamed = named.filter((specifier) => !isMacro(specifier));
	if (keptNamed.length === 0) {
		// `import def, { macro } from "x"` -> `import def from "x"`
		const close = code.indexOf("}", named.at(-1).end);
		const other = specifiers.find((specifier) => specifier.type !== "ImportSpecifier");
		s.remove(other.end, close + 1);
	} else {
		const text = keptNamed.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ");
		s.overwrite(named[0].start, named.at(-1).end, text);
	}
}
const RESERVED_WORDS = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally " + "for function if import in instanceof let new null return static super switch this throw true try typeof var " + "void while with yield").split(" "));
function tokenIdentifiers(group, names = new Set()) {
	for (const token of group.tokens) {
		if (token.type === "MacroIdentToken" && !RESERVED_WORDS.has(token.value) && !token.value.startsWith("#")) names.add(token.value);
		else if (token.type === "MacroGroupToken") tokenIdentifiers(token, names);
	}
	return [...names];
}
/**
* Blank out macro syntax so tools that use the stock parser can read the module, e.g. Vite's
* dependency scanner. Invocations become `(void 0)`, attributes are dropped (their items kept),
* and macro declarations are removed.
*/
export function stripMacroSyntax(code, id) {
	let program;
	try {
		program = parseModule(id, code).program;
	} catch {
		return null;
	}
	const { sites, declarations } = analyze(program);
	if (sites.length === 0 && declarations.length === 0) return null;
	const s = new RolldownMagicString(code);
	for (const { kind, node } of sites) {
		// Keep identifiers of the macro input referenced, so their imports are not elided as unused
		// (they are probably used by the expansion), and the scanner follows them.
		// The macro itself is kept too, so the scanner crawls the macro module and its dependencies.
		if (kind === "expression") {
			s.overwrite(node.start, node.end, `(void [${[node.callee.name, ...tokenIdentifiers(node.body)].join(", ")}])`);
		} else {
			const names = node.attributes.map((attribute) => attribute.callee.name);
			s.overwrite(node.start, node.body.start, `void [${names.join(", ")}];\n`);
		}
	}
	for (const { node, exportNode } of declarations) {
		const removed = exportNode ?? node;
		if (!sites.some((site) => site.node.start <= removed.start && removed.end <= site.node.end)) {
			s.remove(removed.start, removed.end);
		}
	}
	return s.toString();
}
