import { describe, expect, it, vi } from "vitest";
import { RETENTION, retentionCutoffs, runRetention, type RetentionDependencies } from "./maintenance/retention.js";

const now = new Date("2026-11-01T12:00:00.000Z");
const daysBefore = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("retention cutoffs", () => {
  it("match the agreed periods", () => {
    const cutoffs = retentionCutoffs(now);
    expect(cutoffs.inquiriesBefore.toISOString()).toBe(daysBefore(730));
    expect(cutoffs.emailBodiesBefore.toISOString()).toBe(daysBefore(90));
    expect(cutoffs.auditEventsBefore.toISOString()).toBe(daysBefore(730));
    expect(cutoffs.channelClicksBefore.toISOString()).toBe(daysBefore(395));
    expect(cutoffs.cacheRevalidationsBefore.toISOString()).toBe(daysBefore(30));
    expect(cutoffs.sessionsExpiredBefore).toEqual(now);
    expect(RETENTION.inquiriesDays).toBe(730);
  });
});

function fakeDependencies(overrides: Partial<RetentionDependencies> = {}): RetentionDependencies {
  return {
    deleteInquiries: vi.fn(async () => 2),
    scrubEmailBodies: vi.fn(async () => 5),
    deleteAuditEvents: vi.fn(async () => 0),
    deleteChannelClicks: vi.fn(async () => 1),
    deleteCacheRevalidations: vi.fn(async () => 3),
    deleteExpiredSessions: vi.fn(async () => 4),
    ...overrides,
  };
}

describe("runRetention", () => {
  it("runs every step with its own cutoff and reports the counts", async () => {
    const dependencies = fakeDependencies();
    const counts = await runRetention(now, dependencies);
    expect(counts).toEqual({ inquiriesDeleted: 2, emailBodiesScrubbed: 5, auditEventsDeleted: 0, channelClicksDeleted: 1, cacheRevalidationsDeleted: 3, sessionsDeleted: 4 });
    expect(dependencies.deleteInquiries).toHaveBeenCalledWith(new Date(daysBefore(730)));
    expect(dependencies.scrubEmailBodies).toHaveBeenCalledWith(new Date(daysBefore(90)));
  });

  it("keeps going when one step fails, and marks it", async () => {
    const logger = { error: vi.fn() } as never;
    const dependencies = fakeDependencies({ scrubEmailBodies: vi.fn(async () => { throw new Error("database busy"); }) });
    const counts = await runRetention(now, dependencies, logger);
    expect(counts.emailBodiesScrubbed).toBe(-1);
    expect(counts.sessionsDeleted).toBe(4);
  });
});
