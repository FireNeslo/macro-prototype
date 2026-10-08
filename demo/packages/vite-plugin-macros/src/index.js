import { DEFINITION_SITE_IMPORT, MACRO_SYNTAX, parseDefinitionSiteImport, stripMacroSyntax, transformModule } from "./transform.js";
import { CompileVM, STD_COMPILER_PATH, STD_COMPILER_RUNTIME_PATH } from "./vm.js";
const JS_MODULE = /\.(?:[cm]?[jt]sx?)(?:$|\?)/;
function defaultTarget(environment) {
	if (environment.name === "client") return "client";
	if (environment.name === "ssr") return "server";
	return environment.name;
}
export default function macros(options = {}) {
	return createPlugin(options, { phase: "runtime" });
}
function createPlugin(options, internal) {
	const vms = new Map();
	let config;
	const vmFor = (environment) => {
		if (internal.vm) return internal.vm;
		const target = (options.target ?? defaultTarget)(environment);
		let vm = vms.get(target);
		if (!vm) {
			vm = new CompileVM(target, config, options.compile ?? {}, (vm) => createPlugin(options, {
				phase: "compile",
				vm
			}));
			vms.set(target, vm);
		}
		return vm;
	};
	const closeAll = async () => {
		const closing = [...vms.values()].map((vm) => vm.close());
		vms.clear();
		await Promise.all(closing);
	};
	return {
		name: internal.phase === "compile" ? "vite-plugin-macros:compile" : "vite-plugin-macros",
		enforce: "pre",
		config() {
			// Vite's dependency scanner parses source with the stock parser, which rejects macro syntax
			return { optimizeDeps: { rolldownOptions: { plugins: [scanPlugin()] } } };
		},
		configResolved(resolved) {
			config = resolved;
		},
		resolveId: {
			filter: { id: [/^std:compiler$/, new RegExp(`^${DEFINITION_SITE_IMPORT}`)] },
			handler(id, _importer, options) {
				if (id === "std:compiler") {
					return internal.phase === "compile" ? STD_COMPILER_PATH : STD_COMPILER_RUNTIME_PATH;
				}
				// A binding captured with `identifier()` that the macro module imports: resolve it as the
				// macro module would, so it is the same module instance (and the same pre-bundled dep in dev)
				const { specifier, importer } = parseDefinitionSiteImport(id);
				return this.resolve(specifier, importer, {
					...options,
					skipSelf: true
				});
			}
		},
		transform: {
			filter: {
				id: JS_MODULE,
				code: MACRO_SYNTAX
			},
			async handler(code, id) {
				if (id === STD_COMPILER_PATH || id === STD_COMPILER_RUNTIME_PATH) return null;
				const vm = vmFor(this.environment);
				return transformModule(code, id, {
					phase: internal.phase,
					vm,
					watch: (file) => this.addWatchFile(file)
				});
			}
		},
		// Re-evaluate macro modules when they (or anything they import) change
		hotUpdate({ file }) {
			for (const vm of vms.values()) vm.invalidate(file);
		},
		async closeBundle() {
			await closeAll();
		},
		async buildEnd() {
			// In dev, `buildEnd` runs when the server closes
			if (this.environment.mode === "dev") await closeAll();
		}
	};
}
function scanPlugin() {
	return {
		name: "vite-plugin-macros:scan",
		transform: {
			filter: {
				id: JS_MODULE,
				code: MACRO_SYNTAX
			},
			handler(code, id) {
				return stripMacroSyntax(code, id);
			}
		}
	};
}
