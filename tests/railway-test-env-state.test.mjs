import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import {
  applyReplicaCounts,
  buildSnapshot,
  fetchAutodeployStatus,
  fetchServiceListEntries,
  fetchServiceSnapshot,
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

const execMock = execFileSync;

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

// Live-shaped source-less push: latest null, empty active, retained
// startCommand, no replicas object anywhere (witnessed 2026-10-09).
function sourcelessPushInstance() {
  return {
    serviceName: "push-delivery",
    region: "us-west2",
    numReplicas: null,
    source: null,
    startCommand: "npm run push:worker",
    latestDeployment: null,
    activeDeployments: [],
  };
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    expect(err && err.code).toBe(code);
    return err;
  }
  throw new Error(`expected throw with code ${code}, but nothing threw`);
}

// Route mocked `railway` argv to per-query fixtures. argv contract is locked:
// apiCall runs ["api", <GraphQL>, "--variables", <json>], so dispatch on
// args[1]; service-list runs ["service", "list", ...].
function mockRailway({ instance, deployments, serviceList, autodeploy }) {
  execMock.mockImplementation((cmd, args = []) => {
    if (cmd !== "railway") throw new Error(`unexpected command ${cmd}`);
    if (args[0] === "service" && args[1] === "list") {
      if (typeof serviceList === "string") return serviceList;
      return JSON.stringify(serviceList);
    }
    if (args[0] === "api") {
      const query = args[1] || "";
      if (query.includes("SnapshotInstance")) {
        return typeof instance === "string" ? instance : JSON.stringify(instance);
      }
      if (query.includes("SnapshotDeployments")) {
        return typeof deployments === "string" ? deployments : JSON.stringify(deployments);
      }
      if (query.includes("AutodeployStatus")) {
        return typeof autodeploy === "string" ? autodeploy : JSON.stringify(autodeploy);
      }
    }
    throw new Error(`unexpected railway argv ${JSON.stringify(args).slice(0, 120)}`);
  });
}

function liveInstance(id, status, stopped) {
  return {
    serviceName: "web-test",
    region: "us-west2",
    numReplicas: null,
    source: { image: null, repo: "example/web-repo" },
    startCommand: "npm start",
    latestDeployment: { id, status, deploymentStopped: stopped, canRedeploy: true },
    activeDeployments: [{ id, status, deploymentStopped: stopped }],
  };
}

function deploymentsEnvelope(nodes) {
  return {
    data: {
      deployments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: nodes.map((n) => ({ node: { ...n, serviceId: WEB, environmentId: TEST_ENV_ID } })),
      },
    },
  };
}

