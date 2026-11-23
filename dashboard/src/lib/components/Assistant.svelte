<script lang="ts">
	/**
	 * The agent panel.
	 *
	 * One launcher in the console's header, one panel that is not a modal and not a
	 * route. It reads the operator's saved conversation, asks about the page they
	 * are standing on, and renders answers, the work that produced them, proposals
	 * and the files a question carries.
	 *
	 * Two paths, and the deployment decides which one:
	 *
	 *  - **The agent route, and this is the panel.** `POST /v1/admin/agent/say`
	 *    answers with one document and files the turn under the operator's durable
	 *    conversation. `GET /v1/admin/agent/conversation` is that transcript, and
	 *    `DELETE` clears it.
	 *  - **Live.** `GET /v1/admin/agent/runtime` said `enabled: true`, so the panel
	 *    holds an `AgentLink` (`$lib/agent-socket`): a ticket, then a WebSocket. The
	 *    answer streams in, the steps that ran are drawn as a timeline under it, and
	 *    a turn that was cut off is asked for again rather than abandoned: its frames
	 *    live in a durable stream, so a dropped socket is a lost connection, not a
	 *    lost answer.
	 *
	 * Seven rules this panel keeps, on both paths:
	 *
	 *  - No invented state. Each failure is one line from `failureLine()` or
	 *    `agentTroubleLine()`, with the gateway's own detail under it only when the
	 *    gateway sent one. A read of the transcript that fails says so; it never
	 *    renders as an empty conversation, and the panel still answers.
	 *  - A refusal never replaces the model's words. A turn refused after the model
	 *    had written three sentences shows both, in the order they happened.
	 *  - A tool is a name and a verdict. Its output is dropped in the socket module
	 *    and there is no template here that could print it.
	 *  - A step exists because a `tool` frame settled it. The plan line counts the
	 *    batch the gateway announced in `calls`; the timeline is what already ran.
	 *  - One run is a note, several are a timeline: a lone successful read stays a
	 *    single quiet line, and the rail only appears when there is more than one
	 *    step or one of them did not succeed.
	 *  - No accept on `stage_workflow_patch`. That kind belongs to the workflow
	 *    editor's ghost banner; this panel only hands the patch over when an editor
	 *    is mounted, and explains the way there when it is not.
	 *  - A retry reuses the turn's idempotency key, so a question that did reach the
	 *    gateway is answered instead of asked twice. An answer that comes back
	 *    `replayed` says so, and the same rule makes a socket resume safe: the turn
	 *    is picked up where its sequence stopped, and the answer is folded in once.
	 *
	 * Files are honest about what the model can see. A chip carries the gateway's
	 * own kind; an image chip says it is named only, because the chat model on this
	 * deployment cannot see images. Removing a chip deletes the stored file.
	 *
	 * The panel is deliberately quiet: the console's tokens, 4px radii, no shadow,
	 * no gradient, no avatar, mono for ids and file names, and exactly one coral
	 * action (Ask). Its structure is header, transcript, this turn, files, composer,
	 * footer, so the reading order and the visual order are the same.
	 *
	 * It has two presentations and one panel. The control beside the close expands
	 * it to the screen: on a phone it *is* the screen, so it is a dialog that holds
	 * the page still and keeps Tab inside; on a wide screen it is a sheet with the
	 * page still visible and still live around it, so it stays a region and does not
	 * pretend to be modal. Expanded, the type takes the console's 15px reading step
	 * and the prose is capped at ~68 characters even when the sheet is wide. Escape
	 * gives back one step at a time — to floating first, closed only from floating —
	 * and the choice lives in `sessionStorage`, so it follows the tab.
	 *
	 * The button is a header action, so it holds a row of chrome and covers
	 * nothing; the panel hangs from the header as a corner pane when it is open.
	 * `+layout.svelte` renders that button, `$lib/assistant-dock.svelte` is the
	 * state between the two, and this file keeps the panel, its transcript and its
	 * keyboard behaviour. Opening, closing and putting focus back on the launcher
	 * all go through the dock so the two halves cannot disagree.
	 */
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import {
		acceptProposal,
		failureLine,
		failureTone,
		handPatchToEditor,
		sayAgent,
		workflowPatchSinkReady,
		type AssistantContext,
		type Failure,
		type Proposal,
		type SayOutcome
	} from '$lib/assistant';
	import { assistantDock } from '$lib/assistant-dock.svelte';
	import {
		AgentLink,
		ATTACHMENT_MAX_BYTES,
		ATTACHMENT_MAX_KEPT,
		ATTACHMENT_TTL_HOURS,
		agentCloseNote,
		agentLinkLabel,
		agentPhaseLine,
		agentRefusalLine,
		agentTroubleLine,
		applyAgentFrame,
		attachmentExpiredLine,
		attachmentIsExpired,
		attachmentKindLabel,
		attachmentSize,
		attachmentTooBigLine,
		attachmentTooManyLine,
		beginTurn,
		clearConversation,
		deleteAttachment,
		newIdempotencyKey,
		readAgentRuntime,
		readAttachments,
		readConversation,
		readTurnStream,
		uploadAttachment,
		type AgentAttachment,
		type AgentConversationMessage,
		type AgentEvent,
		type AgentFrame,
		type AgentLinkState,
		type AgentTrouble,
		type AgentTurn
	} from '$lib/agent-socket';
	import { formatAbsolute, formatClock } from '$lib/format';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import AnswerText from './AnswerText.svelte';
	import AssistantProposalCard, { type ProposalResult } from './AssistantProposalCard.svelte';
	import AssistantPromptBar from './assistant/AssistantPromptBar.svelte';
	import AssistantTrace from './assistant/AssistantTrace.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	/**
	 * `pageLabel` is the nav's own word for the page the operator is standing on.
	 *
	 * The route is the honest answer to "where am I" everywhere except the
	 * console root, where the path is a bare `/`: there the label says `Overview`,
	 * which is what the rail calls it. Empty means no line at all, never a slash.
	 */
	let { pageLabel = '' }: { pageLabel?: string } = $props();

	const uid = $props.id();
	const panelId = `assistant-panel-${uid}`;
	const titleId = `assistant-title-${uid}`;
	const contextId = `assistant-context-${uid}`;
	const historyId = `assistant-history-${uid}`;
	const turnId = `assistant-turn-${uid}`;
	const filesId = `assistant-files-${uid}`;

	/**
	 * A turn whose socket went away, and what this panel is doing about it.
	 *
	 * The durable stream means a dropped link is not the end of the answer, so the
	 * panel only says a turn was lost after it has actually tried to pick it up.
	 */
	type Recovery = { kind: 'resuming'; via: 'socket' | 'sse' } | { kind: 'lost' };

	/** One line under the files block: a limit, an expiry, or a removal that failed. */
	type Note = { tone: 'warn' | 'danger'; text: string };

	/**
	 * Three fresh tickets and three sockets inside about a second, or the durable
	 * stream is the better path. A ticket is cheap and single use, so a reconnect
	 * is worth a few tries; it is not worth a minute of a blank panel.
	 */
	const LINK_ATTEMPTS = 3;
	const LINK_BACKOFF_MS = 300;

	/** One SSE read that times out may simply have been tailing a slow turn. */
	const STREAM_ATTEMPTS = 2;

	/** Frame types that are the resume refusing, not the turn: read the stream instead. */
	const RESUME_REFUSALS = new Set([
		'stream_not_found',
		'bad_request',
		'agent_identity_missing',
		'unauthorised'
	]);

	/** The refusal reasons this panel has a sentence for; an unknown one prints its token. */
	const NAMED_REFUSALS = new Set([
		'grant_expired',
		'cap_reached',
		'turn_cap',
		'origin_refused',
		'agent_origin_untrusted',
		'agent_origin_missing',
		'agent_runtime_off',
		'session_expired'
	]);

	/**
	 * The one query that decides whether the panel is standing on a small screen.
	 *
	 * It is width alone — the same rule the stylesheet sizes the panel with, so the
	 * box and the semantics can never disagree — and it decides two things at once:
	 * whether the expanded panel is the whole viewport, and whether that makes it a
	 * dialog. A full-bleed surface that claimed to be a region would be a lie in one
	 * direction; a sheet that claimed to be a dialog would be a lie in the other.
	 */
	const COMPACT = '(max-width: 720px)';

	/**
	 * How much of the screen the panel takes.
	 *
	 * `floating` is the corner pane this panel has always been. `fullscreen` is the
	 * same panel with the room to read a long answer, and it is a presentation and
	 * not a second panel: one state, one transcript, one composer.
	 */
	type Presentation = 'floating' | 'fullscreen';

	/**
	 * The operator's choice, remembered for this tab.
	 *
	 * `sessionStorage`, not a cookie and not a row in D1: this is a preference about
	 * one window, and a new tab starts floating rather than inheriting a mode it did
	 * not ask for. A tab that will not remember simply starts floating.
	 */
	const PRESENTATION_KEY = 'dakflare.assistant.presentation';

	let open = $state(false);
	let question = $state('');
	/** The question the current answer belongs to, so Try again repeats that one. */
	let asked = $state('');
	let asking = $state(false);
	let outcome = $state<SayOutcome | null>(null);

	/* ---- the presentation ---- */

	/**
	 * Which presentation the panel is in, and the two facts that follow from it.
	 *
	 * `expanded` is the reading view. `modal` is the phone half of it: expanded *and*
	 * the screen is small enough that the panel covers the viewport, which is the
	 * only case where the panel blocks the page and so the only case that owes the
	 * page dialog semantics and a focus trap. Expanded on a wide screen is a big
	 * panel with the page still live around it, and it stays a region.
	 */
	let presentation = $state<Presentation>('floating');
	let small = $state(false);
	let panelEl = $state<HTMLElement | null>(null);
	let presentControl = $state<HTMLButtonElement | null>(null);

	const expanded = $derived(presentation === 'fullscreen');
	const modal = $derived(expanded && small);

	/**
	 * Tell the header's launcher what this panel is doing.
	 *
	 * `+layout.svelte` renders the button, so every state it has to describe —
	 * open or closed, and whether the panel has taken the screen — is written here
	 * the moment it changes, not derived in the header from something else. Three
	 * writers only: `show`, `close` and `setPresentation`.
	 */
	function publishDock(): void {
		assistantDock.open = open;
		assistantDock.expanded = expanded;
	}

	/** `unknown` until the runtime read answers; `off` never opens a socket. */
	let runtime = $state<'unknown' | 'on' | 'off'>('unknown');
	/**
	 * The in-flight runtime probe. An operator can type before the read lands, and
	 * without this the first question of a session silently used the stateless
	 * route even on a deployment with a runtime.
	 */
	let liveProbe: Promise<void> | null = null;
	let linkState = $state<AgentLinkState>('idle');
	let trouble = $state<AgentTrouble | null>(null);
	/** The object's own name, from the `ready` frame. Shown as a title, not a claim. */
	let agentName = $state<string | null>(null);
	let turn = $state<AgentTurn | null>(null);
	/** One question held while the link is being opened. */
	let queued = $state<{ question: string; key: string; attachmentIds: string[] } | null>(null);

	/**
	 * What happened to a turn whose link went away.
	 *
	 * `resuming` is the panel still working on the answer — `via` says whether it
	 * is on a fresh socket or reading the durable stream over HTTP. `lost` is the
	 * honest end of that road, and it is only ever reached after an attempt.
	 */
	let recovery = $state<Recovery | null>(null);
	/** The close, as a diagnostic line: `link closed (1006)`, while it matters. */
	let closeNote = $state<string | null>(null);

	let acceptingId = $state<string | null>(null);
	let results = $state<Record<string, ProposalResult>>({});
	/**
	 * Whether a workflow editor is mounted right now.
	 *
	 * The sink lives in a module variable, so this is re-read rather than
	 * subscribed: on open, whenever the route changes (the panel outlives
	 * navigation, so following the card's "open the workflow" link mounts an
	 * editor after the panel was opened), and whenever a new answer arrives.
	 */
	let stageReady = $state(false);

	/* ---- the durable session ---- */

	/** `loading` until the read answers. `failed` is a line, never an empty list. */
	let historyState = $state<'loading' | 'ready' | 'failed'>('loading');
	/** The read failed because this deployment has no durable session at all. */
	let historyUnavailable = $state(false);
	let history = $state<AgentConversationMessage[]>([]);
	let historyTruncated = $state(false);
	let confirmingClear = $state(false);
	let clearing = $state(false);

	/** `loading` until the kept files are read; a failure keeps upload available. */
	let attachmentState = $state<'loading' | 'ready' | 'failed'>('loading');
	let attachments = $state<AgentAttachment[]>([]);
	let uploading = $state(false);
	let removingId = $state<string | null>(null);
	let attachmentNote = $state<Note | null>(null);
	let dragOver = $state(false);

	/**
	 * The key and files the current question was sent with.
	 *
	 * Try again reuses both: the same turn, not a second one. The gateway then
	 * answers `replayed` instead of running the question again.
	 */
	let lastKey = $state<string | null>(null);
	let lastIds = $state<string[]>([]);
	let replayed = $state(false);
	/** Replay and loss are announced once per turn, whichever path reached them. */
	let replaySaid = false;
	let lossSaid = false;

	/* ---- the two live regions ---- */

	/**
	 * One polite region and one assertive one.
	 *
	 * Answer and replay are polite — they are the end of something the operator
	 * asked for. A refusal and a lost answer are assertive, because they change
	 * what the operator may believe is on screen. Each message is written once to
	 * exactly one region; nothing in the panel announces a second time.
	 */
	let politeText = $state('');
	let alertText = $state('');

	/** Drops an answer that arrives after the panel was closed or re-asked. */
	let sequence = 0;
	/** Drops a transcript or file read that belongs to a panel that is gone. */
	let sessionId = 0;

	/** The live link. Not reactive: its events are mirrored into the state above. */
	let agent: AgentLink | null = null;

	/** The in-flight SSE read, when the socket would not come back. */
	let stream: AbortController | null = null;
	/** A resume that this number no longer matches is stale and changes nothing. */
	let resumeToken = 0;

	/**
	 * Where the operator is. The chat endpoint takes the route and, on the editor,
	 * the flow, so an answer can name the thing on screen instead of asking which
	 * flow was meant.
	 */
	const context = $derived.by((): AssistantContext => {
		const route = page.url.pathname;
		if (route === ROUTES.workflowEdit) {
			const flowId = page.url.searchParams.get('id');
			return flowId === null ? { route } : { route, flowId };
		}
		return { route };
	});

	const contextLabel = $derived.by(() => {
		const route = context.route ?? '';
		const short = route.startsWith(BASE) ? route.slice(BASE.length) : route;
		// The console root strips to `/`, which says nothing: the nav's word for
		// that page does. Every other route keeps its path.
		const where = short === '' || short === '/' ? pageLabel : short;
		if (where === '') return '';
		return context.flowId ? `${where} · flow ${context.flowId}` : where;
	});

	const canAsk = $derived(!asking && question.trim() !== '');
	const live = $derived(runtime === 'on');
	const linkWord = $derived(agentLinkLabel(linkState));
	const unfinished = $derived(turn !== null && turn.status === 'streaming');
	/**
	 * A turn whose answer stopped arriving.
	 *
	 * `recovery` is a fact about this turn, not about the link: a reconnect clears
	 * `trouble`, and the point of this line is that the frames that were coming
	 * before the drop are not coming back on their own.
	 */
	const resuming = $derived(recovery?.kind === 'resuming');
	const cutOff = $derived(unfinished && recovery?.kind === 'lost');
	/** The streaming caret: while text is still arriving and nothing is wrong. */
	const caretShown = $derived(unfinished && recovery === null && trouble === null);

	/** The header's phase word: the link's state, or the HTTP ask in flight. */
	const phaseWord = $derived.by(() => {
		if (live) {
			return turn !== null && !unfinished && linkState === 'closed' ? 'recovered' : linkWord;
		}
		return asking ? 'asking' : '';
	});

	/**
	 * The timeline, as the turn holds it.
	 *
	 * `steps` is what settled, and nothing else: a row appears when a `tool` frame
	 * says a run happened. `pending` is the batch the gateway announced and has not
	 * finished, which is what the plan line counts. The two are different facts and
	 * are kept apart on purpose — queuing a call is not doing it.
	 */
	const steps = $derived(turn?.steps ?? []);
	const pending = $derived(turn?.queue.length ?? 0);
	/** The plan line's place, only while a step is actually queued. */
	const planStep = $derived(steps.length + 1);
	const planTotal = $derived(steps.length + pending);

	/** Whether the current exchange has anything to show under "This turn". */
	const showTurn = $derived(
		asked !== '' ||
			asking ||
			turn !== null ||
			outcome !== null ||
			(historyState === 'ready' && history.length > 0)
	);
	const sentFiles = $derived(lastIds.length);

	// The sink appears and disappears with the editor, which is a different
	// component on a different route. Nothing else would tell this panel.
	$effect(() => {
		const route = page.url.pathname;
		void route;
		void outcome;
		stageReady = workflowPatchSinkReady();
	});

	/**
	 * A dialog has to hold the page still, and a panel does not.
	 *
	 * Only the phone's expanded panel claims `aria-modal`, because only there does
	 * the surface cover the viewport. A wheel over its header would otherwise scroll
	 * the page underneath an opaque panel, which is the classic half-modal: claiming
	 * one thing and doing another. Expanded on a wide screen leaves the page alone
	 * on purpose — the page is still visible around the sheet and still scrolls,
	 * which is why it stays a region.
	 */
	$effect(() => {
		if (!modal) return;
		const root = document.documentElement;
		const before = root.style.overflow;
		root.style.overflow = 'hidden';
		return () => {
			root.style.overflow = before;
		};
	});

	onMount(() => {
		const query = window.matchMedia(COMPACT);
		small = query.matches;
		const follow = (event: MediaQueryListEvent): void => {
			small = event.matches;
		};
		query.addEventListener('change', follow);
		return () => query.removeEventListener('change', follow);
	});

	/**
	 * Hand the header's launcher a way to open this panel.
	 *
	 * The button lives in another component, so it cannot call `show()` directly;
	 * it calls the function registered here. Between unmount and mount the
	 * registered function does nothing, which is the honest answer for a button
	 * whose panel is not on the page.
	 */
	onMount(() => {
		assistantDock.panelId = panelId;
		assistantDock.toggle = () => void toggle();
		return () => {
			assistantDock.panelId = '';
			assistantDock.toggle = () => {};
			assistantDock.open = false;
			assistantDock.expanded = false;
		};
	});

	onDestroy(() => {
		sequence += 1;
		sessionId += 1;
		// A read that is still tailing must not write into a panel that is gone.
		resumeToken += 1;
		stream?.abort();
		stream = null;
		agent?.close();
		agent = null;
	});

	/** Write one message into exactly one live region, once. */
	function say(text: string, urgent = false): void {
		const next = text.trim();
		if (next === '') return;
		if (urgent) {
			alertText = '';
			queueMicrotask(() => {
				alertText = next;
			});
			return;
		}
		politeText = '';
		queueMicrotask(() => {
			politeText = next;
		});
	}

	async function toggle(): Promise<void> {
		if (open) close();
		else await show();
	}

	async function show(): Promise<void> {
		// The tab's own choice, read on every open so a panel that was closed while
		// expanded comes back expanded, and a fresh tab comes back floating.
		presentation = readPresentation();
		open = true;
		publishDock();
		stageReady = workflowPatchSinkReady();
		sessionId += 1;
		await tick();
		// Expanded, the panel opens as a reading view with the keyboard down: a
		// focused field would raise a soft keyboard over half the screen before the
		// operator asked to type. The surface itself takes focus, so Tab starts
		// inside it and Escape is where the operator expects it. Floating, the field
		// is the point of the panel and takes focus as it always has.
		if (expanded) panelEl?.focus();
		else panelEl?.querySelector<HTMLInputElement>('input.ask-input')?.focus();
		void loadSession();
		liveProbe = startLive();
		void liveProbe;
	}

	/* ---- the presentation ---- */

	/**
	 * The tab's choice of presentation, read and written.
	 *
	 * Both calls absorb the same failure: a browser that refuses `sessionStorage`
	 * (some privacy modes throw on write) must not take the panel down with it.
	 * Reading then answers `floating`, which is the safe half — a tab that cannot
	 * remember starts quietly.
	 */
	function readPresentation(): Presentation {
		try {
			return window.sessionStorage.getItem(PRESENTATION_KEY) === 'fullscreen'
				? 'fullscreen'
				: 'floating';
		} catch {
			return 'floating';
		}
	}

	function rememberPresentation(next: Presentation): void {
		try {
			window.sessionStorage.setItem(PRESENTATION_KEY, next);
		} catch {
			// The choice still holds for this open; it just will not survive a reload.
		}
	}

	/**
	 * To the screen, or back to the corner.
	 *
	 * The control that does this is the same element in both presentations, so focus
	 * never has to be moved to keep the operator where they were: it is put back
	 * explicitly anyway, because the box under it changes size and some browsers
	 * move focus when a layout shift takes the focused element near the edge.
	 */
	async function setPresentation(next: Presentation): Promise<void> {
		if (presentation === next) return;
		presentation = next;
		rememberPresentation(next);
		publishDock();
		await tick();
		presentControl?.focus();
	}

	/**
	 * Keep Tab inside the surface that claims to be modal.
	 *
	 * This runs only for the phone's expanded panel, which is the only shape that
	 * sets `aria-modal`. The wide sheet deliberately has no trap: the page around it
	 * is visible and live, so Tab leaving the sheet is the truth, not a leak.
	 */
	function trapFocus(event: KeyboardEvent): void {
		const root = panelEl;
		if (root === null) return;

		const stops = Array.from(
			root.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		).filter((node) => node.getClientRects().length > 0);

		const first = stops[0];
		const last = stops[stops.length - 1];
		if (first === undefined || last === undefined) {
			event.preventDefault();
			root.focus();
			return;
		}

		const active = document.activeElement;
		const outside = !(active instanceof Node) || !root.contains(active);
		if (event.shiftKey) {
			if (outside || active === first || active === root) {
				event.preventDefault();
				last.focus();
			}
			return;
		}
		if (outside || active === last || active === root) {
			event.preventDefault();
			first.focus();
		}
	}

	/**
	 * Read the two things that outlive one open: the transcript and the kept files.
	 *
	 * They are read together and reported apart: a conversation that cannot be
	 * read does not stop the files from being listed, and neither stops a question.
	 */
	async function loadSession(): Promise<void> {
		const id = sessionId;
		historyState = 'loading';
		attachmentState = 'loading';

		const [conversation, files] = await Promise.all([readConversation(), readAttachments()]);
		if (!open || id !== sessionId) return;

		if (conversation.status === 'ok') {
			history = conversation.conversation.messages;
			historyTruncated = conversation.conversation.truncated;
			historyUnavailable = false;
			historyState = 'ready';
		} else {
			history = [];
			historyTruncated = false;
			historyUnavailable = conversation.failure.kind === 'unavailable';
			historyState = 'failed';
		}

		if (files.status === 'ok') {
			attachments = files.attachments;
			attachmentState = 'ready';
		} else {
			attachmentState = 'failed';
		}
	}

	/** One link, tuned for a panel: a few quick reconnects, then the stream. */
	function newLink(): AgentLink {
		return new AgentLink({
			onEvent: handleAgentEvent,
			maxAttempts: LINK_ATTEMPTS,
			baseDelayMs: LINK_BACKOFF_MS
		});
	}

	/**
	 * Ask the runtime whether this deployment has one, and open a link when it does.
	 *
	 * A read that fails is not a reason to try the socket: the agent route over
	 * HTTP is the default and it works, so `off` is the honest answer to both.
	 */
	async function startLive(): Promise<void> {
		const id = sequence;
		const read = await readAgentRuntime();
		if (!open || id !== sequence) return;

		if (read.status !== 'ok' || !read.runtime.enabled) {
			runtime = 'off';
			return;
		}

		runtime = 'on';
		// The panel may have asked before this read resolved, and that ask already
		// made a link. Reuse it: closing it here would drop a turn that had started.
		if (agent === null) agent = newLink();
		await agent.connect();
	}

	function handleAgentEvent(event: AgentEvent): void {
		if (!open) return;
		if (event.kind === 'link') {
			onLink(event.state, event.trouble);
			return;
		}
		onFrame(event.frame);
	}

	/**
	 * The link moved. Most of this is the state above; the part that matters here
	 * is a turn in flight, because a close then is a transport problem the durable
	 * stream can answer.
	 */
	function onLink(state: AgentLinkState, next: AgentTrouble | null): void {
		const wasOpen = linkState === 'open';
		linkState = state;
		trouble = next;

		if (state === 'open') {
			// A reconnect during a resume is not a new question: ask for the rest of
			// the turn from where its frames stopped.
			if (recovery?.kind === 'resuming' && recovery.via === 'socket') {
				resumeOnSocket();
				return;
			}
			sendQueued();
			return;
		}

		const streaming = turn !== null && turn.status === 'streaming';
		if (wasOpen && streaming && turn !== null) {
			// The link dropped with a turn in flight. Keep the turn: it is in a
			// durable stream, so what is at stake is the connection, not the answer.
			queued = null;
			asking = false;
			closeNote = next === null ? null : agentCloseNote(next);
			if (turn.streamId === null) {
				// No stream was ever named, so there is nothing to ask for. This is the
				// one close after which the text that arrived is all there will be.
				recovery = { kind: 'lost' };
				announceLoss();
			} else {
				recovery = { kind: 'resuming', via: 'socket' };
				asking = true;
			}
		}

		if (state !== 'closed') return;

		// Final: no further attempt is coming.
		if (turn !== null && turn.status === 'streaming') {
			if (turn.streamId !== null) {
				void resumeViaStream();
				return;
			}
			asking = false;
			// Nothing arrived at all: the refusal is the story, and the line below it
			// stays the gateway's own.
			if (turn.text !== '' || turn.steps.length > 0) {
				recovery = { kind: 'lost' };
				announceLoss();
			}
			return;
		}

		asking = false;

		if (next?.reason === 'agent_runtime_off') {
			// The runtime went off between the read and the ticket: the HTTP route is
			// the honest fallback, and it is the same question.
			const holding = queued;
			queued = null;
			runtime = 'off';
			agent?.close();
			agent = null;
			turn = null;
			if (holding !== null) {
				asking = true;
				void askStateless(holding.question, holding.key, holding.attachmentIds);
			}
		}
	}

	/** Send the resume frame for the current turn, when a socket just came back. */
	function resumeOnSocket(): void {
		const current = turn;
		if (current === null || current.streamId === null) return;
		if (agent === null) {
			void resumeViaStream();
			return;
		}
		const sent = agent.resume(current.streamId, current.seq + 1);
		if (sent.status === 'waiting') {
			// It closed between the open event and the send. The link's own retry opens
			// another socket, and that open sends this again.
			return;
		}
	}

	/**
	 * Read the turn's durable stream over HTTP.
	 *
	 * This is the last attempt, not a first choice: the socket carries live frames,
	 * and the stream is here for the case where a browser will not keep a socket
	 * open. A `timeout` event means the turn is still live and the server stopped
	 * tailing, so one more read from where it stopped is worth making.
	 */
	async function resumeViaStream(): Promise<void> {
		const current = turn;
		if (current === null || current.streamId === null) return;

		const token = ++resumeToken;
		const streamId = current.streamId;
		recovery = { kind: 'resuming', via: 'sse' };
		asking = true;

		for (let attempt = 0; attempt < STREAM_ATTEMPTS; attempt += 1) {
			const controller = new AbortController();
			stream = controller;
			const from = (turn?.seq ?? 0) + 1;
			const result = await readTurnStream({
				streamId,
				from,
				signal: controller.signal,
				onFrame: (frame, seq) => onFrame(frame, seq)
			});
			if (stream === controller) stream = null;

			if (token !== resumeToken || !open) return;
			if (turn === null || turn.status !== 'streaming') return;
			if (result.status === 'timeout') continue;
			break;
		}

		if (token !== resumeToken || !open) return;
		if (turn !== null && turn.status === 'streaming') {
			recovery = { kind: 'lost' };
			announceLoss();
			asking = false;
		}
	}

	/** Stop any in-flight stream read and forget the recovery it belonged to. */
	function resetRecovery(): void {
		resumeToken += 1;
		stream?.abort();
		stream = null;
		recovery = null;
		closeNote = null;
	}

	/** One frame, folded into the turn it belongs to. */
	function onFrame(frame: AgentFrame, seq?: number): void {
		if (frame.type === 'ready') {
			agentName = frame.name !== '' ? frame.name : null;
			return;
		}

		const current = turn;
		// Nothing to attach a frame to: this panel did not ask the question it
		// answers. Rendering it would invent a conversation.
		if (current === null) return;

		// The socket refused the *resume*, not the turn: the stream is still there,
		// and asking for it over HTTP is the same request the socket failed to serve.
		if (frame.type === 'error' && resuming && RESUME_REFUSALS.has(frame.reason)) {
			void resumeViaStream();
			return;
		}

		const result = applyAgentFrame(current, frame, seq);
		turn = result.turn;
		if (!result.fresh) return;

		if (frame.type === 'answer') {
			asking = false;
			queued = null;
			resetRecovery();
			const count = turn?.proposals.length ?? 0;
			// The answer frame's own count when it sent one, otherwise the steps that
			// settled: a five-step turn is five tool runs whether or not the last
			// frame repeated the number.
			const calls = Math.max(frame.calls, turn?.steps.length ?? 0);
			say(
				calls > 0
					? `The assistant answered, after ${calls} ${calls === 1 ? 'tool run' : 'tool runs'}.`
					: count === 0
						? 'The assistant answered.'
						: `The assistant answered, with ${count} ${count === 1 ? 'proposal' : 'proposals'}.`
			);
			if (turn?.replayed === true) announceReplay();
			return;
		}

		if (frame.type === 'error') {
			asking = false;
			queued = null;
			resetRecovery();
			say(agentRefusalLine(frame.reason), true);
		}
	}

	function sendQueued(): void {
		const holding = queued;
		queued = null;
		if (holding === null) return;

		if (agent === null) {
			queued = holding;
			return;
		}

		const sent = agent.ask(holding.question, holding.key, holding.attachmentIds);
		if (sent.status === 'waiting') {
			// It closed between the event and the send. The next `open` gets it.
			queued = holding;
			return;
		}
		if (sent.status === 'refused') {
			asking = false;
			turn = null;
			const failure: Failure = { kind: 'refused', message: sent.message };
			outcome = { status: 'failed', failure, replayed: false, via: 'agent' };
			say(sent.message, true);
		}
	}

	function close(): void {
		open = false;
		// Closing does not rewrite the tab's choice: a panel closed while expanded
		// reopens expanded. The transient state goes back to floating so the
		// launcher — hidden while the panel owns the screen — is there to take focus.
		presentation = 'floating';
		publishDock();
		question = '';
		asked = '';
		outcome = null;
		asking = false;
		acceptingId = null;
		results = {};
		turn = null;
		queued = null;
		resetRecovery();
		trouble = null;
		linkState = 'idle';
		agentName = null;
		sequence += 1;
		sessionId += 1;
		history = [];
		historyState = 'loading';
		historyUnavailable = false;
		historyTruncated = false;
		confirmingClear = false;
		clearing = false;
		attachments = [];
		attachmentState = 'loading';
		attachmentNote = null;
		uploading = false;
		removingId = null;
		dragOver = false;
		lastKey = null;
		lastIds = [];
		replayed = false;
		replaySaid = false;
		lossSaid = false;
		politeText = '';
		alertText = '';
		agent?.close();
		agent = null;
		// The launcher is a header button this panel does not own. One frame passes
		// first, because the button is hidden while the panel is expanded and a
		// hidden button cannot take focus.
		void tick().then(() => {
			document.getElementById(assistantDock.launcherId)?.focus();
		});
	}

	/**
	 * Escape gives back one thing at a time.
	 *
	 * Expanded, it collapses to the floating panel, because taking a transcript away
	 * from an operator who just made it readable is the wrong first answer. Floating,
	 * it closes, with focus back on the launcher. Tab is trapped only where the panel
	 * says it is modal.
	 */
	function onkeydown(event: KeyboardEvent): void {
		if (!open) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			if (expanded) void setPresentation('floating');
			else close();
			return;
		}

		if (event.key === 'Tab' && modal) trapFocus(event);
	}

	/**
	 * Ask one question, on whichever path this deployment has.
	 *
	 * `reuseKey` and `reuseIds` are a retry's: the same question, the same turn, so
	 * a gateway that did receive the first attempt answers instead of running a
	 * second one.
	 */
	async function runAsk(
		text: string,
		reuseKey?: string | null,
		reuseIds?: string[]
	): Promise<void> {
		const next = text.trim();
		if (next === '' || asking) return;
		// The probe decides which path this turn takes, so an early ask waits for it.
		if (runtime === 'unknown' && liveProbe !== null) await liveProbe;
		if (!open) return;

		const expired =
			reuseIds === undefined ? attachments.filter((file) => attachmentIsExpired(file)) : [];
		if (expired.length > 0) {
			// One line, and it names the limit: a file is kept 24 hours, not forever.
			const line =
				expired.length === 1
					? attachmentExpiredLine(expired[0].name)
					: `${expired.length} files expired. Files are kept ${ATTACHMENT_TTL_HOURS} hours; attach them again.`;
			attachmentNote = { tone: 'warn', text: line };
			say(line, true);
		}

		const ids: string[] =
			reuseIds ?? attachments.filter((file) => !attachmentIsExpired(file)).map((file) => file.id);
		const key = reuseKey ?? newIdempotencyKey();

		question = next;
		asked = next;
		asking = true;
		outcome = null;
		turn = null;
		queued = null;
		lastKey = key;
		lastIds = ids;
		replayed = false;
		replaySaid = false;
		lossSaid = false;
		// A refusal from the attempt before is no longer the current fact. It is
		// removed without being announced: nothing new happened yet.
		alertText = '';
		resetRecovery();
		results = {};

		// The files belong to the question they were attached for; the stored copy
		// stays on the gateway until it expires or is removed.
		if (reuseIds === undefined) attachments = [];

		if (runtime === 'on') {
			await askLive(next, key, ids);
			return;
		}
		await askStateless(next, key, ids);
	}

	async function askStateless(text: string, key: string, ids: string[]): Promise<void> {
		const id = ++sequence;
		const result = await sayAgent({
			message: text,
			context,
			attachmentIds: ids,
			idempotencyKey: key
		});
		if (id !== sequence) return;

		outcome = result;
		asking = false;
		if (result.status === 'ok') {
			const count = result.proposals.length;
			say(
				count === 0
					? 'The assistant answered.'
					: `The assistant answered, with ${count} ${count === 1 ? 'proposal' : 'proposals'}.`
			);
			if (result.replayed) announceReplay();
		} else if (result.status === 'failed') {
			say(failureLine(result.failure), true);
		}
	}

	async function askLive(text: string, key: string, ids: string[]): Promise<void> {
		turn = beginTurn(text, key);
		queued = { question: text, key, attachmentIds: ids };

		if (agent === null) agent = newLink();
		if (agent.state === 'open') {
			sendQueued();
			return;
		}
		await agent.connect();
	}

	/* ------------------------------------------------------------ the files */

	/** The file control's change: one batch, checked before anything is sent. */
	function pickFiles(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		// Clearing the value lets the same file be chosen twice in a row.
		input.value = '';
		void attachFiles(files);
	}

	function onDrop(event: DragEvent): void {
		event.preventDefault();
		dragOver = false;
		if (asking) return;
		const files = Array.from(event.dataTransfer?.files ?? []);
		void attachFiles(files);
	}

	function onDragOver(event: DragEvent): void {
		event.preventDefault();
		if (!asking) dragOver = true;
	}

	function onDragLeave(event: DragEvent): void {
		// The panel has children; a drag leaving one of them is not a drag out.
		const next = event.relatedTarget;
		if (next instanceof Node && (event.currentTarget as Node).contains(next)) return;
		dragOver = false;
	}

	/** One refusal, one line, the limit in it. */
	function refuseAttachment(text: string, tone: 'warn' | 'danger' = 'danger'): void {
		attachmentNote = { tone, text };
		say(text, true);
	}

	async function attachFiles(files: File[]): Promise<void> {
		if (files.length === 0 || asking) return;
		attachmentNote = null;

		for (const file of files) {
			if (attachments.length >= ATTACHMENT_MAX_KEPT) {
				refuseAttachment(attachmentTooManyLine());
				return;
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				refuseAttachment(attachmentTooBigLine(file.name, file.size));
				continue;
			}

			uploading = true;
			const result = await uploadAttachment(file);
			uploading = false;
			if (!open) return;

			if (result.status === 'failed') {
				refuseAttachment(result.message);
				return;
			}
			attachments = [...attachments, result.attachment];
			if (attachmentIsExpired(result.attachment)) {
				refuseAttachment(attachmentExpiredLine(result.attachment.name), 'warn');
				continue;
			}
			say(`Attached ${result.attachment.name}.`);
		}
	}

	/** Removing the chip deletes the stored file, not just the row on screen. */
	async function removeAttachment(file: AgentAttachment): Promise<void> {
		if (removingId !== null || uploading) return;
		removingId = file.id;
		const result = await deleteAttachment(file.id);
		removingId = null;
		if (!open) return;

		if (result.status === 'ok') {
			attachments = attachments.filter((entry) => entry.id !== file.id);
			attachmentNote = null;
			say(`Removed ${file.name}.`);
			return;
		}
		refuseAttachment(result.message);
	}

	/* --------------------------------------------------------- the transcript */

	/** Clear, then confirm inline. Nothing here opens a dialog. */
	async function clearHistory(): Promise<void> {
		if (clearing) return;
		clearing = true;
		attachmentNote = null;
		const result = await clearConversation();
		clearing = false;
		confirmingClear = false;
		if (!open) return;

		if (result.status === 'ok') {
			history = [];
			historyTruncated = false;
			historyState = 'ready';
			say('The saved transcript was deleted.');
			return;
		}
		say(failureLine(result.failure), true);
	}

	function announceReplay(): void {
		if (replaySaid) return;
		replaySaid = true;
		replayed = true;
		say('Answered earlier from the same request — nothing ran twice.');
	}

	/* ----------------------------------------------------------- proposals */

	async function accept(proposal: Proposal): Promise<void> {
		if (acceptingId !== null) return;
		acceptingId = proposal.id;
		const result = await acceptProposal(proposal.id);
		acceptingId = null;
		results = {
			...results,
			[proposal.id]:
				result.status === 'ok'
					? {
							tone: 'ok',
							text: result.message,
							ids: result.ids,
							detail: result.detail
						}
					: { tone: 'danger', text: failureLine(result.failure), ids: [], detail: null }
		};
		say(result.status === 'ok' ? 'Proposal accepted.' : 'The proposal was not accepted.');
	}

	/**
	 * The editor's ghost staging, reached through the sink it registers. The card
	 * only offers this when that sink exists, so a failed handover here is the
	 * editor refusing the patch (it does not fit the open flow), not this panel
	 * guessing.
	 */
	function stage(proposal: Proposal): void {
		const result = handPatchToEditor({
			intent: proposal.summary !== '' ? proposal.summary : proposal.title,
			patch: patchOf(proposal),
			flowId: flowIdOf(proposal)
		});
		results = {
			...results,
			[proposal.id]: {
				tone: result.ok ? 'ok' : 'danger',
				text: result.message,
				ids: [],
				detail: null
			}
		};
		say(result.ok ? 'Patch staged in the editor.' : 'The patch was not staged.');
	}

	/** The flow a patch names in its own payload, or null when it names none. */
	function flowIdOf(proposal: Proposal): string | null {
		const payload = proposal.payload;
		if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
		const id = (payload as Record<string, unknown>).flow_id;
		return typeof id === 'string' && id !== '' ? id : null;
	}

	/** A payload either wraps the graph or is the graph; both shapes are honest. */
	function patchOf(proposal: Proposal): unknown {
		const payload = proposal.payload;
		if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
			const wrap = (payload as Record<string, unknown>).patch;
			if (wrap !== undefined) return wrap;
		}
		return payload;
	}

	/** A refusal is the operator's problem only when it is about them or the origin. */
	function refusalTone(reason: string): 'warn' | 'danger' {
		return reason === 'grant_expired' || reason === 'cap_reached' || reason === 'turn_cap'
			? 'warn'
			: 'danger';
	}

	/** The one line under a turn that has not produced an answer yet. */
	function waitingLine(): string {
		if (recovery?.kind === 'resuming') {
			return recovery.via === 'sse'
				? 'The link did not come back. Reading the rest of the turn from where it stopped…'
				: 'The link dropped. Asking the agent for the rest of the turn…';
		}
		if (linkState === 'retrying' || linkState === 'ticket' || linkState === 'connecting') {
			return 'Connecting to the agent…';
		}
		// The turn was announced, so the gateway has the question even though it has
		// not said what it is doing yet. This is the sentence a 25-second turn needs.
		if (turn !== null && turn.streamId !== null) {
			return 'The agent has the question and is working on it…';
		}
		return 'The model is writing…';
	}

	/**
	 * The loss is a terminal outcome like an answer or a refusal, so it is announced
	 * the same way. Without this a screen reader hears nothing where the turn died.
	 * It is said once per turn, whichever close path noticed it first.
	 */
	function announceLoss(): void {
		if (lossSaid || turn === null) return;
		lossSaid = true;
		say(lostLine(), true);
	}

	function lostLine(): string {
		return turn?.streamId != null
			? 'The link closed and the answer could not be picked up again. Nothing after this point arrived.'
			: 'The link closed before the answer finished. Nothing after this point arrived.';
	}

