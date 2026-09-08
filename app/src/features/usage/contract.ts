/** Claude Code's usage figures: reading them, and how the reading stands. */
import { event, invoke } from "../../bridge/contract.js";
import type { StatusSnapshot } from "../../core/types.js";

/** How the figures are being kept current — the answer to "why are the gauges blank", or "how old is this". */
export interface UsageState {
  /** When the figures were last read, in epoch ms; null when they never were. */
  updatedAt: number | null;
  /** Claude Code's login as the endpoint sees it: a token to send, one that ran out, or none (an API key, or nobody signed in). */
  login: "fresh" | "expired" | "absent";
  /** How the last request to the endpoint was refused, until one succeeds. */
  endpointFailure: "stale-token" | "rate-limited" | "error" | null;
}

export const usageContract = {
  /** The usage windows as last read, filtered to the ones the settings show. */
  status: invoke<void, StatusSnapshot>("status:read"),
  /** Fresh figures arrived from the usage endpoint between two polls. */
  onStatus: event<StatusSnapshot>("status:push"),
  /** Ask the endpoint now — the user double-clicked a gauge — and answer with the figures it gave. */
  refreshUsage: invoke<void, StatusSnapshot>("status:refresh"),
} as const;
