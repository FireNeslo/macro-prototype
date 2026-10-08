// Constants shared by the host plugin and `std:compiler` (which runs inside the compile VM).
/** Name under which a macro-defining module exports a binding captured by `import.meta.compile.identifier()`. */
export function hiddenExportName(binding) {
	return `__macro$${binding}`;
}
/** Brand on macro transformer functions created by `export macro`. */
export const MACRO_BRAND = Symbol.for("vite-plugin-macros.macro");
