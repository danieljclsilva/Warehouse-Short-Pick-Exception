import { describe, expect, it } from "vitest";
import {
  applyReplicaCounts,
  buildSnapshot,
  unwrapData,
} from "../scripts/railway-test-env-state.mjs";
import {
  REMOVABLE_STATUSES,
  SERVICE_IDS,
  TEST_ENV_ID,
  classifyDeployment,
  computeStopSet,
  isParked,
} from "../scripts/railway-test-env-guard.mjs";

const WEB = "fd533f19-cbed-4023-96e6-463dd299815e";
const DB = "c44519a3-f013-4d49-a62b-7ca3bd61c4ff";
const PUSH = "d528d77e-fd99-4cd2-8c58-e9c4680e7587";

function parkedInstance(overrides = {}) {
  return {
    serviceName: "web-test",
    region: "us-west2",
    numReplicas: null,
    source: { image: null, repo: "example/web-repo" },
    startCommand: "npm start",
    latestDeployment: {
      id: "a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da",
      status: "CRASHED",
      deploymentStopped: true,
      canRedeploy: true,
    },
    activeDeployments: [
      {
        id: "a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da",
        status: "CRASHED",
        deploymentStopped: true,
      },
    ],
    ...overrides,
  };
}

describe("railway test-env state helper (pure)", () => {
  it("builds the parked web snapshot from live-shaped stopped inputs", () => {
    const snap = buildSnapshot("web", WEB, parkedInstance(), [
      {
        id: "a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da",
        status: "CRASHED",
        deploymentStopped: true,
      },
    ]);
    expect(snap.serviceId).toBe(WEB);
    expect(snap.latest).toMatchObject({ status: "CRASHED", deploymentStopped: true });
    expect(snap.pending).toEqual([]);
    // Replica counts come only from the service-list merge, not the builder.
    expect(snap.running).toBe(0);
    const merged = applyReplicaCounts(snap, {
      id: WEB,
      replicas: { configured: 1, running: 0, crashed: 0 },
    });
    expect(merged.parked).toBe(true);
    expect(isParked(merged)).toBe(true);
  });

  it("keeps push source-less (latest null, retained startCommand) parked", () => {
    const snap = buildSnapshot(
      "push",
      PUSH,
      {
        serviceName: "push-delivery",
        numReplicas: null,
        source: null,
        startCommand: "npm run push:worker",
        latestDeployment: null,
        activeDeployments: [],
      },
      [],
    );
    expect(snap.latest).toBeNull();
    expect(snap.active).toEqual([]);
    expect(snap.pending).toEqual([]);
    expect(isParked(snap)).toBe(true);
    expect(computeStopSet(snap)).toEqual({ stop: [], unknown: [] });
  });

  it("merges deployments-list nodes the instance payload omits", () => {
    const snap = buildSnapshot("web", WEB, parkedInstance({ activeDeployments: [] }), [
      {
        id: "extra-build",
        status: "BUILDING",
        deploymentStopped: false,
        serviceId: WEB,
        environmentId: TEST_ENV_ID,
      },
    ]);
    expect(snap.active.map((d) => d.id)).toContain("extra-build");
    expect(snap.pending).toEqual([{ id: "extra-build", status: "BUILDING" }]);
    expect(
      isParked(
        applyReplicaCounts(snap, { id: WEB, replicas: { configured: 1, running: 1, crashed: 0 } }),
      ),
    ).toBe(false);
    const plan = computeStopSet(snap);
    expect(plan.stop).toContain("extra-build");
    expect(plan.unknown).toEqual([]);
  });

  it("marks multi active+pending sets unparked with a full stop set", () => {
    const snap = buildSnapshot(
      "web",
      WEB,
      {
        ...parkedInstance(),
        latestDeployment: { id: "live-1", status: "SUCCESS", deploymentStopped: false },
        activeDeployments: [
          { id: "live-1", status: "SUCCESS", deploymentStopped: false },
          { id: "live-2", status: "DEPLOYING", deploymentStopped: false },
          { id: "old", status: "CRASHED", deploymentStopped: true },
        ],
      },
      [{ id: "live-1", status: "SUCCESS", deploymentStopped: false }],
    );
    expect(snap.pending).toEqual([{ id: "live-2", status: "DEPLOYING" }]);
    expect(isParked(snap)).toBe(false);
    const plan = computeStopSet(snap);
    expect(plan.stop).toEqual(expect.arrayContaining(["live-1", "live-2"]));
    expect(plan.stop).not.toContain("old");
  });
  it("drops deployments-list nodes from another env/service (shared push id)", () => {
    const snap = buildSnapshot(
      "push",
      PUSH,
      {
        ...parkedInstance(),
        latestDeployment: null,
        activeDeployments: [],
      },
      [
        { id: "prod-node", status: "SUCCESS", deploymentStopped: false, serviceId: PUSH, environmentId: "eb369535-cde7-445d-90f3-baeab196e88c" },
        { id: "test-node", status: "SUCCESS", deploymentStopped: false, serviceId: PUSH, environmentId: TEST_ENV_ID },
      ],
    );
    expect(snap.active.map((d) => d.id)).toEqual(["test-node"]);
    expect(isParked(snap)).toBe(false);
  });

  it("maps null numReplicas (live Int-or-null) to zeroed replica counts", () => {
    const snap = buildSnapshot("db", DB, parkedInstance(), []);
    expect(applyReplicaCounts(snap, { id: DB })).toMatchObject({
      running: 0,
      configured: 0,
      crashed: 0,
    });
    expect(
      applyReplicaCounts(snap, {
        id: DB,
        replicas: { configured: 1, running: 0, crashed: 0 },
      }).parked,
    ).toBe(true);
  });

  it("unwraps both {data:{...}} and raw CLI envelopes", () => {
    const payload = { serviceInstance: { latestDeployment: null } };
    expect(unwrapData({ data: payload }, "serviceInstance")).toEqual({
      latestDeployment: null,
    });
    expect(unwrapData(payload, "serviceInstance")).toEqual({ latestDeployment: null });
  });

  it("flags unknown statuses for refusal (fail closed)", () => {
    const snap = buildSnapshot(
      "web",
      WEB,
      {
        ...parkedInstance(),
        activeDeployments: [{ id: "x", status: "FROBNICATED", deploymentStopped: false }],
      },
      [],
    );
    expect(classifyDeployment("FROBNICATED")).toBe("unknown");
    const plan = computeStopSet(snap);
    expect(plan.stop).toEqual([]);
    expect(plan.unknown).toContain("FROBNICATED");
  });

  it("pins service IDs and the removable early-stage subset", () => {
    expect(SERVICE_IDS).toEqual({ web: WEB, db: DB, push: PUSH });
    expect(REMOVABLE_STATUSES).toEqual(["QUEUED", "INITIALIZING", "WAITING"]);
  });
});
