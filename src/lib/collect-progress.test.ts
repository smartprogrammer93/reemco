import { describe, expect, it } from "vitest";
import { isJobSettled, jobProgress } from "@/lib/collect-progress";
import type { CollectJob, RetailerSubtask } from "@/lib/collect/types";

function job(subtasks: RetailerSubtask[], status: CollectJob["status"] = "collecting"): CollectJob {
  return {
    jobId: "j1",
    productId: "p1",
    status,
    mode: "live",
    startedAt: new Date().toISOString(),
    subtasks,
    offers: [],
  };
}

describe("jobProgress (plan AC2: real states only)", () => {
  it("is 0 with no subtasks", () => {
    expect(jobProgress(job([]))).toBe(0);
  });

  it("counts only resolved subtasks (done/failed/timeout)", () => {
    const j = job([
      { retailer: "a", domain: "a", status: "done", offersFound: 2 },
      { retailer: "b", domain: "b", status: "collecting", offersFound: 0 },
      { retailer: "c", domain: "c", status: "pending", offersFound: 0 },
    ]);
    expect(jobProgress(j)).toBeCloseTo(1 / 3);
  });

  it("is 1 when every retailer is done/failed/timeout", () => {
    const j = job([
      { retailer: "a", domain: "a", status: "done", offersFound: 2 },
      { retailer: "b", domain: "b", status: "failed", offersFound: 0, error: "blocked" },
      { retailer: "c", domain: "c", status: "timeout", offersFound: 0 },
    ]);
    expect(jobProgress(j)).toBe(1);
  });
});

describe("isJobSettled", () => {
  it("false while any subtask is pending/collecting", () => {
    expect(
      isJobSettled(
        job([
          { retailer: "a", domain: "a", status: "done", offersFound: 1 },
          { retailer: "b", domain: "b", status: "collecting", offersFound: 0 },
        ]),
      ),
    ).toBe(false);
  });

  it("true when all subtasks terminal or job status not collecting", () => {
    expect(
      isJobSettled(
        job([
          { retailer: "a", domain: "a", status: "done", offersFound: 1 },
          { retailer: "b", domain: "b", status: "timeout", offersFound: 0 },
        ]),
      ),
    ).toBe(true);
    expect(
      isJobSettled(job([{ retailer: "a", domain: "a", status: "collecting", offersFound: 0 }], "failed")),
    ).toBe(true);
  });
});