</script>

<svelte:window onkeydown={onkeydown} />

<!-- The caret is the one mark the answer adds while it is still arriving: it is
     handed to AnswerText and rendered inside the last paragraph, right after the
     last word, rather than on a line of its own. -->
{#snippet caret()}<span class="caret" aria-hidden="true"></span>{/snippet}

{#if open}
	<section
		id={panelId}
		class="panel"
		data-presentation={presentation}
		role={modal ? 'dialog' : undefined}
		aria-modal={modal ? 'true' : undefined}
		aria-labelledby={titleId}
		aria-describedby={contextLabel === '' ? undefined : contextId}
		tabindex="-1"
		bind:this={panelEl}
	>
		<header class="panel-head">
			<div class="head-row">
				<div class="head-copy">
					<div class="title-row">
						<h2 class="panel-title" id={titleId}>Assistant</h2>
						{#if phaseWord !== ''}
							<!-- The one factual marker of the live path: a word, not a badge. It
							     is absent entirely when the runtime is off and nothing is asked. -->
							<span
								class="link-chip mono"
								data-state={live ? linkState : 'asking'}
								title={agentName === null ? undefined : `agent ${agentName}`}
							>
								{phaseWord}
							</span>
						{/if}
					</div>
					{#if contextLabel !== ''}
						<p class="context mono" id={contextId}>{contextLabel}</p>
					{/if}
				</div>
				<div class="head-actions">
					<!-- One control, two presentations, and a name that says which way it
					     goes. It is not a disclosure: nothing folds away, the same panel
					     changes size, so the name carries the state instead of a chevron. -->
					<button
						type="button"
						class="head-action presentation"
						bind:this={presentControl}
						aria-label={expanded ? 'Collapse to floating' : 'Expand the assistant'}
						onclick={() => void setPresentation(expanded ? 'floating' : 'fullscreen')}
					>
						<Icon name={expanded ? 'collapse' : 'expand'} size={19} />
					</button>
					<button type="button" class="head-action close" onclick={close} aria-label="Close panel">
						<Icon name="x" size={15} />
					</button>
				</div>
			</div>
		</header>

		<!-- Two regions, both present before anything is written into them, and
		     each event written to exactly one: answers and replays are polite,
		     refusals and losses are assertive. -->
		<div class="sr-only" role="status" aria-live="polite">{politeText}</div>
		<div class="sr-only" role="alert">{alertText}</div>

		<div class="body" aria-busy={asking}>
			{#if historyState === 'loading'}
				<p class="state waiting"><Spinner /> Reading the saved conversation…</p>
			{:else if historyState === 'failed'}
				<p class="state" data-tone="warn">
					{historyUnavailable
						? 'This deployment keeps no saved conversation. You can still ask.'
						: 'The saved conversation could not be read, so earlier turns are not shown. You can still ask.'}
				</p>
			{:else if history.length > 0}
				<section class="thread" aria-labelledby={historyId}>
					<div class="section-head">
						<h3 class="section-title" id={historyId}>Earlier turns</h3>
						<span class="section-meta mono">
							{history.length} {history.length === 1 ? 'message' : 'messages'}
						</span>
						{#if !confirmingClear}
							<button
								type="button"
								class="clear"
								onclick={() => (confirmingClear = true)}
							>
								Clear
							</button>
						{/if}
					</div>

					{#if confirmingClear}
						<!-- The confirm is inline: no dialog, no scrim, and the sentence
						     says what deletion means before the button does it. -->
						<div class="clear-confirm" role="group" aria-label="Clear the saved transcript">
							<p class="clear-say">
								{clearing
									? 'Deleting the saved transcript…'
									: 'Deletes the saved transcript on the gateway. This cannot be undone.'}
							</p>
							<div class="clear-actions">
								<button
									type="button"
									class="btn btn-sm"
									disabled={clearing}
									aria-busy={clearing}
									onclick={() => void clearHistory()}
								>
									{clearing ? 'Deleting' : 'Delete transcript'}
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-sm"
									disabled={clearing}
									onclick={() => (confirmingClear = false)}
								>
									Keep
								</button>
							</div>
						</div>
					{/if}

					{#if historyTruncated}
						<p class="history-note">
							Showing the last {history.length} messages; earlier ones are not loaded.
						</p>
					{/if}

					<ol class="messages">
						{#each history as message (message.id)}
							{@const when = message.at}
							<li class="message" data-role={message.role}>
								<span class="message-head">
									<span class="message-who">{message.role === 'user' ? 'You' : 'Assistant'}</span>
									{#if when !== null}
										<time
											class="message-time mono"
											datetime={new Date(when).toISOString()}
											title={formatAbsolute(when)}
										>
											{formatClock(when)}
										</time>
									{/if}
								</span>
								{#if message.role === 'assistant'}
									<!-- The model answers in Markdown; the operator's own words are
									     printed exactly as they were typed, as they are in This turn. -->
									<AnswerText class="message-text" text={message.text} />
								{:else}
									<p class="message-text">{message.text}</p>
								{/if}
							</li>
						{/each}
					</ol>
				</section>
			{:else if !showTurn}
				<p class="state quiet">
					No earlier turns yet. Ask about this page; your questions and answers are kept on this
					gateway.
				</p>
			{/if}

			{#if showTurn}
				<section class="turn" aria-labelledby={turnId}>
					<div class="section-head">
						<h3 class="section-title" id={turnId}>This turn</h3>
						{#if sentFiles > 0}
							<span class="section-meta mono">
								{sentFiles} {sentFiles === 1 ? 'file' : 'files'}
							</span>
						{/if}
					</div>

					{#if asked !== ''}
						<p class="turn-question"><span class="sr-only">Your question: </span>{asked}</p>
					{/if}

					{#if live && (asking || turn !== null)}
						<!-- The live path. Nothing here is drawn from a frame this turn does
						     not have: the text is what arrived, the steps are what settled, the
						     refusal is what the gateway said. -->
						{#if turn !== null}
							{#if turn.phase !== null && unfinished && recovery === null}
								<!-- One quiet line, the server's own progress. No invented tokens: the
								     panel says what is happening without pretending to write. The
								     counter is the batch the gateway announced, so it can never
								     point at a step the server did not name. Once a turn is being
								     recovered, the recovery line owns this space. -->
								<p class="state quiet phase">
									<Spinner /> {agentPhaseLine(turn.phase)}{#if pending > 0 && planTotal > 1}<span
											class="phase-count"
										>· step {planStep} of {planTotal}</span>{/if}
								</p>
							{/if}

							{#if turn.text !== ''}
								<AnswerText class="answer" text={turn.text} trailing={caretShown ? caret : undefined} />
							{/if}

							{#if steps.length > 0 || pending > 0}
								<!-- The calls, as chips, then the work they belong to as one
								     foldable trace. A lone successful read is still a single note;
								     the trace owns that rule so this panel does not repeat it.
								     Keyed by the turn, so a new question starts unfolded rather
								     than inheriting the last turn's disclosure. -->
								{#key turn?.key}
									<AssistantTrace {steps} queue={turn.queue} streaming={unfinished} />
								{/key}
							{/if}

							{#if resuming}
								<!-- The turn is still being recovered, so it is not lost: what is on
								     screen is the connection that went away, not a verdict on the agent. -->
								<p class="state waiting"><Spinner /> {waitingLine()}</p>
								{#if closeNote !== null}
									<p class="detail mono">{closeNote}</p>
								{/if}
							{:else if cutOff}
								<p class="state" data-tone="warn">{lostLine()}</p>
								{#if closeNote !== null}
									<p class="detail mono">{closeNote}</p>
								{/if}
							{/if}

							{#if turn.refusal !== null}
								<p class="state" data-tone={refusalTone(turn.refusal.reason)}>
									{agentRefusalLine(turn.refusal.reason)}
									{#if !NAMED_REFUSALS.has(turn.refusal.reason)}
										<span class="mono">reason {turn.refusal.reason}</span>
									{/if}
								</p>
								{#if turn.refusal.message !== ''}
									<p class="detail mono">{turn.refusal.message}</p>
								{/if}
							{/if}

							{#if unfinished && recovery === null && trouble !== null && linkState === 'closed'}
								<p class="state" data-tone={trouble.retryable ? 'warn' : 'danger'}>
									{agentTroubleLine(trouble)}
								</p>
								{#if trouble.detail !== null}
									<p class="detail mono">{trouble.detail}</p>
								{/if}
							{/if}

							{#if unfinished && recovery === null && trouble === null && turn.phase === null && turn.text === '' && steps.length === 0 && pending === 0 && turn.refusal === null}
								<p class="state waiting"><Spinner /> {waitingLine()}</p>
							{/if}

							{#if cutOff || (unfinished && linkState === 'closed' && trouble !== null && turn.refusal === null)}
								<div class="retry">
									<!-- The same key and the same files, so a turn the gateway already
									     started is not started again: this asks for its answer, not for
									     a second attempt. -->
									<button
										type="button"
										class="btn btn-sm"
										onclick={() => runAsk(asked, turn?.key ?? lastKey, lastIds)}
									>
										<Icon name="refresh" size={13} /> Try again
									</button>
								</div>
							{/if}

							{#if turn.proposals.length > 0}
								<p class="proposal-count mono">
									{turn.proposals.length} {turn.proposals.length === 1 ? 'proposal' : 'proposals'}
								</p>
								<ul class="proposals">
									{#each turn.proposals as proposal (proposal.id)}
										<AssistantProposalCard
											{proposal}
											result={results[proposal.id] ?? null}
											accepting={acceptingId === proposal.id}
											{stageReady}
											onaccept={() => void accept(proposal)}
											onstage={() => stage(proposal)}
										/>
									{/each}
								</ul>
							{/if}
						{:else}
							<p class="state waiting"><Spinner /> Asking the assistant…</p>
						{/if}
					{:else if asking}
						<p class="state waiting"><Spinner /> Asking the assistant…</p>
					{:else if outcome === null}
						<!-- A saved transcript above, and nothing asked yet in this one: the
						     boundary stays visible and says what the next step is. -->
						<p class="state quiet">
							{question.trim() === ''
								? 'Ask a question about this page to continue.'
								: 'Ask to send this question.'}
						</p>
					{:else if outcome.status === 'failed'}
						<p class="state" data-tone={failureTone(outcome.failure)}>
							{failureLine(outcome.failure)}
						</p>
						{#if outcome.failure.kind === 'unavailable'}
							{#if outcome.failure.detail}
								<p class="detail mono">{outcome.failure.detail}</p>
							{/if}
							<p class="state quiet">
								{#if session.canViewSecurity}
									An owner sets the model and the chat key. <a href="{BASE}/security/ai">AI settings</a>
								{:else}
									Ask an owner or admin to set the model and chat key.
								{/if}
							</p>
						{:else if outcome.failure.kind === 'exhausted' && outcome.failure.day}
							<p class="detail mono">day {outcome.failure.day}</p>
						{/if}
						<div class="retry">
							<button type="button" class="btn btn-sm" onclick={() => runAsk(asked, lastKey, lastIds)}>
								<Icon name="refresh" size={13} /> Try again
							</button>
						</div>
					{:else if outcome.status === 'plain'}
						<p class="answer">{outcome.text}</p>
					{:else}
						<AnswerText class="answer" text={outcome.answer} />
						{#if outcome.withheld.length > 0}
							<!-- A proposal the gateway refused to hand over. Saying so is the
							     difference between "the model suggested nothing" and "the model
							     suggested something the gateway would not stage". -->
							<ul class="withheld">
								{#each outcome.withheld as reason, index (index)}
									<li class="withheld-line">{reason}</li>
								{/each}
							</ul>
						{/if}
						{#if outcome.proposals.length > 0}
							<p class="proposal-count mono">
								{outcome.proposals.length}
								{outcome.proposals.length === 1 ? 'proposal' : 'proposals'}
							</p>
							<ul class="proposals">
								{#each outcome.proposals as proposal (proposal.id)}
									<AssistantProposalCard
										{proposal}
										result={results[proposal.id] ?? null}
										accepting={acceptingId === proposal.id}
										{stageReady}
										onaccept={() => void accept(proposal)}
										onstage={() => stage(proposal)}
									/>
								{/each}
							</ul>
						{/if}
					{/if}

					{#if replayed && !asking}
						<!-- The gateway answered the key it had already answered. This is a
						     fact about the request, not a second answer. -->
						<p class="state replay">
							Answered earlier from the same request — nothing ran twice.
						</p>
					{/if}

					{#if !live && outcome !== null && outcome.via === 'assistant' && outcome.status !== 'failed' && !asking}
						<!-- The stateless route answered, so the transcript and the files
						     could not have been used. One line says both, where they apply. -->
						<p class="state quiet">
							Answered without the agent runtime, so this is not added to a transcript{#if lastIds.length > 0}, and the attached {lastIds.length === 1
								? 'file was'
								: 'files were'} not read{/if}.
						</p>
					{/if}
				</section>
			{/if}
		</div>

		<section
			class="composer"
			aria-label="Your question and files"
			data-dragging={dragOver}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
		>
			<section class="files" aria-labelledby={filesId}>
				<div class="files-head">
					<h3 class="section-title" id={filesId}>Files</h3>
					<label class="attach" class:busy={uploading}>
						<input
							class="sr-only"
							type="file"
							multiple
							disabled={asking || uploading}
							onchange={pickFiles}
						/>
						{#if uploading}<Spinner />{:else}<Icon name="paperclip" size={13} />{/if}
						{uploading ? 'Uploading' : 'Attach a file'}
					</label>
				</div>
				<p class="files-note">
					Up to {ATTACHMENT_MAX_KEPT} files, {attachmentSize(ATTACHMENT_MAX_BYTES)} each, kept
					{ATTACHMENT_TTL_HOURS} hours. Drop files anywhere on this panel.
				</p>

				{#if attachmentState === 'failed'}
					<p class="state" data-tone="warn">
						The saved files could not be read. You can still attach a new one.
					</p>
				{/if}

				{#if attachments.length > 0}
					<ul class="file-chips">
						{#each attachments as file (file.id)}
							{@const expired = attachmentIsExpired(file)}
							<li class="file-chip" data-kind={file.kind} data-expired={expired}>
								<span class="file-chip-main">
									<span class="file-chip-name mono">{file.name}</span>
									<span class="file-chip-meta">
										{attachmentSize(file.bytes)} · {attachmentKindLabel(file.kind)}
									</span>
									{#if file.kind === 'image'}
										<!-- The model this deployment chats with cannot see an image. The
										     chip is named, never described as read. -->
										<span class="file-chip-note">Named only — this model cannot see images.</span>
									{:else if expired}
										<span class="file-chip-note">
											Expired — files are kept {ATTACHMENT_TTL_HOURS} hours; attach it again.
										</span>
									{/if}
								</span>
								<button
									type="button"
									class="file-chip-remove"
									aria-label={`Remove ${file.name}`}
									disabled={removingId !== null}
									onclick={() => void removeAttachment(file)}
								>
									{#if removingId === file.id}<Spinner />{:else}<Icon name="x" size={13} />{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				{#if attachmentNote !== null}
					<p class="state" data-tone={attachmentNote.tone}>{attachmentNote.text}</p>
				{/if}
			</section>

			<AssistantPromptBar
				bind:value={question}
				attachments={attachments}
				disabled={asking}
				{canAsk}
				{asking}
				{contextLabel}
				flowId={context.flowId ?? null}
				onsubmit={(text) => void runAsk(text)}
			/>
		</section>

		<footer class="panel-foot">
			<span class="foot-note">
				{#if live}
					Live agent · it can act only while an autonomy window is open.
				{:else if historyState === 'failed'}
					No transcript on this deployment. Files are removed after {ATTACHMENT_TTL_HOURS} hours.
				{:else}
					The transcript is saved on this gateway. Files are removed after
					{ATTACHMENT_TTL_HOURS} hours.
				{/if}
			</span>
		</footer>
	</section>
{/if}

<style>
	/* ---- the panel ----
	   The launcher is a header action (see `+layout.svelte`), so this surface hangs
	   from the console's chrome instead of standing on the page: it opens below the
	   header and the phone's tab strip, aligned to the same inline padding as the
	   button that opened it, and it is not in the document at all while closed. No
	   scrim and no focus trap in this presentation: the page behind stays usable,
	   which is what "not a modal" means here. One column, header to footer, and
	   never wider than the phone it is on. */
	.panel {
		position: fixed;
		top: calc(var(--df-c-shell-header) + var(--df-c-shell-tabs) + var(--df-p-space-2));
		right: var(--df-c-topbar-pad);
		z-index: 70;
		display: flex;
		flex-direction: column;
		width: min(420px, calc(100vw - (2 * var(--df-c-topbar-pad))));
		max-height: min(
			82dvh,
			calc(
				100dvh - var(--df-c-shell-header) - var(--df-c-shell-tabs) - var(--df-p-space-5)
			)
		);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		overflow: hidden;
	}

	/* ---- the expanded presentation ----
	   The same panel, with the room to read. Nothing is added: the header, the
	   transcript, the files, the composer and the footer are the same elements on
	   the same tokens and the same 4px corners. Two things change.

	   The type grows one step, to the console's own 15px reading size. The floating
	   panel answers at 12px because it is a pane in a corner; a surface the size of
	   the screen with 12px prose in it is a mock-up of a reading view, not one. The
	   step is the console's, not a new one, and `AnswerText` is handed it through
	   the one custom property it reads.

	   The measure stays at ~68 characters. The sheet can be as wide as the screen
	   allows and the words never follow it: the reading column is capped and
	   centred, so a long answer is read at the width an answer wants. The hairlines
	   and the footer keep the sheet's own width, because they are chrome, not text. */
	.panel[data-presentation='fullscreen'] {
		--df-md-font-size: var(--df-p-text-md);
	}

	.panel[data-presentation='fullscreen'] .head-row,
	.panel[data-presentation='fullscreen'] .foot-note {
		width: 100%;
		max-width: 68ch;
		margin-inline: auto;
	}

	.panel[data-presentation='fullscreen'] .body,
	.panel[data-presentation='fullscreen'] .composer {
		width: 100%;
		/* The measure plus the box's own 12px of inline padding, so the words — not
		   the padding — land on the same edge as the header and the footer. */
		max-width: calc(68ch + 24px);
		margin-inline: auto;
	}

	.panel[data-presentation='fullscreen'] .foot-note {
		display: block;
	}

	.panel[data-presentation='fullscreen'] .message-text,
	.panel[data-presentation='fullscreen'] .turn-question,
	.panel[data-presentation='fullscreen'] .answer {
		font-size: var(--df-p-text-md);
		line-height: 1.6;
	}

	.panel[data-presentation='fullscreen'] .section-title,
	.panel[data-presentation='fullscreen'] .message-who {
		font-size: var(--df-p-text-sm);
	}

	.panel-head {
		padding: 10px 12px 9px;
		border-bottom: 1px solid var(--df-border-hairline);
	}

	/* The header's contents sit in the reading column when the panel is expanded,
	   while the hairline under them keeps the sheet's width. */
	.head-row {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex: none;
		margin-left: auto;
		margin-top: -3px;
		margin-right: -3px;
	}

	.head-copy {
		min-width: 0;
	}

	.title-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.panel-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-sm);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	/* A word, not a badge: mono on a hairline, and the ink says which state. */
	.link-chip {
		padding: 0 4px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.08em;
		line-height: 1.5;
		text-transform: uppercase;
	}

	.link-chip[data-state='open'] {
		color: var(--df-state-ok-ink);
	}

	.link-chip[data-state='ticket'],
	.link-chip[data-state='connecting'],
	.link-chip[data-state='retrying'],
	.link-chip[data-state='asking'] {
		color: var(--df-state-warn-ink);
	}

	.link-chip[data-state='closed'] {
		color: var(--df-state-danger-ink);
	}

	.context {
		margin-top: 2px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	/* The header's two controls: the presentation and the close. Both are the same
	   quiet plate, so the pair reads as one group, and neither is coral — colour is
	   for the one action, not for chrome. */
	.head-action {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
	}

	@media (hover: hover) and (pointer: fine) {
		.head-action:hover {
			background: var(--df-surface-well);
			color: var(--df-text-primary);
		}
	}

	/* The transcript and the current turn. One scroll region, so the header, the
	   files and the composer stay put while a long history moves. */
	.body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-height: 0;
		flex: 1 1 auto;
		padding: 12px;
		overflow-y: auto;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 24px;
	}

	/* Section headings are mono labels, not headlines: the panel title is the one
	   heading with weight, and the cards sit under it at h4. */
	.section-title {
		margin: 0;
		color: var(--df-text-meta);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		line-height: 1.4;
		text-transform: uppercase;
	}

	.section-meta {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
	}

	.clear {
		flex: none;
		margin-left: auto;
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
	}

	@media (hover: hover) and (pointer: fine) {
		.clear:hover {
			background: var(--df-surface-well);
			color: var(--df-text-primary);
		}
	}

	.clear-confirm {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 9px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
	}

	.clear-say {
		margin: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}

	.clear-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.history-note {
		margin: 6px 0 0;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}

	.messages {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
	}

	/* The operator's own words take a hairline on the left; the answer stays flat.
	   No avatar, no bubble, no tint: the rail is the only mark of who spoke. */
	.message {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-left: 8px;
		border-left: 2px solid transparent;
	}

	.message[data-role='user'] {
		border-left-color: var(--df-border-strong);
	}

	.message[data-role='assistant'] {
		padding-left: 0;
		border-left: 0;
	}

	.message-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.message-who {
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
	}

	.message[data-role='assistant'] .message-who {
		color: var(--df-text-meta);
	}

	.message-time {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
	}

	.message-text {
		margin: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.55;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	/* The boundary between what already happened and this question. A rule and a
	   label, not a card: the turn is the same exchange, continued. */
	.turn {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--df-border-control);
	}

	.turn-question {
		margin: 0;
		padding-left: 8px;
		border-left: 2px solid var(--df-border-strong);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.state {
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.state.quiet {
		color: var(--df-text-meta);
	}

	.state.waiting {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--df-text-secondary);
	}

	/* The server's own progress, one line: a small moving mark for liveness and
	   the phase in the console's quiet ink. It never grows into a transcript. */
	.state.phase {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
	}

	.state.replay {
		padding-left: 8px;
		border-left: 2px solid var(--df-state-ok-ink);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
	}

	.state[data-tone='danger'] {
		color: var(--df-state-danger-ink);
	}

	.state[data-tone='warn'] {
		color: var(--df-state-warn-ink);
	}

	.detail {
		margin-top: -4px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	/* The provider's line breaks are its own: an answer shaped like a list stays
	   a list, and nothing is reflowed into a paragraph. */
	.answer {
		margin: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.55;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	/* One thin block, blinking: the only motion the panel adds, and it disappears
	   the moment the answer is complete or the motion is unwelcome. */
	.caret {
		display: inline-block;
		width: 2px;
		height: 1em;
		margin-left: 2px;
		vertical-align: -0.15em;
		background: var(--df-accent-text);
		animation: caret-blink 1s steps(2, start) infinite;
	}

	@keyframes caret-blink {
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
		}
	}

	/* The plan line's counter: the batch the gateway announced, in mono so it reads
	   as a position rather than as prose. */
	.phase-count {
		color: var(--df-text-meta);
		font-family: var(--df-font-mono);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
	}

	.retry {
		margin-top: 2px;
	}

	.proposals {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 2px 0 0;
		padding: 0;
		list-style: none;
	}

	/* ---- files ---- */

	.composer {
		flex: none;
		border-top: 1px solid var(--df-border-hairline);
		transition: background-color 140ms ease;
	}

	/* The drop target is the whole lower panel; the dashed edge says so only while
	   a file is actually over it. No shadow, no tint beyond the well. */
	.composer[data-dragging='true'] {
		background: var(--df-surface-well);
		outline: 1px dashed var(--df-border-strong);
		outline-offset: -4px;
	}

	.files {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 9px 12px 0;
	}

	.files-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.files-note {
		margin: 0;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}

	/* A file control that looks like the console's quiet button. The real input is
	   the control, so Tab reaches it and its label names it; the ring is drawn on
	   the label, where the operator can see it. */
	.attach {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		flex: none;
		margin-left: auto;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
	}

	.attach:has(input:focus-visible) {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.attach.busy {
		color: var(--df-text-meta);
	}

	.attach:has(input:disabled) {
		color: var(--df-text-meta);
		background: var(--df-surface-well);
		border-color: var(--df-border-hairline);
		cursor: not-allowed;
	}

	.file-chips {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 4px 0 0;
		padding: 0;
		list-style: none;
	}

	.file-chip {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 5px 5px 5px 8px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
	}

	.file-chip[data-expired='true'] {
		border-color: color-mix(in srgb, var(--df-state-warn-ink) 40%, var(--df-border-hairline));
	}

	.file-chip-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1 1 auto;
	}

	.file-chip-name {
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.file-chip-meta {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
	}

	.file-chip-note {
		color: var(--df-state-warn-ink);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.file-chip-remove {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
	}

	@media (hover: hover) and (pointer: fine) {
		.file-chip-remove:hover {
			background: var(--df-surface-card);
			color: var(--df-text-primary);
		}
	}

	.panel-foot {
		flex: none;
		padding: 7px 12px;
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.foot-note {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
	}

	.withheld {
		margin: var(--df-p-space-2) 0 0;
		padding: 0 0 0 var(--df-p-space-3);
		list-style: none;
		border-left: 2px solid var(--df-state-warn-ink);
	}

	.withheld-line {
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}

	/* ---- touch and the small phone ---- */

	/* At 390 the panel is nearly the whole screen: every control inside it takes
	   the console's 44 px floor, and every field 16 px so iOS does not zoom. */
	@media (max-width: 720px), (pointer: coarse) {
		.panel .btn,
		.clear,
		.attach {
			min-height: 44px;
		}

		.attach {
			padding-inline: 12px;
		}

		.file-chip {
			padding-block: 6px;
		}

		.file-chip-remove {
			width: 44px;
			height: 44px;
		}

		/* Two controls in the header, both 44: the presentation toggle sits beside
		   the close, so both need the floor or the pair reads as one big and one
		   small. The negative offsets live on the group so the pair keeps its
		   optical alignment with the title's 12px edge. */
		.head-action {
			width: 44px;
			height: 44px;
		}

		/* A four-corner frame needs more room than a close glyph to carry the same
		   weight — its ink fills its box, an X's fills half of one — so it takes the
		   target's extra 16px and stays a frame rather than four stray ticks. */
		:global(.presentation svg) {
			width: 20px;
			height: 20px;
		}

		.head-actions {
			margin-top: -8px;
			margin-right: -8px;
		}

		.messages {
			gap: 12px;
		}
	}

	/* Expanded on a phone the panel *is* the screen: no gutter to the page, no
	   corners to see round, and the notch and the home indicator kept clear. It is
	   a dialog here — the component reads the same 720px line — so it may look like
	   one. */
	@media (max-width: 720px) {
		.panel[data-presentation='fullscreen'] {
			inset: 0;
			width: auto;
			max-width: none;
			height: 100dvh;
			max-height: none;
			border-radius: 0;
			padding-top: env(safe-area-inset-top, 0px);
			padding-left: env(safe-area-inset-left, 0px);
			padding-right: env(safe-area-inset-right, 0px);
		}

		/* The footer is the last strip, so the safe-area floor is paid for there
		   rather than under it, where it would show as a band of card colour. */
		.panel[data-presentation='fullscreen'] .panel-foot {
			padding-bottom: calc(7px + env(safe-area-inset-bottom, 0px));
		}

		/* Expanded, the panel is the whole screen and there is no card edge above
		   the title to give the header its air, so the header keeps a little more
		   of its own. */
		.panel[data-presentation='fullscreen'] .panel-head {
			padding-top: 14px;
		}
	}

	/* Expanded on a screen that has room for a sheet: a large surface with the
	   page still visible and still live around it, which is why it stays a region
	   and not a dialog. 880px of sheet around a 68ch measure is a deliberate
	   proportion, not a leftover: the prose is read at the width it wants and the
	   surface is big enough to feel like a change of room. */
	@media (min-width: 721px) {
		.panel[data-presentation='fullscreen'] {
			top: 24px;
			right: 24px;
			bottom: 24px;
			left: 24px;
			width: auto;
			max-width: 880px;
			height: auto;
			max-height: none;
			margin-inline: auto;
		}

		.panel[data-presentation='fullscreen'] .panel-head {
			padding-top: 12px;
			padding-bottom: 10px;
		}

		.panel[data-presentation='fullscreen'] .body {
			padding-block: 16px;
		}

		/* The field follows the prose up a step: a 12px field under 15px text
		   reads as a broken control. Only past 720px — under it the 16px guard that
		   keeps iOS from zooming owns this, and it must win. */
		.panel[data-presentation='fullscreen'] :global(.ask-input),
		.panel[data-presentation='fullscreen'] :global(.ask-send) {
			font-size: var(--df-p-text-md);
		}
	}

	@media (max-width: 420px) {
		.panel {
			/* The header's own 12px inset is already the phone's gutter, so the
			   panel keeps the same edge as the button that opened it. */
			max-height: min(86dvh, calc(100dvh - var(--df-c-shell-header) - var(--df-p-space-5)));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.composer {
			transition: none;
		}
	}
</style>
