/**
* `std:compiler` — runtime-phase stub.
*
* Macros only exist at compile time. In client and server bundles, `std:compiler` resolves here,
* and `export macro` declarations are replaced with stubs that throw if called.
*/
function compileTimeOnly(name) {
	throw new Error(`std:compiler: ${name} is only available while macros are being expanded`);
}
export class TokenStream {
	constructor() {
		compileTimeOnly("TokenStream");
	}
}
export function tokenStream() {
	return compileTimeOnly("tokenStream");
}
export function ident() {
	return compileTimeOnly("ident");
}
export function fresh() {
	return compileTimeOnly("fresh");
}
export function group() {
	return compileTimeOnly("group");
}
export function literal() {
	return compileTimeOnly("literal");
}
export function __macroStub(name) {
	return () => {
		throw new Error(`\`${name}\` is a macro. Invoke it at compile time as \`${name}! { ... }\` or \`#[${name}]\`.`);
	};
}
