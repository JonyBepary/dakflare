/**
 * The one thing the assistant's launcher and its panel have to agree on.
 *
 * The launcher is a header action, beside the keyboard, theme and sign-out
 * controls: it holds a row of chrome, so it can never sit over a table's actions
 * or a page's last row. The panel is the surface the launcher opens, and it is
 * still a pane the page can outlive. They are therefore rendered by two
 * components in two places in the shell, and this is the small state between
 * them:
 *
 *  - `toggle` is registered by the panel, so the header button opens exactly the
 *    panel that owns the transcript, the socket and the focus behaviour. Calling
 *    it while the panel is unmounted does nothing.
 *  - `open` and `expanded` are read by the launcher, because the control that
 *    opens a surface has to say whether it is open (`aria-expanded`) and has to
 *    describe the way back (`Ask the assistant` / `Close the assistant`).
 *  - `panelId` lets the launcher name the surface it controls without widening
 *    the panel's props: the id is the panel's own, generated with `$props.id()`.
 *  - `launcherId` is the other direction: Escape and the close button put focus
 *    back on the control that opened the panel, which is a header button this
 *    time and not a floating pill in the corner.
 *
 * One launcher, one panel. The launcher is never hidden by width, only while the
 * panel owns the screen, and that is a `visibility` switch rather than a second
 * copy of the button: two Ask buttons would be two things to keep in step.
 */

export type AssistantDock = {
	open: boolean;
	expanded: boolean;
	panelId: string;
	launcherId: string;
	toggle: () => void;
};

export const assistantDock = $state<AssistantDock>({
	open: false,
	expanded: false,
	panelId: '',
	launcherId: 'assistant-launcher',
	toggle: () => {}
});
