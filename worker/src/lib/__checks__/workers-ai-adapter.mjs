#!/usr/bin/env node
/**
 * Workers AI adapter: the three shapes the binding really returns.
 *
 * Measured in production: the same `env.AI.run(model, {messages})` answers a
 * bare string for some models, `{response}` for the classic text models, and a
 * chat-completions object with `choices[]` for llama-3.3-70b. Assuming one of
 * them reported a good answer as "no text", so all three are asserted here,
 * plus the paths that must still fail (an error object with a 200, an empty
 * choice list, a non-string response).
 *
 * Run: node --experimental-strip-types src/lib/__checks__/workers-ai-adapter.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `workers-ai.ts` imports its siblings without extensions (the Worker bundles
// them), so plain --experimental-strip-types cannot resolve them.
const HERE = path.dirname(fileURLToPath(import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && path.extname(specifier) === "") {
			const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
			for (const suffix of [".ts", "/index.ts"]) {
				const candidate = path.resolve(base, specifier + suffix);
				if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	}
});

const { createWorkersAiAdapter } = await import("../ai/workers-ai.ts");

let passed = 0;
const failures = [];
function check(label, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`  ok  ${label}`);
		return;
	}
	failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
	console.log(`  FAIL ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function adapterReturning(value) {
	let seen = null;
	const binding = {
		async run(model, input) {
			seen = { model, input };
			if (value instanceof Error) throw value;
			return value;
		}
	};
	return { adapter: createWorkersAiAdapter(binding, "test-model"), seen: () => seen };
}

const messages = [
	{ role: "system", content: "be brief" },
	{ role: "user", content: "say pong" }
];

/* ── the shapes that must work ───────────────────────────────────────────── */

{
	const { adapter } = adapterReturning("pong");
	const out = await adapter.chat(messages, { maxOutputTokens: 16 });
	check("a bare string is the text", out.text === "pong");
	check("provider is named", out.provider === "workers-ai");
}

{
	const { adapter } = adapterReturning({ response: "pong", usage: { prompt_tokens: 7, completion_tokens: 2 } });
	const out = await adapter.chat(messages, {});
	check("{response} is the text", out.text === "pong");
	check("usage is read", out.tokensIn === 7 && out.tokensOut === 2);
}

{
	const { adapter } = adapterReturning({
		choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 9, completion_tokens: 1 }
	});
	const out = await adapter.chat(messages, {});
	check("choices[].message.content is the text", out.text === "pong");
	check("usage survives the chat shape", out.tokensIn === 9 && out.tokensOut === 1);
}

{
	const { adapter } = adapterReturning({ choices: [{ text: "pong" }] });
	const out = await adapter.chat(messages, {});
	check("choices[].text is the text", out.text === "pong");
}

{
	const { adapter } = adapterReturning({
		choices: [{ message: { content: [{ type: "text", text: "po" }, { type: "text", text: "ng" }] } }]
	});
	const out = await adapter.chat(messages, {});
	check("a part list is joined", out.text === "pong");
}

/* ── the paths that must still fail, and why ─────────────────────────────── */

{
	const { adapter } = adapterReturning({ errors: [{ code: 5001, message: "nope" }] });
	try {
		await adapter.chat(messages, {});
		check("an error object with a 200 is refused", false);
	} catch (error) {
		check("an error object with a 200 is refused", error.reason === "unparseable", error.reason);
		check(
			"the refusal names the shape",
			/shape|keys/i.test(error.message) || /object with keys/.test(error.message),
			error.message
		);
	}
}

{
	const { adapter } = adapterReturning({ choices: [] });
	try {
		await adapter.chat(messages, {});
		check("an empty choice list is refused", false);
	} catch (error) {
		check("an empty choice list is refused", error.reason === "unparseable");
	}
}

{
	const { adapter } = adapterReturning({ response: 42 });
	try {
		await adapter.chat(messages, {});
		check("a non-string response is refused", false);
	} catch (error) {
		check("a non-string response is refused", error.reason === "unparseable");
	}
}

{
	const { adapter } = adapterReturning(new Error("binding exploded"));
	try {
		await adapter.chat(messages, {});
		check("a thrown binding is provider_unavailable", false);
	} catch (error) {
		check("a thrown binding is provider_unavailable", error.reason === "provider_unavailable");
	}
}

/* ── the request itself ──────────────────────────────────────────────────── */

{
	const { adapter, seen } = adapterReturning("ok");
	await adapter.chat(messages, { maxOutputTokens: 9999 });
	check("the model is passed through", seen().model === "test-model");
	check("messages are forwarded as given", seen().input.messages.length === 2);
	check(
		"output tokens are clamped to the hard ceiling",
		seen().input.max_tokens === 1024,
		String(seen().input.max_tokens)
	);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
