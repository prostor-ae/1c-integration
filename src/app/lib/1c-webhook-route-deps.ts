import { processOneCWebhookItems } from "./1c-webhook";
import {
  acquireSyncLock,
  getSyncAdmissionBlocker,
  releaseSyncLock,
} from "./sync-state";

export type OneCWebhookRouteDeps = {
  acquireLock: typeof acquireSyncLock;
  releaseLock: typeof releaseSyncLock;
  getAdmissionBlocker: typeof getSyncAdmissionBlocker;
  processItems: typeof processOneCWebhookItems;
  createMutationSignal: () => AbortSignal;
};

// The shared sync lock lasts 300 seconds. Realtime reads, retries, and writes
// are aborted at 240 seconds, preserving a full 60-second release margin.
export const ONE_C_STATUS_MUTATION_DEADLINE_MS = 240_000;

const defaults: OneCWebhookRouteDeps = {
  acquireLock: acquireSyncLock,
  releaseLock: releaseSyncLock,
  getAdmissionBlocker: getSyncAdmissionBlocker,
  processItems: processOneCWebhookItems,
  createMutationSignal: () =>
    AbortSignal.timeout(ONE_C_STATUS_MUTATION_DEADLINE_MS),
};
let current = defaults;

export function oneCWebhookRouteDeps() {
  return current;
}

export function setOneCWebhookRouteDepsForTests(
  overrides: Partial<OneCWebhookRouteDeps> | null,
) {
  current = overrides ? { ...defaults, ...overrides } : defaults;
}
