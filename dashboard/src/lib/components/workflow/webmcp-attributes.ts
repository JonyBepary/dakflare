/**
 * Declarative WebMCP annotations, as attribute maps.
 *
 * Chrome's declarative API turns a plain `<form>` into a tool by reading
 * `toolname`, `tooldescription`, and — on individual controls —
 * `toolparamtitle` / `toolparamdescription`. Those attributes are not in the DOM
 * typings Svelte checks against, so they are spread from here: the names stay in
 * one place, the template stays readable, and `svelte-check` stays at zero.
 *
 * Two rules this module keeps:
 *
 *   - Mutating forms never carry `toolautosubmit`. Both forms here change a sheet
 *     a person is working in, so the submit stays a click.
 *   - A description says what the tool changes, in the operator's terms, not the
 *     wire's.
 */

/** Form-level annotations for a tool. */
export function toolForm(name: string, description: string): Record<string, string> {
	return { toolname: name, tooldescription: description };
}

/** Control-level annotations for one parameter of that tool. */
export function toolParam(title: string, description: string): Record<string, string> {
	return { toolparamtitle: title, toolparamdescription: description };
}
