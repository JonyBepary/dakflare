<script module lang="ts">
	/**
	 * What the sheet hands back. The shape is unchanged from the old inline
	 * workbench so an extract node keeps accepting it without a translation step.
	 */
	export interface PatternApplyPayload {
		pattern: string;
		sampleBody: string;
		spans: import('$lib/workflow/wasm-engine').TemplateSpan[];
		variables: string[];
		testSamples: Array<{ body: string; expect_match: boolean }>;
	}
</script>

<script lang="ts">
	import { tick, untrack } from 'svelte';
	import Badge from '$lib/components/Badge.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { STARTER_TEMPLATES, type StarterTemplate } from '$lib/workflow/starter-templates';
	import {
		suggestSpans,
		synthesizeTemplate,
		type TemplateSpan,
		type TemplateTestMatch
	} from '$lib/workflow/wasm-engine';

	let {
		open = $bindable(true),
		nodeId,
		initialSample = '',
		initialPattern = '',
		initialSpans = [],
		onapply,
		oncancel,
		onmanual
	}: {
		open?: boolean;
		nodeId: string;
		initialSample?: string;
		initialPattern?: string;
		initialSpans?: TemplateSpan[];
		onapply: (result: PatternApplyPayload) => void;
		oncancel?: () => void;
		onmanual?: () => void;
	} = $props();

	const uid = $props.id();
	const titleId = `pattern-title-${uid}`;
	const modeId = `pattern-mode-${uid}`;
	const nameId = `pattern-name-${uid}`;
	const typeId = `pattern-type-${uid}`;
	const assignTitleId = `pattern-assign-${uid}`;

	const SLOT_TYPES = [
		{ id: 'money_bdt', label: 'Money (Tk or BDT)', short: 'Money' },
		{ id: 'phone_bd', label: 'Phone number (Bangladesh)', short: 'Phone' },
		{ id: 'trx_id', label: 'Transaction ID', short: 'Transaction ID' },
		{ id: 'datetime_bd', label: 'Date and time', short: 'Date and time' },
		{ id: 'bank_account', label: 'Bank account (*1234)', short: 'Account' },
		{ id: 'number', label: 'Number', short: 'Number' },
		{ id: 'free_text', label: 'Free text or reference', short: 'Text' }
	];

	const ROLES: Array<{ id: 'extract' | 'trigger' | 'ignore'; label: string; hint: string }> = [
		{
			id: 'extract',
			label: 'A value to keep',
			hint: 'The pattern reads this part of the message and keeps it for later steps.'
		},
		{
			id: 'trigger',
			label: 'Opening words',
			hint: 'This exact text has to appear for the flow to start. Nothing is read from it.'
		},
		{
			id: 'ignore',
			label: 'Anything else',
			hint: 'Anything can appear here and nothing is read. Use it for a detail that changes.'
		}
	];

	// Naming hints that only exist to make a selection easier to name. They never
	// change how the pattern is built.
	const LABEL_NAMES: Record<string, string> = {
		trxid: 'trx_id',
		txnid: 'trx_id',
		trx: 'trx_id',
		txn: 'trx_id',
		ref: 'reference',
		reference: 'reference',
		invoice: 'reference',
		amount: 'amount',
		amt: 'amount',
		fee: 'fee',
		balance: 'balance',
		bal: 'balance',
		date: 'timestamp',
		time: 'timestamp',
		otp: 'otp',
		pin: 'pin',
		serial: 'serial_no',
		order: 'order_id',
		account: 'account_no'
	};

	// The message and everything derived from it.
	let sampleBody = $state('');
	let additionalSamples = $state<string[]>([]);
	let spans = $state<TemplateSpan[]>([]);
	let compiledPattern = $state('');
	let capturedVariables = $state<string[]>([]);
	let testMatches = $state<TemplateTestMatch[]>([]);
	let synthError = $state<string | null>(null);
	let isSynthesizing = $state(false);
	let isFinding = $state(false);
	let findNote = $state<string | null>(null);

	// One action reverts the last "do it for me" move, whatever it touched.
	let undoState = $state<{
		message: string;
		sampleBody: string;
		additionalSamples: string[];
		spans: TemplateSpan[];
	} | null>(null);

	// Sheet state.
	let dialogEl = $state<HTMLDialogElement | null>(null);
	let bodyEl = $state<HTMLDivElement | null>(null);
	let sampleEl = $state<HTMLElement | null>(null);
	let nameEl = $state<HTMLInputElement | null>(null);
	let presetsOpen = $state(false);
	let editingSample = $state(false);
	let sampleDraft = $state('');
	let newSample = $state('');
	let seededFor = '';
	let downOnBackdrop = false;

	// Selection state, kept in string offsets against `sampleBody`. The sheet
	// tracks its own range rather than relying on DOM selection alone, because
	// focus moves to the name field while the range is still being named.
	let pendingStart = $state<number | null>(null);
	let pendingEnd = $state<number | null>(null);
	let assignOpen = $state(false);
	let selectedSpanIndex = $state<number | null>(null);
	let nameTouched = $state(false);
	let editRole = $state<'extract' | 'trigger' | 'ignore'>('extract');
	let editName = $state('');
	let editType = $state('free_text');
	let editOptional = $state(false);
	let dragFromSample = false;

	// Keyboard cursor, counted in words rather than characters.
	let cursorWord = $state(-1);
	let extendAnchor = $state<number | null>(null);

	const paragraphs = $derived.by(() => splitParagraphs(sampleBody));
	const sampleHtml = $derived.by(() =>
		paragraphs
			.map(
				(para) =>
					`<p data-para-start="${para.start}">${runsOf(para)
						.map((run) => {
							if (run.spanIndex === undefined) return escapeHtml(run.text);
							const span = spans[run.spanIndex];
							const title = span
								? `${span.name}, ${
										span.role === 'trigger'
											? 'the opening words'
											: span.role === 'ignore'
												? 'a part that can change'
												: typeLabel(span.slot_type).toLowerCase()
									}. Click to edit this field.`
								: '';
							return `<mark class="mk mk-${escapeHtml(run.role ?? 'extract')}" data-span-index="${run.spanIndex}" title="${escapeHtml(title)}">${escapeHtml(run.text)}</mark>`;
						})
						.join('')}</p>`
			)
			.join('')
	);
	const words = $derived.by(() => {
		const out: Array<{ start: number; end: number }> = [];
		const re = /[\p{L}\p{N}_]+/gu;
		let hit: RegExpExecArray | null;
		while ((hit = re.exec(sampleBody)) !== null) {
			out.push({ start: hit.index, end: hit.index + hit[0].length });
		}
		return out;
	});
	const normalized = $derived.by(() => normalizeWithMap(sampleBody));
	const pendingText = $derived.by(() =>
		pendingStart !== null && pendingEnd !== null ? sampleBody.slice(pendingStart, pendingEnd) : ''
	);
	const finalName = $derived.by(() => uniqueName(sanitizeName(editName), selectedSpanIndex));
	const firstMatch = $derived(testMatches[0] ?? null);

	const canApply = $derived(
		spans.length > 0 &&
			capturedVariables.length > 0 &&
			compiledPattern.length > 0 &&
			!synthError &&
			!isSynthesizing &&
			testMatches.length > 0 &&
			Boolean(testMatches[0]?.matched)
	);

	const applyHint = $derived.by(() => {
		if (!sampleBody) return 'Paste the message first.';
		if (spans.length === 0) return 'Select a value in the message to start the pattern.';
		if (isSynthesizing) return 'The pattern is still being built.';
		if (synthError) return 'Fix the pattern first.';
		if (capturedVariables.length === 0)
			return 'Name a value to keep. The opening words alone give later steps nothing to use.';
		if (testMatches.length === 0 || !testMatches[0]?.matched)
			return 'The pattern does not match this message yet.';
		return 'Use this pattern in the step.';
	});

	const patternStatus = $derived.by(() => {
		if (isSynthesizing) return 'Building';
		if (synthError) return 'Needs a change';
		if (!compiledPattern) return 'Not built yet';
		if (testMatches.length === 0) return 'Ready';
		const matched = testMatches.filter((match) => match.matched).length;
		if (testMatches.length === 1) return matched === 1 ? 'Matches this message' : 'No match';
		return `Matches ${matched} of ${testMatches.length} messages`;
	});

	const statusTone = $derived.by<'ok' | 'warn' | 'muted'>(() => {
		if (synthError) return 'warn';
		if (!compiledPattern || isSynthesizing) return 'muted';
		if (testMatches.length === 0) return 'muted';
		const matched = testMatches.filter((match) => match.matched).length;
		return matched === testMatches.length ? 'ok' : 'warn';
	});

	const roleHint = $derived(ROLES.find((role) => role.id === editRole)?.hint ?? '');

	// Seed from the props when the sheet opens, and only then. The parent may
	// mount the sheet per node or keep it mounted and flip `open`; both work.
	$effect(() => {
		const key = `${nodeId}:${open}`;
		if (!open || key === seededFor) return;
		seededFor = key;
		untrack(() => {
			const sample = initialSample.trim();
			sampleBody = sample;
			sampleDraft = sample;
			additionalSamples = [];
			spans = initialSpans.map((span) => ({ ...span }));
			compiledPattern = initialPattern;
			capturedVariables = parseGroups(initialPattern);
			testMatches = [];
			synthError = null;
			undoState = null;
			findNote = null;
			presetsOpen = false;
			editingSample = false;
			newSample = '';
			closeAssign();
		});
	});

	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
			void tick().then(() => {
				if (bodyEl) bodyEl.scrollTop = 0;
				const target = dialogEl?.querySelector<HTMLElement>('[data-autofocus]');
				(target ?? dialogEl)?.focus({ preventScroll: true });
			});
		} else if (!open && el.open) {
			el.close();
		}
	});

	// A drag that ends outside the message still made a selection, and a long
	// press on a phone selects without a pointerup over the text. Both paths
	// land here, and neither steals a selection that is already being named.
	$effect(() => {
		if (!open) return;

		const sync = () => {
			const range = readSelection();
			if (!range) return;
			// The same range is already being named: keep the guess the user has
			// and do not break a Shift+arrow extension that set the selection.
			if (assignOpen && pendingStart === range.start && pendingEnd === range.end) return;
			cursorWord = wordIndexAt(range.start);
			extendAnchor = null;
			setAssignment(range.start, range.end);
		};

		const onPointerUp = () => {
			if (!dragFromSample) return;
			dragFromSample = false;
			void tick().then(sync);
		};

		const onSelectionChange = () => void tick().then(sync);

		document.addEventListener('pointerup', onPointerUp);
		document.addEventListener('selectionchange', onSelectionChange);
		return () => {
			document.removeEventListener('pointerup', onPointerUp);
			document.removeEventListener('selectionchange', onSelectionChange);
		};
	});

	// Build the pattern whenever the sample or the fields change, and only then.
	$effect(() => {
		const body = sampleBody;
		const current = spans;
		const extras = additionalSamples;
		if (!open || current.length === 0) return;
		void synthesize(body, current, extras);
	});

	let synthSeq = 0;

	async function synthesize(body: string, current: TemplateSpan[], extras: string[]) {
		const seq = ++synthSeq;
		isSynthesizing = true;
		synthError = null;
		try {
			// The engine normalizes the body before it reads offsets, so the spans
			// are translated into that same coordinate space at the boundary.
			const mapped = current.map((span) => ({
				...span,
				start: normalized.toNorm(span.start),
				end: normalized.toNorm(span.end)
			}));
			const res = await synthesizeTemplate(body, mapped, extras);
			if (seq !== synthSeq) return;
			if (res.ok && res.result) {
				compiledPattern = res.result.pattern;
				capturedVariables = res.result.variables;
				testMatches = res.result.test_results;
			} else {
				compiledPattern = '';
				capturedVariables = [];
				testMatches = [];
				synthError =
					res.message ?? res.reason ?? 'The pattern could not be built from this selection.';
			}
		} catch {
			if (seq !== synthSeq) return;
			compiledPattern = '';
			capturedVariables = [];
			testMatches = [];
			synthError = 'The pattern engine did not load. Reload the page and try again.';
		} finally {
			if (seq === synthSeq) isSynthesizing = false;
		}
	}

	/* ---------------------------------------------------------------- sample */

	function splitParagraphs(body: string) {
		const out: Array<{ start: number; text: string }> = [];
		let start = 0;
		for (let i = 0; i <= body.length; i += 1) {
			if (i === body.length || body[i] === '\n') {
				if (i > start) out.push({ start, text: body.slice(start, i) });
				start = i + 1;
			}
		}
		return out;
	}

	interface Run {
		start: number;
		text: string;
		spanIndex?: number;
		role?: string;
	}

	function runsOf(para: { start: number; text: string }): Run[] {
		const from = para.start;
		const to = para.start + para.text.length;
		const cuts = new Set<number>([from, to]);
		for (const span of spans) {
			if (span.start > from && span.start < to) cuts.add(span.start);
			if (span.end > from && span.end < to) cuts.add(span.end);
		}
		const points = [...cuts].sort((a, b) => a - b);
		const runs: Run[] = [];
		for (let i = 0; i < points.length - 1; i += 1) {
			const a = points[i];
			const b = points[i + 1];
			if (a === undefined || b === undefined || b <= a) continue;
			const text = sampleBody.slice(a, b);
			if (!text) continue;
			const spanIndex = spans.findIndex((span) => span.start <= a && span.end >= b);
			const span = spanIndex >= 0 ? spans[spanIndex] : undefined;
			runs.push(
				span ? { start: a, text, spanIndex, role: span.role } : { start: a, text }
			);
		}
		return runs;
	}

	function escapeHtml(value: string) {
		return value.replace(
			/[&<>"']/g,
			(char) =>
				({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
		);
	}

	/** Faithful copy of the engine's pre-normalizer, plus an index map each way. */
	function normalizeWithMap(raw: string) {
		const chars = Array.from(raw);
		const out: string[] = [];
		const toNorm = new Array<number>(chars.length + 1).fill(0);
		const toRaw: number[] = [];
		let pendingSpace = false;

		for (let i = 0; i < chars.length; i += 1) {
			const char = chars[i] ?? '';
			if (/\s/u.test(char)) {
				toNorm[i] = out.length;
				if (out.length > 0) pendingSpace = true;
				continue;
			}
			// Flush a collapsed space before recording this character's position,
			// otherwise every character after a space maps one place too early.
			if (pendingSpace) {
				out.push(' ');
				toRaw.push(Math.max(0, i - 1));
				pendingSpace = false;
			}
			toNorm[i] = out.length;
			toRaw.push(i);
			out.push(convertChar(char));
		}
		toNorm[chars.length] = out.length;
		toRaw.push(chars.length);

		const clamp = (index: number, max: number) => Math.min(Math.max(index, 0), max);

		return {
			text: out.join(''),
			toNorm: (index: number) => toNorm[clamp(index, toNorm.length - 1)] ?? 0,
			toRaw: (index: number) =>
				toRaw[clamp(index, Math.max(0, toRaw.length - 1))] ?? Math.max(0, chars.length - 1)
		};
	}

	function convertChar(char: string) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x09e6 && code <= 0x09ef) return String.fromCharCode(0x30 + (code - 0x09e6));
		if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(0x30 + (code - 0xff10));
		if (code >= 0xff21 && code <= 0xff3a) return String.fromCharCode(0x41 + (code - 0xff21));
		if (code >= 0xff41 && code <= 0xff5a) return String.fromCharCode(0x61 + (code - 0xff41));
		return char;
	}

	/* ---------------------------------------------------------- selection */

	function textOffsetOf(node: Node, offset: number): number | null {
		const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
		const para = element?.closest<HTMLElement>('[data-para-start]');
		if (!para || !sampleEl?.contains(para)) return null;
		const base = Number(para.dataset.paraStart ?? '0');
		const range = document.createRange();
		range.setStart(para, 0);
		try {
			range.setEnd(node, offset);
		} catch {
			return null;
		}
		return base + range.toString().length;
	}

	function pointAt(index: number): { node: Text; offset: number } | null {
		if (!sampleEl) return null;
		for (const para of sampleEl.querySelectorAll<HTMLElement>('[data-para-start]')) {
			const base = Number(para.dataset.paraStart ?? '0');
			const length = para.textContent?.length ?? 0;
			if (index < base || index > base + length) continue;
			let seen = base;
			const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode() as Text | null;
			while (node) {
				if (index <= seen + node.data.length) return { node, offset: index - seen };
				seen += node.data.length;
				node = walker.nextNode() as Text | null;
			}
		}
		return null;
	}

	function readSelection(): { start: number; end: number } | null {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);
		if (range.collapsed) return null;
		if (!sampleEl) return null;
		if (!sampleEl.contains(range.startContainer) || !sampleEl.contains(range.endContainer)) {
			return null;
		}
		const start = textOffsetOf(range.startContainer, range.startOffset);
		const end = textOffsetOf(range.endContainer, range.endOffset);
		if (start === null || end === null) return null;
		return trimRange(Math.min(start, end), Math.max(start, end));
	}

	function trimRange(start: number, end: number): { start: number; end: number } | null {
		let a = Math.min(Math.max(start, 0), sampleBody.length);
		let b = Math.min(Math.max(end, 0), sampleBody.length);
		while (a < b && /\s/u.test(sampleBody[a] ?? '')) a += 1;
		while (b > a && /\s/u.test(sampleBody[b - 1] ?? '')) b -= 1;
		return b > a ? { start: a, end: b } : null;
	}

	function selectChars(start: number, end: number) {
		const from = pointAt(start);
		const to = pointAt(end);
		if (!from || !to) return;
		const selection = window.getSelection();
		if (!selection) return;
		selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
	}

	function clearDomSelection() {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || !sampleEl) return;
		if (sampleEl.contains(selection.getRangeAt(0).commonAncestorContainer)) {
			selection.removeAllRanges();
		}
	}

	function wordIndexAt(index: number) {
		const found = words.findIndex((word) => index >= word.start && index <= word.end);
		if (found >= 0) return found;
		const next = words.findIndex((word) => word.start > index);
		return next >= 0 ? next : words.length - 1;
	}

	function moveWord(direction: 1 | -1, extend: boolean) {
		if (words.length === 0) return;
		if (!extend) {
			if (extendAnchor !== null) {
				cursorWord =
					direction > 0
						? Math.max(extendAnchor, cursorWord)
						: Math.min(extendAnchor, cursorWord);
				extendAnchor = null;
			} else {
				cursorWord = Math.min(Math.max(cursorWord + direction, 0), words.length - 1);
			}
		} else {
			if (extendAnchor === null) extendAnchor = Math.max(cursorWord, 0);
			cursorWord = Math.min(Math.max(cursorWord + direction, 0), words.length - 1);
		}

		const from = extendAnchor === null ? cursorWord : Math.min(extendAnchor, cursorWord);
		const to = extendAnchor === null ? cursorWord : Math.max(extendAnchor, cursorWord);
		const fromWord = words[Math.max(from, 0)];
		const toWord = words[Math.max(to, 0)];
		if (!fromWord || !toWord) return;
		selectChars(fromWord.start, toWord.end);
		setAssignment(fromWord.start, toWord.end);
	}

	function handleSampleClick(event: MouseEvent) {
		if (readSelection()) return;
		const target = event.target as Element | null;
		const mark = target?.closest<HTMLElement>('[data-span-index]');
		if (!mark) return;
		const index = Number(mark.dataset.spanIndex);
		if (!Number.isInteger(index) || !spans[index]) return;
		const span = spans[index];
		setAssignment(span.start, span.end, { spanIndex: index });
		selectChars(span.start, span.end);
	}

	function handleSampleKeydown(event: KeyboardEvent) {
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		if (event.key === 'Enter') {
			event.preventDefault();
			if (assignOpen) {
				nameEl?.focus({ preventScroll: true });
				nameEl?.select();
				return;
			}
			const range = readSelection();
			if (range) {
				setAssignment(range.start, range.end, { focusName: true });
			} else if (pendingStart !== null && pendingEnd !== null) {
				setAssignment(pendingStart, pendingEnd, { focusName: true });
			}
			return;
		}

		if (event.key === 'Escape') {
			if (assignOpen) {
				event.preventDefault();
				closeAssign();
			}
			return;
		}

		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		moveWord(event.key === 'ArrowRight' ? 1 : -1, event.shiftKey);
	}

	/* ---------------------------------------------------------- assignment */

	function setAssignment(
		start: number,
		end: number,
		options: { spanIndex?: number | null; focusName?: boolean } = {}
	) {
		const spanIndex = options.spanIndex ?? null;
		pendingStart = start;
		pendingEnd = end;
		selectedSpanIndex = spanIndex;

		if (spanIndex !== null) {
			const span = spans[spanIndex];
			if (span) {
				editRole = span.role;
				editName = span.name;
				editType = span.slot_type ?? 'free_text';
				editOptional = Boolean(span.optional);
				nameTouched = true;
			}
		} else {
			const guessed = guessName(sampleBody.slice(start, end), start);
			editRole = guessed.role;
			editType = guessed.type;
			editOptional = false;
			if (!nameTouched || !assignOpen) {
				editName = uniqueName(guessed.name, null);
				nameTouched = false;
			}
		}

		assignOpen = true;
		if (options.focusName) {
			void tick().then(() => {
				nameEl?.focus({ preventScroll: true });
				nameEl?.select();
			});
		}
	}

	function closeAssign() {
		assignOpen = false;
		selectedSpanIndex = null;
		pendingStart = null;
		pendingEnd = null;
		nameTouched = false;
		clearDomSelection();
	}

	function commitSpan() {
		const start = pendingStart;
		const end = pendingEnd;
		if (start === null || end === null) return;
		const name = uniqueName(sanitizeName(editName), selectedSpanIndex);
		const next: TemplateSpan = {
			role: editRole,
			name,
			start,
			end,
			optional: editRole === 'extract' ? editOptional : false
		};
		if (editRole === 'extract') next.slot_type = editType;
		const kept = spans.filter(
			(span, index) => index !== selectedSpanIndex && (span.end <= start || span.start >= end)
		);
		spans = [...kept, next].sort((a, b) => a.start - b.start);
		editName = name;
		undoState = null;
		closeAssign();
	}

	function removeSpanAt(index: number) {
		if (!spans[index]) return;
		const next = spans.filter((_, i) => i !== index);
		spans = next;
		if (next.length === 0) clearPattern();
		if (selectedSpanIndex !== null && index <= selectedSpanIndex) closeAssign();
		undoState = null;
	}

	function clearPattern() {
		compiledPattern = '';
		capturedVariables = [];
		testMatches = [];
		synthError = null;
	}

	function guessName(
		text: string,
		start: number
	): { role: 'extract' | 'trigger' | 'ignore'; name: string; type: string } {
		const value = text.trim();
		if (/^01[3-9][0-9]{8}$/.test(value)) {
			return { role: 'extract', name: 'sender_account', type: 'phone_bd' };
		}
		if (/^[0-9০-৯][0-9,০-৯]*(?:\.[0-9]{1,2})?$/.test(value)) {
			return { role: 'extract', name: 'amount', type: 'money_bdt' };
		}
		if (/^\*+[0-9]{3,6}$/.test(value)) {
			return { role: 'extract', name: 'account_no', type: 'bank_account' };
		}
		if (/[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}/.test(value)) {
			return { role: 'extract', name: 'timestamp', type: 'datetime_bd' };
		}
		if (/^[A-Za-z0-9]{6,16}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) {
			return { role: 'extract', name: 'trx_id', type: 'trx_id' };
		}
		if (
			value.split(/\s+/).length >= 3 &&
			/^(you have|cash in|money received|payment|received|deposit|sent)/i.test(value)
		) {
			return { role: 'trigger', name: 'trigger', type: 'free_text' };
		}
		return { role: 'extract', name: contextName(start), type: 'free_text' };
	}

	function contextName(start: number) {
		const before = sampleBody.slice(Math.max(0, start - 28), start);
		const hit = before.match(/([A-Za-z][A-Za-z0-9]{1,15})[\s:.]*$/);
		if (!hit) return 'field';
		const word = hit[1].toLowerCase();
		return LABEL_NAMES[word] ?? sanitizeName(hit[1]);
	}

	function sanitizeName(raw: string) {
		let name = raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.replace(/_+/g, '_')
			.slice(0, 32);
		if (!name) name = 'field';
		if (/^[0-9]/.test(name)) name = `f_${name}`;
		return name;
	}

	function uniqueName(base: string, ignoreIndex: number | null) {
		let name = base;
		let suffix = 2;
		while (spans.some((span, index) => index !== ignoreIndex && span.name === name)) {
			name = `${base}_${suffix}`;
			suffix += 1;
		}
		return name;
	}

	/**
	 * The suggester can propose the same field twice (an amount and a fee both
	 * read as `amount`). Two capture groups cannot share a name, so the later
	 * ones get a suffix instead of a pattern that refuses to compile.
	 */
	function dedupeNames(list: TemplateSpan[]) {
		const used = new Set<string>();
		return list.map((span) => {
			let name = span.name;
			let suffix = 2;
			while (used.has(name)) {
				name = `${span.name}_${suffix}`;
				suffix += 1;
			}
			used.add(name);
			return name === span.name ? span : { ...span, name };
		});
	}

	function parseGroups(pattern: string) {
		const out: string[] = [];
		for (const hit of pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) {
			if (!out.includes(hit[1])) out.push(hit[1]);
		}
		return out;
	}

	function typeLabel(slotType: string | undefined) {
		return SLOT_TYPES.find((type) => type.id === slotType)?.short ?? 'Value';
	}

	function variableType(name: string) {
		const span = spans.find((candidate) => candidate.name === name);
		return typeLabel(span?.slot_type ?? 'free_text');
	}

	/* ------------------------------------------------------------ actions */

	async function findFields(snapshot = true) {
		if (!sampleBody || isFinding) return;
		isFinding = true;
		findNote = null;
		const before = {
			sampleBody,
			additionalSamples: [...additionalSamples],
			spans: spans.map((span) => ({ ...span }))
		};
		try {
			const res = await suggestSpans(sampleBody);
			const found = res.ok ? (res.spans ?? []) : [];
			const mapped = found
				.map((span) => ({
					...span,
					start: normalized.toRaw(span.start),
					end: normalized.toRaw(span.end)
				}))
				.filter((span) => span.end > span.start)
				.sort((a, b) => a.start - b.start);
			const kept: TemplateSpan[] = [];
			for (const span of mapped) {
				if (kept.length === 0 || span.start >= kept[kept.length - 1].end) kept.push(span);
			}
			if (kept.length === 0) {
				findNote =
					res.message ?? 'No obvious values in this message. Select the part you want to keep.';
				if (snapshot) undoState = null;
				return;
			}
			const named = dedupeNames(kept);
			if (snapshot) {
				const fieldCount = named.filter((span) => span.role === 'extract').length;
				const plural = fieldCount === 1 ? 'field' : 'fields';
				undoState = {
					...before,
					message:
						fieldCount > 0
							? `Found ${fieldCount} ${plural}. Check ${
									fieldCount === 1 ? 'it' : 'them'
								}, or undo.`
							: 'Found the opening words only. Name a value to read, or undo.'
				};
			}
			spans = named;
			closeAssign();
		} catch {
			findNote = 'The pattern engine did not load. Reload the page and try again.';
			if (snapshot) undoState = null;
		} finally {
			isFinding = false;
		}
	}

	function undoLast() {
		if (!undoState) return;
		const restore = undoState;
		undoState = null;
		findNote = null;
		sampleDraft = restore.sampleBody;
		sampleBody = restore.sampleBody;
		additionalSamples = [...restore.additionalSamples];
		spans = restore.spans.map((span) => ({ ...span }));
		if (spans.length === 0) clearPattern();
		closeAssign();
	}

	function loadPreset(preset: StarterTemplate) {
		undoState = {
			message: `Loaded ${preset.name.split(' (')[0]}. Adjust the fields, or undo.`,
			sampleBody,
			additionalSamples: [...additionalSamples],
			spans: spans.map((span) => ({ ...span }))
		};
		const sample = preset.sampleBody.trim();
		sampleBody = sample;
		sampleDraft = sample;
		spans = [];
		additionalSamples = preset.testSamples.slice(1).map((test) => test.body);
		presetsOpen = false;
		editingSample = false;
		findNote = null;
		closeAssign();
		void findFields(false);
	}

	function applySampleDraft() {
		const next = sampleDraft.trim().replace(/\r\n?/g, '\n');
		if (!next) return;
		const changed = next !== sampleBody;
		sampleBody = next;
		editingSample = false;
		if (!changed) return;
		spans = [];
		clearPattern();
		undoState = null;
		findNote = null;
		closeAssign();
	}

	function addSample() {
		const body = newSample.trim();
		if (!body) return;
		if (body !== sampleBody && !additionalSamples.includes(body)) {
			additionalSamples = [...additionalSamples, body];
		}
		newSample = '';
	}

	function removeSample(index: number) {
		additionalSamples = additionalSamples.filter((_, i) => i !== index);
	}

	function requestClose() {
		open = false;
		oncancel?.();
	}

	function handleDialogCancel(event: Event) {
		event.preventDefault();
		requestClose();
	}

	function handleDialogPointerDown(event: PointerEvent) {
		downOnBackdrop = event.target === dialogEl;
	}

	function handleDialogClick(event: MouseEvent) {
		const wasBackdrop = downOnBackdrop && event.target === dialogEl;
		downOnBackdrop = false;
		if (wasBackdrop) requestClose();
	}

	function applyPattern() {
		if (!canApply) return;
		const testSamples = [
			{ body: sampleBody, expect_match: true },
			...additionalSamples
				.filter((body) => body !== sampleBody)
				.map((body) => ({ body, expect_match: true }))
		];
		open = false;
		onapply({
			pattern: compiledPattern,
			sampleBody,
			spans: spans.map((span) => ({ ...span })),
			variables: capturedVariables,
			testSamples
		});
	}