describe("railway test-env state helper (pure)", () => {
  it("builds the parked web snapshot from live-shaped stopped inputs", () => {
    const snap = buildSnapshot("web", WEB, parkedInstance(), [
      {
        id: "a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da",
        status: "CRASHED",
        deploymentStopped: true,
        serviceId: WEB, environmentId: TEST_ENV_ID,
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

  it("retains an unstopped latest deployment even when other lists omit it", () => {
    for (const status of ["SUCCESS", "BUILDING"]) {
      const snap = buildSnapshot("web", WEB, parkedInstance({
        latestDeployment: { id: "latest-only", status, deploymentStopped: false },
        activeDeployments: [],
      }), []);
      const merged = applyReplicaCounts(snap, { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } });
      expect(merged.parked).toBe(false);
      expect(computeStopSet(merged).stop).toContain("latest-only");
    }
    const stopped = buildSnapshot("web", WEB, parkedInstance({ activeDeployments: [] }), []);
    expect(applyReplicaCounts(stopped, { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } }).parked).toBe(true);
  });

  it("keeps stopped pending deployments unparked until they finish", () => {
    for (const status of ["BUILDING", "DEPLOYING", "QUEUED"]) {
      const dep = { id: "stopped-build", status, deploymentStopped: true };
      const snap = buildSnapshot("web", WEB, parkedInstance({ latestDeployment: dep, activeDeployments: [dep] }), []);
      const merged = applyReplicaCounts(snap, { id: WEB, replicas: { running: 0, configured: 1, crashed: 0 } });
      expect(merged.pending, status).toEqual([{ id: dep.id, status }]);
      expect(merged.parked, status).toBe(false);
      expect(computeStopSet(merged).stop, status).toContain(dep.id);
    }
    for (const status of ["SUCCESS", "CRASHED"]) {
      const dep = { id: "stopped-finished", status, deploymentStopped: true };
      const snap = buildSnapshot("web", WEB, parkedInstance({ latestDeployment: dep, activeDeployments: [dep] }), []);
      const merged = applyReplicaCounts(snap, { id: WEB, replicas: { running: 0, configured: 1, crashed: 0 } });
      expect(merged.pending, status).toEqual([]);
      expect(merged.parked, status).toBe(true);
    }
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
      [{ id: "live-1", status: "SUCCESS", deploymentStopped: false, serviceId: WEB, environmentId: TEST_ENV_ID }],
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

describe("applyReplicaCounts (fail closed, no manufactured zeros)", () => {
  it("throws READ_TERMINAL on an undefined entry (never defaults running=0)", () => {
    const snap = buildSnapshot("db", DB, parkedInstance(), []);
    expectCode(() => applyReplicaCounts(snap, undefined), "READ_TERMINAL");
  });

  it("throws READ_TERMINAL on an entry id mismatch (exact identity required)", () => {
    const snap = buildSnapshot("web", WEB, parkedInstance(), []);
    expectCode(
      () => applyReplicaCounts(snap, { id: DB, replicas: { configured: 1, running: 0, crashed: 0 } }),
      "READ_TERMINAL",
    );
  });

  it("throws READ_RETRYABLE on missing replicas for a non-empty snapshot", () => {
    const snap = buildSnapshot("db", DB, parkedInstance(), []);
    expect(snap.active.length).toBeGreaterThan(0);
    expectCode(() => applyReplicaCounts(snap, { id: DB }), "READ_RETRYABLE");
    expectCode(() => applyReplicaCounts(snap, { id: DB, replicas: null }), "READ_RETRYABLE");
  });

  it("throws READ_RETRYABLE on any non-integer replica field (no fallback 0)", () => {
    const snap = buildSnapshot("web", WEB, parkedInstance(), []);
    for (const replicas of [
      { configured: 1, running: "0", crashed: 0 },
      { configured: 1, running: 0, crashed: null },
      { configured: 1.5, running: 0, crashed: 0 },
      { configured: 1, running: -1, crashed: 0 },
    ]) {
      expectCode(() => applyReplicaCounts(snap, { id: WEB, replicas }), "READ_RETRYABLE");
    }
    expectCode(() => applyReplicaCounts(snap, { id: WEB, replicas: [0] }), "READ_RETRYABLE");
  });

  it("parks only explicitly source-less push with null replicas and scoped empty history", () => {
    const snap = buildSnapshot("push", PUSH, sourcelessPushInstance(), []);
    expect(snap.latest).toBeNull();
    for (const entry of [{ id: PUSH, source: null, replicas: null }]) {
      const merged = applyReplicaCounts(snap, entry);
      expect(merged).toMatchObject({ running: 0, configured: 0, crashed: 0 });
      expect(merged.parked).toBe(true);
      expect(isParked(merged)).toBe(true);
    }
  });

  it("never infers empty web or DB replicas even with null latest and empty lists", () => {
    for (const [service, serviceId] of [["web", WEB], ["db", DB]]) {
      const snap = buildSnapshot(service, serviceId, sourcelessPushInstance(), []);
      expectCode(() => applyReplicaCounts(snap, { id: serviceId, source: null, replicas: null }), "READ_RETRYABLE");
    }
  });

  it("rejects omitted source, replica fields and unvalidated empty snapshots", () => {
    const snap = buildSnapshot("push", PUSH, sourcelessPushInstance(), []);
    for (const entry of [
      { id: PUSH, replicas: null },
      { id: PUSH, source: null },
      { id: PUSH, source: undefined, replicas: null },
      { id: PUSH, source: {}, replicas: null },
    ]) expectCode(() => applyReplicaCounts(snap, entry), "READ_RETRYABLE");
    const entry = { id: PUSH, source: null, replicas: null };
    expectCode(() => applyReplicaCounts({ ...snap }, entry), "READ_RETRYABLE");
    expectCode(() => applyReplicaCounts({ ...snap, latest: undefined }, entry), "READ_RETRYABLE");
    const history = buildSnapshot("push", PUSH, sourcelessPushInstance(), [
      { id: "old", status: "CRASHED", deploymentStopped: true, serviceId: PUSH, environmentId: TEST_ENV_ID },
    ]);
    expectCode(() => applyReplicaCounts(history, entry), "READ_RETRYABLE");
  });
});

describe("unwrapData (fail closed)", () => {
  it("rejects envelopes carrying a non-empty GraphQL errors array", () => {
    const errors = [{ message: "boom" }];
    expectCode(
      () => unwrapData({ data: { serviceInstance: { id: "x" } }, errors }, "serviceInstance"),
      "READ_RETRYABLE",
    );
    expectCode(
      () => unwrapData({ data: { deployments: null, errors } }, "deployments"),
      "READ_RETRYABLE",
    );
  });

  it("rejects a null requested field instead of letting callers default it", () => {
    const err = expectCode(
      () => unwrapData({ data: { serviceInstance: null } }, "serviceInstance"),
      "READ_RETRYABLE",
    );
    expect(err.nullField).toBe(true);
  });

  it("rejects a missing requested field instead of returning the envelope", () => {
    expectCode(() => unwrapData({ data: {} }, "serviceInstance"), "READ_RETRYABLE");
  });
});

describe("buildSnapshot (strict shapes, no silent defaults)", () => {
  it("throws READ_RETRYABLE on a missing serviceInstance object", () => {
    expectCode(() => buildSnapshot("web", WEB, null, []), "READ_RETRYABLE");
    expectCode(() => buildSnapshot("web", WEB, {}, []), "READ_RETRYABLE");
  });

  it("throws READ_RETRYABLE when activeDeployments is absent (never defaults [])", () => {
    expectCode(
      () => buildSnapshot("web", WEB, { latestDeployment: null }, []),
      "READ_RETRYABLE",
    );
  });

  it("throws READ_RETRYABLE on non-array scoped nodes", () => {
    expectCode(
      () => buildSnapshot("web", WEB, parkedInstance(), null),
      "READ_RETRYABLE",
    );
  });

  it("requires an explicit null-or-deployment latest field", () => {
    for (const value of [undefined, false, "", 0]) {
      expectCode(() => buildSnapshot("push", PUSH, { ...sourcelessPushInstance(), latestDeployment: value }, []), "READ_RETRYABLE");
    }
    const instance = sourcelessPushInstance();
    delete instance.latestDeployment;
    expectCode(() => buildSnapshot("push", PUSH, instance, []), "READ_RETRYABLE");
    expect(buildSnapshot("push", PUSH, { ...instance, latest: null }, []).latest).toBeNull();
  });

  it("requires queried deploymentStopped in latest, active, and history entries", () => {
    const dep = { id: "missing-stopped", status: "SUCCESS" };
    for (const instance of [
      parkedInstance({ latestDeployment: dep }),
      parkedInstance({ activeDeployments: [dep] }),
    ]) expectCode(() => buildSnapshot("web", WEB, instance, []), "READ_RETRYABLE");
    expectCode(() => buildSnapshot("web", WEB, parkedInstance(), [{ ...dep, serviceId: WEB, environmentId: TEST_ENV_ID }]), "READ_RETRYABLE");
  });

  it("requires exact scoped deployment history identity", () => {
    const dep = { id: "missing-scope", status: "CRASHED", deploymentStopped: true };
    for (const node of [dep, { ...dep, serviceId: WEB }, { ...dep, environmentId: TEST_ENV_ID }]) {
      expectCode(() => buildSnapshot("web", WEB, parkedInstance(), [node]), "READ_RETRYABLE");
    }
  });

  it("rejects non-boolean deploymentStopped shapes (no truthy coercion)", () => {
    expectCode(
      () =>
        buildSnapshot(
          "web",
          WEB,
          parkedInstance({ activeDeployments: [{ id: "x", status: "SUCCESS", deploymentStopped: 1 }] }),
          [],
        ),
      "READ_RETRYABLE",
    );
    expectCode(
      () =>
        buildSnapshot(
          "web",
          WEB,
          parkedInstance({
            latestDeployment: { id: "x", status: "SUCCESS", deploymentStopped: "true" },
          }),
          [],
        ),
      "READ_RETRYABLE",
    );
  });

  it("rejects empty/non-string statuses (no UNKNOWN default)", () => {
    expectCode(
      () =>
        buildSnapshot(
          "web",
          WEB,
          parkedInstance({ activeDeployments: [{ id: "x", status: "", deploymentStopped: false }] }),
          [],
        ),
      "READ_RETRYABLE",
    );
    expectCode(
      () => buildSnapshot("web", WEB, parkedInstance(), [{ id: "y", deploymentStopped: false }]),
      "READ_RETRYABLE",
    );
  });
});

describe("fetchServiceListEntries (mocked railway)", () => {
  it("rejects malformed/empty envelopes as retryable, not an empty map", () => {
    for (const serviceList of ["{}", "[]", '{"services":[]}', "this is not json{{{["]) {
      mockRailway({ serviceList });
      expectCode(() => fetchServiceListEntries(TEST_ENV_ID), "READ_RETRYABLE");
    }
  });

  it("rejects entries missing a string id or with non-integer replica fields", () => {
    mockRailway({ serviceList: [{ replicas: { running: 0 } }] });
    expectCode(() => fetchServiceListEntries(TEST_ENV_ID), "READ_RETRYABLE");
    mockRailway({ serviceList: [{ id: WEB, replicas: { running: "lots" } }] });
    expectCode(() => fetchServiceListEntries(TEST_ENV_ID), "READ_RETRYABLE");
  });

  it("returns a validated map, tolerating the replicas-less parked push entry", () => {
    mockRailway({
      serviceList: [
        { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
        { id: PUSH, source: null, replicas: null },
      ],
    });
    const byId = fetchServiceListEntries(TEST_ENV_ID);
    expect(Object.keys(byId).sort()).toEqual([PUSH, WEB].sort());
  });
});

describe("fetchServiceSnapshot (mocked railway)", () => {
  const node = {
    id: "a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da",
    status: "CRASHED",
    deploymentStopped: true,
  };

  it("keeps the exact railway api argv contract (api/query/--variables)", () => {
    mockRailway({
      instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } },
      deployments: deploymentsEnvelope([node]),
    });
    const snap = fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {
      [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
    });
    expect(snap.parked).toBe(true);
    const apiCalls = execMock.mock.calls.filter(([, args]) => args && args[0] === "api");
    expect(apiCalls.length).toBe(2);
    for (const [, args] of apiCalls) {
      expect(args[2]).toBe("--variables");
      expect(() => JSON.parse(args[3])).not.toThrow();
    }
  });

  it("rejects GraphQL errors instead of snapshotting", () => {
    mockRailway({
      instance: {
        data: { serviceInstance: liveInstance(node.id, "CRASHED", true) },
        errors: [{ message: "boom" }],
      },
      deployments: deploymentsEnvelope([node]),
    });
    expectCode(
      () =>
        fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {
          [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
        }),
      "READ_RETRYABLE",
    );
  });

  it("maps null serviceInstance + empty deployments to READ_TERMINAL not-found", () => {
    mockRailway({
      instance: { data: { serviceInstance: null } },
      deployments: { data: { deployments: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const err = expectCode(
      () => fetchServiceSnapshot("db", DB, TEST_ENV_ID, {}),
      "READ_TERMINAL",
    );
    expect(err.message).toMatch(/not found/i);
  });

  it("rejects null serviceInstance while scoped deployments exist (retryable, not terminal)", () => {
    mockRailway({
      instance: { data: { serviceInstance: null } },
      deployments: deploymentsEnvelope([node]),
    });
    expectCode(() => fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {}), "READ_RETRYABLE");
  });

  it("rejects a missing deployments edges array (never defaults [])", () => {
    mockRailway({
      instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } },
      deployments: { data: { deployments: {} } },
    });
    expectCode(
      () =>
        fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {
          [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
        }),
      "READ_RETRYABLE",
    );
  });

  it("rejects continuation pages missing a cursor — stop set unknowable", () => {
    mockRailway({
      instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } },
      deployments: { data: { deployments: { edges: [], pageInfo: { hasNextPage: true } } } },
    });
    expectCode(
      () =>
        fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {
          [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
        }),
      "READ_RETRYABLE",
    );
  });

  it("follows all scoped history pages and includes later pending deployments", () => {
    mockRailway({ instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } } });
    const base = execMock.getMockImplementation();
    execMock.mockImplementation((cmd, args) => {
      if (args[0] === "api" && args[1].includes("SnapshotDeployments")) {
        const vars = JSON.parse(args[3]);
        const page = vars.after === null ? deploymentsEnvelope([node]) : deploymentsEnvelope([{ id: "second-page", status: "BUILDING", deploymentStopped: false }]);
        page.data.deployments.pageInfo = { hasNextPage: vars.after === null, endCursor: vars.after === null ? "cursor-1" : null };
        return JSON.stringify(page);
      }
      return base(cmd, args);
    });
    const snap = fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {
      [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } },
    });
    expect(snap.pending).toContainEqual({ id: "second-page", status: "BUILDING" });
    expect(snap.parked).toBe(false);
  });

  it("rejects malformed, repeated and missing pagination evidence", () => {
    for (const pageInfo of [undefined, {}, { hasNextPage: false }, { hasNextPage: "false", endCursor: null }, { hasNextPage: true, endCursor: "same" }]) {
      const deployments = deploymentsEnvelope([node]);
      if (pageInfo === undefined) delete deployments.data.deployments.pageInfo;
      else deployments.data.deployments.pageInfo = pageInfo;
      mockRailway({ instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } }, deployments });
      expectCode(() => fetchServiceSnapshot("web", WEB, TEST_ENV_ID, { [WEB]: { id: WEB, replicas: { configured: 1, running: 0, crashed: 0 } } }), "READ_RETRYABLE");
    }
  });

  it("rejects snapshot scope mismatches before any read", () => {
    const callCount = execMock.mock.calls.length;
    expectCode(() => fetchServiceSnapshot("push", PUSH, "production", {}), "READ_TERMINAL");
    expectCode(() => fetchServiceSnapshot("web", PUSH, TEST_ENV_ID, {}), "READ_TERMINAL");
    expect(execMock.mock.calls).toHaveLength(callCount);
  });

  it("throws READ_TERMINAL when the required service-list entry is absent", () => {
    mockRailway({
      instance: { data: { serviceInstance: liveInstance(node.id, "CRASHED", true) } },
      deployments: deploymentsEnvelope([node]),
    });
    const err = expectCode(() => fetchServiceSnapshot("web", WEB, TEST_ENV_ID, {}), "READ_TERMINAL");
    expect(err.message).toMatch(/not found/i);
  });
});

