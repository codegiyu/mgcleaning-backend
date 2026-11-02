import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyProducerConnection, whenRedisReady } from "../queue/redis.js";

/** Stands in for an ioredis client: a status plus the connection events. */
class FakeClient extends EventEmitter {
  constructor(public status: string) {
    super();
  }
  quit = vi.fn(async () => "OK");
  connect(after: "ready" | "error" | "end") {
    if (after === "ready") {
      this.status = "ready";
      this.emit("ready");
    } else if (after === "error") {
      this.emit("error", new Error("connect ECONNREFUSED"));
    } else {
      this.status = "end";
      this.emit("end");
    }
  }
}

const asRedis = (client: FakeClient) => client as unknown as Redis; // Only status and events are used.

afterEach(() => {
  vi.useRealTimers();
});

describe("whenRedisReady", () => {
  it("resolves at once for a ready connection", async () => {
    await expect(whenRedisReady(asRedis(new FakeClient("ready")))).resolves.toBeUndefined();
  });

  it("waits for a connection that is still opening (the first request after a restart)", async () => {
    const client = new FakeClient("connecting");
    const ready = whenRedisReady(asRedis(client));
    client.connect("ready");
    await expect(ready).resolves.toBeUndefined();
    expect(client.listenerCount("ready") + client.listenerCount("error") + client.listenerCount("end")).toBe(0);
  });

  it("fails fast when the connection errors or ends", async () => {
    const failing = new FakeClient("connecting");
    const errored = whenRedisReady(asRedis(failing));
    failing.connect("error");
    await expect(errored).rejects.toThrow("ECONNREFUSED");

    const ending = new FakeClient("reconnecting");
    const ended = whenRedisReady(asRedis(ending));
    ending.connect("end");
    await expect(ended).rejects.toThrow("closed");

    await expect(whenRedisReady(asRedis(new FakeClient("end")))).rejects.toThrow("closed");
  });

  it("gives up after the timeout so requests never hang", async () => {
    vi.useFakeTimers();
    const client = new FakeClient("connecting");
    const pending = whenRedisReady(asRedis(client), 2_000);
    const assertion = expect(pending).rejects.toThrow("not ready within 2000 ms");
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(client.listenerCount("ready")).toBe(0);
  });
});

describe("lazyProducerConnection", () => {
  it("opens one connection on first use and shares it, waiting until it is ready", async () => {
    const client = new FakeClient("connecting");
    const create = vi.fn(() => asRedis(client));
    const connection = lazyProducerConnection(create);
    const first = connection.get();
    const second = connection.get();
    client.connect("ready");
    await expect(Promise.all([first, second])).resolves.toEqual([client, client]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("closes the connection and opens a fresh one afterwards", async () => {
    const clients = [new FakeClient("ready"), new FakeClient("ready")];
    const connection = lazyProducerConnection(() => asRedis(clients.shift()!));
    const original = await connection.get();
    await connection.close();
    expect((original as unknown as FakeClient).quit).toHaveBeenCalledTimes(1);
    expect(await connection.get()).not.toBe(original);
  });
});