</script>

<dialog
	bind:this={dialogEl}
	class="sheet-dialog"
	aria-labelledby={titleId}
	aria-describedby={modeId}
	tabindex="-1"
	oncancel={handleDialogCancel}
	onpointerdown={handleDialogPointerDown}
	onclick={handleDialogClick}
>
	<div class="sheet">
		<header class="sheet-head">
			<span class="head-mark" aria-hidden="true"><Icon name="braces" size={18} /></span>
			<div class="head-copy">
				<p class="eyebrow">Extract step</p>
				<h2 id={titleId}>Build the pattern from a sample</h2>
				<div class="mode-row" id={modeId}>
					<span class="mode-chip"><span class="mode-dot"></span>Building from a sample</span>
					{#if onmanual}
						<span class="mode-sep" aria-hidden="true"></span>
						<button
							type="button"
							class="link-btn mode-alt"
							onclick={() => {
								open = false;
								onmanual?.();
							}}
						>
							Write the pattern myself
						</button>
					{/if}
				</div>
			</div>
			<div class="head-actions">
				<button type="button" class="btn" onclick={requestClose}>Cancel</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!canApply}
					title={applyHint}
					onclick={applyPattern}
				>
					<Icon name="check" size={15} />
					Use this pattern
				</button>
			</div>
		</header>

		<div class="sheet-body" bind:this={bodyEl}>
			<section class="sample-section" aria-labelledby={`sample-label-${uid}`}>
				<div class="section-head">
					<h3 class="section-title" id={`sample-label-${uid}`}>The message</h3>
					<div class="section-actions">
						{#if sampleBody && !presetsOpen}
							<button
								type="button"
								class="btn btn-sm btn-ghost"
								onclick={() => {
									sampleDraft = sampleBody;
									editingSample = !editingSample;
								}}
							>
								Replace
							</button>
						{/if}
						<button
							type="button"
							class="btn btn-sm"
							aria-expanded={presetsOpen}
							onclick={() => (presetsOpen = !presetsOpen)}
						>
							<Icon name="sparkles" size={14} />
							Start from an example
						</button>
						<button
							type="button"
							class="btn btn-sm"
							disabled={!sampleBody || isFinding}
							onclick={() => findFields()}
						>
							<Icon name="zap" size={14} />
							{isFinding ? 'Looking...' : 'Find the fields'}
						</button>
					</div>
				</div>

				{#if presetsOpen}
					<div class="examples">
						<div class="examples-head">
							<p class="examples-title">Start from an example</p>
							<p class="examples-note">
								Examples from Bangladeshi mobile money, banks and clinics. Your message can be
								about anything. Treat these as a starting point.
							</p>
						</div>
						<ul class="example-list">
							{#each STARTER_TEMPLATES as preset (preset.id)}
								<li>
									<button type="button" class="example" onclick={() => loadPreset(preset)}>
										<span class="example-name">{preset.name}</span>
										<span class="example-desc">{preset.description}</span>
										<span class="chip" data-tone="muted">{preset.senderMask}</span>
									</button>
								</li>
							{/each}
						</ul>
						{#if sampleBody}
							<button
								type="button"
								class="btn btn-sm btn-ghost self-start"
								onclick={() => (presetsOpen = false)}
							>
								Back to the message
							</button>
						{/if}
					</div>
				{:else if !sampleBody}
					<div class="sample-empty">
						<p class="sample-empty-title">Paste the message you want this step to read.</p>
						<p class="hint">
							A real message works best. The sheet finds the parts that change and leaves the
							rest as it is.
						</p>
						<textarea
							class="input"
							rows="4"
							data-autofocus
							placeholder="You have received Tk 800.00 from 01999999999. TrxID 8G56H7J8K9 at 15/07/2026 11:24"
							bind:value={sampleDraft}
						></textarea>
						<div class="row-actions">
							<button
								type="button"
								class="btn btn-primary btn-sm"
								disabled={!sampleDraft.trim()}
								onclick={applySampleDraft}
							>
								Use this message
							</button>
						</div>
					</div>
				{:else}
					{#if editingSample}
						<div class="sample-edit">
							<label class="label" for={`sample-draft-${uid}`}>Replace the message</label>
							<textarea
								id={`sample-draft-${uid}`}
								class="input"
								rows="4"
								data-autofocus
								bind:value={sampleDraft}
							></textarea>
							{#if spans.length > 0}
								<p class="hint">
									A different message clears the {spans.length}
									{spans.length === 1 ? 'field' : 'fields'} you already assigned.
								</p>
							{/if}
							<div class="row-actions">
								<button
									type="button"
									class="btn btn-primary btn-sm"
									disabled={!sampleDraft.trim()}
									onclick={applySampleDraft}
								>
									Use this message
								</button>
								<button type="button" class="btn btn-sm btn-ghost" onclick={() => (editingSample = false)}>
									Keep the current message
								</button>
							</div>
						</div>
					{/if}

					<div class="message-card">
						<div
							class="message-text"
							bind:this={sampleEl}
							data-autofocus
							tabindex="0"
							role="textbox"
							aria-readonly="true"
							aria-multiline="true"
							aria-label="Sample message. Use the arrow keys to move a word at a time, Shift with an arrow to extend, and Enter to name the selection."
							aria-describedby={`sample-hint-${uid}`}
							onpointerdown={() => (dragFromSample = true)}
							onclick={handleSampleClick}
							onkeydown={handleSampleKeydown}
						>
							{@html sampleHtml}
						</div>
					</div>

					<p class="hint sample-hint" id={`sample-hint-${uid}`}>
						<Icon name="keyboard" size={13} />
						Drag to select a value, or use the arrow keys. Shift extends the selection and Enter
						names it.
					</p>

					{#if undoState}
						<div class="suggestion" aria-live="polite">
							<Icon name="zap" size={14} />
							<span>{undoState.message}</span>
							<button type="button" class="undo" onclick={undoLast}>
								<Icon name="undo" size={13} />
								Undo
							</button>
						</div>
					{/if}

					{#if findNote}
						<p class="note">{findNote}</p>
					{/if}

					{#if assignOpen}
						<div class="assign" role="group" aria-labelledby={assignTitleId}>
							<div class="assign-head">
								<h4 class="assign-title" id={assignTitleId}>
									{selectedSpanIndex !== null ? 'Edit this field' : 'Name this value'}
								</h4>
								<q class="assign-quote">{pendingText}</q>
								{#if selectedSpanIndex !== null}
									<button
										type="button"
										class="btn btn-sm btn-danger-ghost assign-remove"
										onclick={() => removeSpanAt(selectedSpanIndex!)}
									>
										<Icon name="trash" size={13} />
										Remove field
									</button>
								{/if}
							</div>

							<div class="assign-grid">
								<div class="field">
									<label class="label" for={nameId}>Name</label>
									<input
										id={nameId}
										class="input input-mono"
										bind:this={nameEl}
										bind:value={editName}
										oninput={() => (nameTouched = true)}
										onkeydown={(event) => {
											if (event.key === 'Enter') {
												event.preventDefault();
												commitSpan();
											} else if (event.key === 'Escape') {
												event.preventDefault();
												closeAssign();
											}
										}}
										autocomplete="off"
										spellcheck="false"
										placeholder="amount"
									/>
									<p class="hint">
										Later steps refer to it as <code>{finalName}</code>.
									</p>
								</div>

								<div class="field">
									<span class="label">This part is</span>
									<div class="roles">
										{#each ROLES as role (role.id)}
											<button
												type="button"
												class="role-btn"
												aria-pressed={editRole === role.id}
												onclick={() => (editRole = role.id)}
											>
												{role.label}
											</button>
										{/each}
									</div>
								</div>

								{#if editRole === 'extract'}
									<div class="field">
										<label class="label" for={typeId}>Kind of value</label>
										<select id={typeId} class="input" bind:value={editType}>
											{#each SLOT_TYPES as type (type.id)}
												<option value={type.id}>{type.label}</option>
											{/each}
										</select>
									</div>
								{/if}
							</div>

							<p class="role-hint">{roleHint}</p>

							<div class="assign-foot">
								{#if editRole === 'extract'}
									<label class="check">
										<input type="checkbox" bind:checked={editOptional} />
										<span>
											Sometimes missing
											<span class="hint">The pattern still matches when this part is absent.</span>
										</span>
									</label>
								{/if}
								<div class="assign-actions">
									<button type="button" class="btn btn-sm btn-ghost" onclick={closeAssign}>
										Clear selection
									</button>
									<button type="button" class="btn btn-sm btn-primary" onclick={commitSpan}>
										<Icon name="check" size={14} />
										{selectedSpanIndex !== null
											? 'Save this field'
											: editRole === 'trigger'
												? 'Use these words'
												: 'Use this value'}
									</button>
								</div>
							</div>
						</div>
					{/if}
				{/if}
			</section>

			<section class="pattern-block" aria-labelledby={`pattern-label-${uid}`} aria-busy={isSynthesizing}>
				<div class="pattern-main">
					<div class="section-head">
						<h3 class="section-title" id={`pattern-label-${uid}`}>The pattern</h3>
						<span aria-live="polite"><Badge tone={statusTone}>{patternStatus}</Badge></span>
						{#if compiledPattern}
							<CopyButton value={compiledPattern} label="Copy pattern" iconOnly size="sm" />
						{/if}
					</div>

					{#if synthError}
						<div class="notice notice-danger">
							<Icon name="alert" size={15} />
							<div>{synthError}</div>
						</div>
					{:else if compiledPattern}
						<pre class="pattern-code"><code>{compiledPattern}</code></pre>
					{:else}
						<p class="pattern-empty">
							Select a value in the message and the pattern appears here. The words you leave
							alone stay as they are; the parts you name become fields.
						</p>
					{/if}
				</div>

				<div class="pattern-fields">
					<div class="section-head">
						<h3 class="section-title">Fields it reads</h3>
						<span class="pattern-count">{capturedVariables.length}</span>
					</div>

					{#if capturedVariables.length > 0}
						<ul class="var-list">
							{#each capturedVariables as name (name)}
								<li class="var-row">
									<button
										type="button"
										class="var-main"
										onclick={() => {
											const index = spans.findIndex((span) => span.name === name);
											if (index < 0) return;
											const span = spans[index];
											setAssignment(span.start, span.end, { spanIndex: index });
										}}
										title="Show this field in the message"
									>
										<span class="var-name">{name}</span>
										{#if firstMatch?.extracted[name]}
											<span class="var-value">{firstMatch.extracted[name]}</span>
										{/if}
									</button>
									<span class="var-type">{variableType(name)}</span>
									<button
										type="button"
										class="var-x"
										aria-label={`Remove ${name}`}
										title={`Remove ${name}`}
										onclick={() => {
											const index = spans.findIndex((span) => span.name === name);
											if (index >= 0) removeSpanAt(index);
										}}
									>
										<Icon name="x" size={12} />
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="hint">
							No fields yet. Every value you name becomes a field the flow can use.
						</p>
					{/if}
				</div>
			</section>

			<details class="tests">
				<summary>
					<span class="chev" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
					Check it against another message
					{#if additionalSamples.length > 0}
						<span class="pattern-count">{additionalSamples.length}</span>
					{/if}
				</summary>
				<div class="tests-body">
					<p class="hint">
						A second message from the same sender shows whether the pattern is too narrow or too
						loose.
					</p>

					{#if testMatches.length > 1}
						<ul class="match-list">
							{#each testMatches.slice(1) as match, index (match.body)}
								<li class={`match ${match.matched ? 'ok' : 'fail'}`}>
									<div class="match-top">
										<Badge tone={match.matched ? 'ok' : 'warn'}>
											{match.matched ? 'Matched' : 'No match'}
										</Badge>
										<span class="match-num">Message {index + 2}</span>
										<button
											type="button"
											class="var-x match-x"
											aria-label="Remove this message"
											title="Remove this message"
											onclick={() => removeSample(index)}
										>
											<Icon name="x" size={12} />
										</button>
									</div>
									<p class="match-body">{match.body}</p>
									{#if match.matched && Object.keys(match.extracted).length > 0}
										<div class="match-vars">
											{#each Object.entries(match.extracted) as [key, value] (key)}
												<span class="var-pill"><code>{key}</code> {value}</span>
											{/each}
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="hint tests-empty">No second message yet.</p>
					{/if}

					<div class="tests-add">
						<textarea
							class="input"
							rows="2"
							placeholder="Paste another message from the same sender"
							aria-label="Another message to test"
							bind:value={newSample}
						></textarea>
						<button
							type="button"
							class="btn btn-sm self-start"
							disabled={!newSample.trim()}
							onclick={addSample}
						>
							<Icon name="plus" size={14} />
							Add message
						</button>
					</div>
				</div>
			</details>
		</div>
	</div>
</dialog>

<style>
	.sheet-dialog {
		width: 100vw;
		max-width: 100vw;
		height: 100dvh;
		max-height: 100dvh;
		margin: 0;
		padding: clamp(8px, 2.4vh, 28px) var(--df-p-space-4);
		border: 0;
		background: transparent;
		color: var(--df-text-primary);
		overflow: hidden;
		display: grid;
		place-items: center;
		overscroll-behavior: contain;
	}

	.sheet-dialog::backdrop {
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(3px);
	}

	.sheet {
		width: min(860px, 100%);
		max-height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--df-surface-card);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-c-dialog-radius);
		box-shadow: var(--df-shadow-dialog);
		overflow: hidden;
		animation: sheet-in var(--df-p-dur-pop) var(--df-p-ease-standard) both;
	}

	@keyframes sheet-in {
		from {
			opacity: 0;
			transform: translateY(10px) scale(0.995);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	/* ------------------------------------------------------------- header */

	.sheet-head {
		flex: none;
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-5);
		border-bottom: 1px solid var(--df-border-hairline);
		background: color-mix(in srgb, var(--df-surface-well) 45%, var(--df-surface-card));
	}

	.head-mark {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex: none;
		border-radius: var(--df-p-radius-md);
		background: var(--df-accent-soft);
		color: var(--df-accent-text);
		margin-top: 2px;
	}

	.head-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.head-copy h2 {
		font-size: var(--df-p-text-xl);
		font-weight: 700;
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
	}

	.mode-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		padding-top: 2px;
	}

	.mode-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		color: var(--df-text-secondary);
	}

	.mode-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--df-accent-text);
		box-shadow: 0 0 0 3px var(--df-accent-soft);
	}

	.mode-sep {
		width: 1px;
		height: 11px;
		background: var(--df-border-hairline);
	}

	.mode-alt {
		font-size: var(--df-p-text-xs);
		font-weight: 500;
		color: var(--df-text-meta);
		text-decoration: none;
	}

	.head-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	/* --------------------------------------------------------------- body */

	.sheet-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--df-p-space-5);
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-5);
	}

	/* A scrolling flex column squeezes its children before it scrolls, which
	   clips a bordered block instead of moving it. */
	.sheet-body > * {
		flex: none;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
	}

	.section-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--df-text-primary);
	}

	.section-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		flex-wrap: wrap;
	}

	.sample-section {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
	}

	/* ------------------------------------------------------------ message */

	.message-card {
		padding: 18px 20px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.message-text {
		max-width: 68ch;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-md);
		line-height: 1.85;
		cursor: text;
		outline: none;
		overflow-wrap: anywhere;
	}

	.message-text :global(p + p) {
		margin-top: 10px;
	}

	/* The focused surface is the card, not the text block: a ring around a
	   paragraph narrower than the card reads as an error box. */
	.message-card:has(.message-text:focus-visible) {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	/* Marks are painted, not interactive: the message stays one sentence to
	   read and one tab stop, and none of them are buttons. */
	.message-text :global(mark.mk) {
		color: inherit;
		background: transparent;
		border-radius: 3px;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
		text-underline-offset: 3px;
	}

	.message-text :global(mark.mk-extract) {
		background: var(--df-accent-soft);
		text-decoration-line: underline;
		text-decoration-style: solid;
		text-decoration-color: var(--df-accent-text);
		text-decoration-thickness: 2px;
	}

	.message-text :global(mark.mk-trigger) {
		background: var(--df-state-ok-bg);
		text-decoration-line: underline;
		text-decoration-style: dotted;
		text-decoration-color: var(--df-state-ok-ink);
		text-decoration-thickness: 2px;
	}

	.message-text :global(mark.mk-ignore) {
		background: var(--df-state-neutral-bg);
		color: var(--df-text-secondary);
		text-decoration-line: underline;
		text-decoration-style: dashed;
		text-decoration-color: var(--df-state-neutral-ink);
	}

	.sample-hint {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}

	.sample-hint :global(svg) {
		margin-top: 1px;
		color: var(--df-text-meta);
	}

	.sample-empty,
	.sample-edit {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-4);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.sample-empty-title {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.row-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.self-start {
		align-self: flex-start;
	}

	.suggestion {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: 8px 10px;
		border: 1px solid var(--df-c-tint-edge-ok);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
		font-size: var(--df-p-text-sm);
		font-weight: 600;
	}

	.undo {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border: 1px solid color-mix(in srgb, var(--df-state-ok-ink) 35%, transparent);
		border-radius: var(--df-p-radius-pill);
		background: transparent;
		color: inherit;
		font-size: var(--df-p-text-xs);
		font-weight: 600;
	}

	.note {
		padding: 8px 10px;
		border-left: 2px solid var(--df-state-warn-ink);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-state-warn-bg);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
	}

	/* -------------------------------------------------------------- names */

	.assign {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
		border: 1px solid color-mix(in srgb, var(--df-accent-text) 38%, var(--df-border-hairline));
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-card);
		animation: assign-in var(--df-p-dur-lift) var(--df-p-ease-standard) both;
	}

	@keyframes assign-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.assign-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.assign-title {
		font-size: var(--df-p-text-sm);
		font-weight: 700;
		color: var(--df-text-primary);
	}

	.assign-quote {
		margin: 0;
		max-width: 34ch;
		padding: 2px 9px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-soft);
		color: var(--df-accent-text);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.assign-remove {
		margin-left: auto;
	}

	.assign-grid {
		display: grid;
		grid-template-columns: minmax(0, 260px) auto minmax(0, 190px);
		gap: var(--df-p-space-3);
		align-items: start;
	}

	.roles {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.role-btn {
		padding: 4px 9px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		white-space: nowrap;
		transition:
			background-color 140ms ease-out,
			color 140ms ease-out;
	}

	.role-btn[aria-pressed='true'] {
		background: var(--df-surface-selected);
		color: var(--df-text-primary);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}

	.role-hint {
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		color: var(--df-text-meta);
		min-height: 1.5em;
	}

	.assign-foot {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.assign-foot .check .hint {
		display: block;
		margin-top: 1px;
	}

	.assign-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		flex-wrap: wrap;
	}

	/* ------------------------------------------------------------ pattern */

	.pattern-block {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(200px, 0.9fr);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		overflow: hidden;
	}

	.pattern-main,
	.pattern-fields {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-4);
		min-width: 0;
	}

	.pattern-fields {
		border-left: 1px solid var(--df-border-hairline);
		background: color-mix(in srgb, var(--df-surface-card) 45%, var(--df-surface-well));
	}

	.pattern-main > .section-head {
		gap: var(--df-p-space-1);
	}

	.pattern-main > .section-head :global(.btn) {
		margin-left: auto;
	}

	.pattern-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-card);
		border: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		line-height: 1;
	}

	.pattern-code {
		margin: 0;
		padding: 10px 12px;
		max-height: 150px;
		overflow: auto;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-field);
		color: var(--df-text-primary);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.pattern-empty {
		padding: 12px 14px;
		border: 1px dashed var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-sm);
		line-height: 1.55;
		max-width: 52ch;
	}

	.var-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.var-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 4px;
	}

	.var-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		min-width: 0;
		padding: 3px 6px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		text-align: left;
	}

	.var-main:hover {
		background: var(--df-surface-card);
	}

	.var-name {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-primary);
	}

	.var-value {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		font-variant-numeric: tabular-nums;
	}

	.var-type {
		padding: 1px 6px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-card);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-2xs);
		white-space: nowrap;
	}

	.var-x {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
	}

	.var-x:hover {
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
	}

	/* -------------------------------------------------------------- tests */

	.tests {
		border-top: 1px solid var(--df-border-hairline);
		padding-top: var(--df-p-space-2);
	}

	.tests > summary {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: 6px 2px;
		list-style: none;
		cursor: pointer;
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		color: var(--df-text-secondary);
	}

	.tests > summary::-webkit-details-marker {
		display: none;
	}

	.chev {
		display: inline-flex;
		color: var(--df-text-meta);
		transition: transform 140ms ease-out;
	}

	.tests[open] .chev {
		transform: rotate(180deg);
	}

	.tests-body {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding-top: var(--df-p-space-2);
	}

	.tests-empty {
		padding: 4px 0;
	}

	.match-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.match {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		border: 1px solid var(--df-border-hairline);
		border-left-width: 3px;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
	}

	.match.ok {
		border-left-color: var(--df-state-ok-ink);
	}

	.match.fail {
		border-left-color: var(--df-state-warn-ink);
	}

	.match-top {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
	}

	.match-num {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		font-variant-numeric: tabular-nums;
	}

	.match-x {
		margin-left: auto;
	}

	.match-body {
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.match-vars {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.var-pill {
		padding: 1px 7px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-primary);
		font-variant-numeric: tabular-nums;
	}

	.var-pill code {
		font-family: var(--df-p-font-mono);
		color: var(--df-text-meta);
	}

	.tests-add {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding-top: var(--df-p-space-2);
	}

	/* ----------------------------------------------------------- examples */

	.examples {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.examples-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.examples-title {
		font-size: var(--df-p-text-base);
		font-weight: 700;
		color: var(--df-text-primary);
	}

	.examples-note {
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		color: var(--df-text-meta);
		max-width: 62ch;
	}

	.example-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.example {
		width: 100%;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		gap: 2px var(--df-p-space-3);
		align-items: center;
		padding: 9px 12px;
		border: 0;
		border-radius: var(--df-p-radius-sm);
		background: transparent;
		text-align: left;
		transition: background-color 140ms ease-out;
	}

	.example:hover {
		background: var(--df-surface-card);
	}

	.example-name {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.example-desc {
		grid-column: 1;
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.example .chip {
		grid-column: 2;
		grid-row: 1 / span 2;
	}

	/* ---------------------------------------------------------- responsive */

	@media (max-width: 720px) {
		.sheet-dialog {
			padding: 0;
		}

		.sheet {
			width: 100%;
			max-height: 100%;
			border-radius: 0;
			border: 0;
		}

		.sheet-head {
			padding: var(--df-p-space-4);
			flex-wrap: wrap;
		}

		.head-actions {
			width: 100%;
			margin-left: 0;
			justify-content: stretch;
		}

		.head-actions :global(.btn) {
			flex: 1 1 auto;
		}

		.sheet-body {
			padding: var(--df-p-space-4);
			gap: var(--df-p-space-4);
		}

		.section-actions {
			width: 100%;
		}

		.section-actions :global(.btn) {
			flex: 1 1 auto;
		}

		.assign-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.pattern-block {
			grid-template-columns: minmax(0, 1fr);
		}

		.pattern-fields {
			border-left: 0;
			border-top: 1px solid var(--df-border-hairline);
		}

		.assign-actions {
			width: 100%;
			margin-left: 0;
			justify-content: flex-end;
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.mode-alt:hover {
			color: var(--df-text-primary);
		}
	}
</style>
