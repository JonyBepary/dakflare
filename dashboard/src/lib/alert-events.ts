/**
 * The alert banner and the Overview summary read the same fact from different
 * endpoints. This event keeps the health block's `open_alerts` count in step
 * with an acknowledgement without making either page poll the other.
 */
export const ALERTS_CHANGED_EVENT = 'dakflare:alerts-changed';
