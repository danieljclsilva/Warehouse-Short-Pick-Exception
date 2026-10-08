import { describe, expect, it, vi } from "vitest";
import { createVisibilityPoller, type VisibilityPollerEnv } from "@/components/use-visibility-polling";

type Listener = () => void;

function createFakeEnv() {
  const state = { online: true, visible: true };
  const windowListeners: Record<string, Listener[]> = {};
  const documentListeners: Record<string, Listener[]> = {};
  const intervalCallbacks: Listener[] = [];
  const timeoutCallbacks: Listener[] = [];
  let added = 0;
  let removed = 0;

  const on = (store: Record<string, Listener[]>) => (type: string, listener: Listener) => {
    const list = store[type] ?? [];
    list.push(listener);
    store[type] = list;
    added += 1;
  };
  const off = (store: Record<string, Listener[]>) => (type: string, listener: Listener) => {
    const list = store[type] ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
      removed += 1;
    }
  };
  const emit = (store: Record<string, Listener[]>) => (type: string) => {
    for (const listener of [...(store[type] ?? [])]) listener();
  };

  const env: VisibilityPollerEnv = {
    isOnline: () => state.online,
    isVisible: () => state.visible,
    setInterval: (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length - 1;
    },
    clearInterval: (id) => {
      intervalCallbacks[id] = () => {};
    },
    setTimeout: (callback) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length - 1;
    },
    clearTimeout: (id) => {
      timeoutCallbacks[id] = () => {};
    },
    addWindowListener: on(windowListeners),
    removeWindowListener: off(windowListeners),
    addDocumentListener: on(documentListeners),
    removeDocumentListener: off(documentListeners),
  };

  return {
    state,
    env,
    added: () => added,
    removed: () => removed,
    fireIntervals: () => {
      for (const callback of [...intervalCallbacks]) callback();
    },
    fireTimeouts: () => {
      for (const callback of [...timeoutCallbacks]) callback();
    },
    emitWindow: emit(windowListeners),
    emitDocument: emit(documentListeners),
  };
}

type PollFn = { mock: { results: Array<{ value: unknown }> } };

/** Drain pending microtasks only — no wall-clock waits. */
async function drain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settle(poll: PollFn) {
  await drain();
  await Promise.all(poll.mock.results.map((result) => result.value));
  await drain();
}

describe("createVisibilityPoller", () => {
  it("polls immediately on start and on every interval tick while visible and online", async () => {
    const fake = createFakeEnv();
    const poll = vi.fn(async () => {});
    const poller = createVisibilityPoller(poll, 10_000, fake.env);
    poller.start();
    fake.fireTimeouts();
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(1);
    fake.fireIntervals();
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("skips ticks while the tab is hidden and refetches promptly on return", async () => {
    const fake = createFakeEnv();
    const poll = vi.fn(async () => {});
    const poller = createVisibilityPoller(poll, 10_000, fake.env, { immediate: false });
    poller.start();
    fake.state.visible = false;
    fake.fireIntervals();
    await drain();
    expect(poll).not.toHaveBeenCalled();
    fake.state.visible = true;
    fake.emitDocument("visibilitychange");
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("pauses while offline and refetches on reconnect", async () => {
    const fake = createFakeEnv();
    const poll = vi.fn(async () => {});
    const poller = createVisibilityPoller(poll, 10_000, fake.env, { immediate: false });
    poller.start();
    fake.state.online = false;
    fake.fireIntervals();
    await drain();
    expect(poll).not.toHaveBeenCalled();
    fake.state.online = true;
    fake.emitWindow("online");
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("never runs overlapping requests", async () => {
    const fake = createFakeEnv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poll = vi.fn(async () => {
      await gate;
    });
    const poller = createVisibilityPoller(poll, 10_000, fake.env, { immediate: false });
    poller.start();
    fake.fireIntervals();
    fake.fireIntervals();
    await drain();
    expect(poll).toHaveBeenCalledTimes(1);
    release();
    await (poll.mock.results[0]?.value as Promise<void>);
    await drain();
    fake.fireIntervals();
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stops every timer and listener so nothing fires after unmount", async () => {
    const fake = createFakeEnv();
    const poll = vi.fn(async () => {});
    const poller = createVisibilityPoller(poll, 10_000, fake.env, { immediate: false });
    poller.start();
    expect(fake.added()).toBe(2);
    poller.stop();
    expect(fake.removed()).toBe(2);
    await expect(poller.run()).resolves.toBe(false);
    fake.fireIntervals();
    fake.fireTimeouts();
    fake.emitWindow("online");
    fake.emitDocument("visibilitychange");
    await drain();
    expect(poll).not.toHaveBeenCalled();
  });

  it("ignores a second start while already running", async () => {
    const fake = createFakeEnv();
    const poll = vi.fn(async () => {});
    const poller = createVisibilityPoller(poll, 10_000, fake.env, { immediate: false });
    poller.start();
    poller.start();
    fake.fireIntervals();
    await settle(poll);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(fake.added()).toBe(2);
    poller.stop();
  });
});