describe("fetchAutodeployStatus (mocked railway, never manufactures enabled:false)", () => {
  it("returns the live boolean payload", () => {
    mockRailway({
      autodeploy: { data: { serviceInstanceAutoDeployStatus: { enabled: true, canEnable: true } } },
    });
    expect(fetchAutodeployStatus(WEB, TEST_ENV_ID)).toEqual({ enabled: true, canEnable: true });
  });

  it("rejects a null payload (no enabled:false manufacture)", () => {
    mockRailway({ autodeploy: { data: { serviceInstanceAutoDeployStatus: null } } });
    expectCode(() => fetchAutodeployStatus(WEB, TEST_ENV_ID), "READ_RETRYABLE");
  });

  it("rejects a non-boolean enabled flag", () => {
    mockRailway({
      autodeploy: { data: { serviceInstanceAutoDeployStatus: { enabled: 0, canEnable: true } } },
    });
    expectCode(() => fetchAutodeployStatus(WEB, TEST_ENV_ID), "READ_RETRYABLE");
  });

  it("rejects GraphQL errors", () => {
    mockRailway({
      autodeploy: {
        data: { serviceInstanceAutoDeployStatus: { enabled: true, canEnable: true } },
        errors: [{ message: "boom" }],
      },
    });
    expectCode(() => fetchAutodeployStatus(WEB, TEST_ENV_ID), "READ_RETRYABLE");
  });
});
