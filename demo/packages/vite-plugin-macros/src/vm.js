// The compile VM: an isolated Vite module runner that evaluates macro-defining modules.
//
// Spec §5.1: "Macro-defining modules are evaluated in an isolated engine VM prior to runtime
// module evaluation." Here, that VM is a `RunnableDevEnvironment` with its own module graph and
// module instances, one per compilation target, so module-level state of macro modules
// (registries, caches) is per target.
import { fileURLToPath } from "node:url";
import { createRunnableDevEnvironment, resolveConfig } from "vite";
import { cleanId, tokenize } from "./syntax.js";
export const STD_COMPILER_PATH = fileURLToPath(new URL("./std-compiler.js", import.meta.url));
export const STD_COMPILER_RUNTIME_PATH = fileURLToPath(new URL("./std-compiler-runtime.js", import.meta.url));
const ENVIRONMENT_NAME = "macros";
export class MacroError extends Error {
	constructor(message) {
		super(message);
		this.name = "MacroError";
	}
}
export class CompileVM {
	target;
	/** `std:compiler` as loaded inside this VM. Token streams passed to macros must come from here. */
	std;
	/** Modules being transformed by this VM that are waiting for macros. Used to detect cycles. */
	pending = new Set();
	#host;
	#options;
	#createPlugin;
	#environment;
	#ready;
	/** Set when module instances were dropped, so `std:compiler` must be loaded again. */
	#stale = false;
	constructor(target, host, options, createPlugin) {
		this.target = target;
		this.#host = host;
		this.#options = options;
		this.#createPlugin = createPlugin;
	}
	async ready() {
		this.#ready ??= this.#init();
		await this.#ready;
		if (this.#stale) {
			this.#stale = false;
			this.#ready = this.#loadStd();
			await this.#ready;
		}
	}
	async #loadStd() {
		this.std = await this.#environment.runner.import(STD_COMPILER_PATH);
		this.std.__configure({
			target: this.target,
			tokenize
		});
	}
	async #init() {
		const host = this.#host;
		const config = await resolveConfig({
			configFile: false,
			envDir: false,
			root: host.root,
			mode: host.mode,
			logLevel: "warn",
			customLogger: host.logger,
			cacheDir: `${host.cacheDir}/macros-${this.target}`,
			resolve: { alias: host.resolve.alias },
			plugins: [this.#createPlugin(this), ...this.#options.plugins ?? []],
			server: {
				hmr: false,
				ws: false,
				watch: null,
				preTransformRequests: false
			},
			optimizeDeps: {
				noDiscovery: true,
				include: []
			},
			environments: { [ENVIRONMENT_NAME]: {
				consumer: "server",
				dev: { moduleRunnerTransform: true },
				resolve: {
					external: this.#options.external,
					noExternal: this.#options.noExternal
				}
			} }
		}, "serve");
		const environment = createRunnableDevEnvironment(ENVIRONMENT_NAME, config, {
			hot: false,
			runnerOptions: { hmr: false }
		});
		await environment.init();
		this.#environment = environment;
		await this.#loadStd();
	}
	/** Resolve `specifier` from `importer` and load macro `name` from it. */
	async loadMacro(specifier, importer, name, kind) {
		await this.ready();
		const environment = this.#environment;
		const consumer = cleanId(importer);
		const resolved = await environment.pluginContainer.resolveId(specifier, consumer);
		if (!resolved) throw new MacroError(`Cannot resolve macro module "${specifier}" from ${consumer}`);
		const module = cleanId(resolved.id);
		if (module === consumer) {
			throw new MacroError(`\`${name}\` is defined in the module that invokes it. ` + "Macro-defining modules and their consumers must form a DAG (spec §5.1).");
		}
		if (this.pending.has(module)) {
			throw new MacroError(`Macro dependency cycle: ${consumer} uses macros from ${module}, which is still being compiled ` + "because it (indirectly) uses macros from this module. Macro modules must form a DAG (spec §5.1).");
		}
		return this.loadMacroExport(module, name, kind, `"${specifier}"`);
	}
	/** Load macro exported as `exportName` from resolved module `module`. */
	async loadMacroExport(module, exportName, kind, description = module) {
		await this.ready();
		const namespace = await this.#environment.runner.import(module);
		const fn = namespace[exportName];
		const meta = this.std.__getMacro(fn);
		if (!meta) throw new MacroError(`${description} does not export a macro named \`${exportName}\``);
		const name = meta.name;
		if (meta.kind !== kind) {
			const usage = meta.kind === "attribute" ? `#[${name}]` : `${name}! { ... }`;
			throw new MacroError(`\`${name}\` is ${meta.kind === "attribute" ? "an attribute" : "an expression"} macro, use it as ${usage}`);
		}
		return {
			fn,
			meta,
			module
		};
	}
	/** Files evaluated in this VM, for watching. */
	files() {
		const modules = this.#environment?.runner.evaluatedModules.fileToModulesMap;
		return modules ? [...modules.keys()] : [];
	}
	/** Drop all module instances if `file` was evaluated in this VM, so macros are re-evaluated. */
	invalidate(file) {
		const environment = this.#environment;
		if (!environment?.runner.evaluatedModules.getModulesByFile(file)) return false;
		environment.moduleGraph.invalidateAll();
		environment.runner.clearCache();
		// `std:compiler` is re-evaluated too; load and configure it on next use
		this.#stale = true;
		return true;
	}
	async close() {
		const environment = this.#environment;
		this.#environment = undefined;
		this.#ready = undefined;
		await environment?.close();
	}
}
