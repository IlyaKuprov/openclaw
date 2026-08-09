import type { ChatAbortControllerEntry } from "./chat-abort.js";

const terminalPersistenceErrorByEntry = new WeakMap<ChatAbortControllerEntry, unknown>();
const removalWaitersByEntry = new WeakMap<ChatAbortControllerEntry, Set<() => void>>();

export function markChatAbortTerminalPersistenceError(
  entry: ChatAbortControllerEntry,
  error: unknown,
): void {
  if (error === undefined) {
    terminalPersistenceErrorByEntry.delete(entry);
    return;
  }
  terminalPersistenceErrorByEntry.set(entry, error);
}

export function notifyChatAbortControllerRemoved(entry: ChatAbortControllerEntry): void {
  const waiters = removalWaitersByEntry.get(entry);
  removalWaitersByEntry.delete(entry);
  for (const resolve of waiters ?? []) {
    resolve();
  }
}

/** Waits for captured run registrations and their terminal persistence owner to leave. */
export async function waitForChatAbortControllerRemoval(params: {
  entries: Map<string, ChatAbortControllerEntry>;
  targets: ReadonlyArray<{ runId: string; entry: ChatAbortControllerEntry }>;
  timeoutMs: number;
}): Promise<boolean> {
  const registeredWaiters: Array<{ entry: ChatAbortControllerEntry; resolve: () => void }> = [];
  const removals = params.targets.flatMap(({ runId, entry }) => {
    if (params.entries.get(runId) !== entry) {
      return [];
    }
    return [
      new Promise<void>((resolve) => {
        const waiters = removalWaitersByEntry.get(entry) ?? new Set<() => void>();
        waiters.add(resolve);
        removalWaitersByEntry.set(entry, waiters);
        registeredWaiters.push({ entry, resolve });
      }),
    ];
  });
  if (removals.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const removed = await Promise.race([
      Promise.all(removals).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, params.timeoutMs));
        timer.unref?.();
      }),
    ]);
    return (
      removed && params.targets.every(({ entry }) => !terminalPersistenceErrorByEntry.has(entry))
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    for (const { entry, resolve } of registeredWaiters) {
      const waiters = removalWaitersByEntry.get(entry);
      waiters?.delete(resolve);
      if (waiters?.size === 0) {
        removalWaitersByEntry.delete(entry);
      }
    }
  }
}
