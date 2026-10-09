// railway-test-env-state.mjs — native deployment-stop snapshot helper.
// Reads Railway via `railway api` GraphQL ONLY (no mutations, no side
// effects). Prints one JSON object {web,db,push,_meta} to stdout.
//
// Per-service snapshot schema (locked with LifecycleTests, 2026-10-09):
//   {service, serviceId, latest:{id,status,deploymentStopped}|null,
//    active:[{id,status,deploymentStopped}], running, configured, crashed,
//    parked: bool, pending:[{id,status}]}
// parked := running==0 AND no active non-stopped AND no pending;
// configured ignored; latest null parked only when scoped lists confirm
// empty (active empty + pending empty + running 0) — see isParked.
//
// Fail-closed read contract (2026-10-09 repair):
// - NEVER manufacture zeros/false: replica counts come ONLY from a validated
//   `railway service list` entry for the same service id; enabled comes ONLY
//   from a validated autodeploy payload. Missing/unconfirmed reads throw
//   READ_RETRYABLE (exit 1); refusal/not-found throws READ_TERMINAL (exit 3).
// - SOLE narrow allowance: a null/missing replicas object is read as 0/0/0
//   ONLY for the witnessed live source-less push shape, i.e. when the scoped
//   snapshot itself already proves empty (latest null + active [] + pending
//   []; active already merges the scoped deployments-list nodes, so empty
//   active means no nodes either). Anything still in flight keeps its counts
//   unconfirmed (retryable), never zeroed.
// - GraphQL `errors` arrays, null/missing queried fields, missing
//   activeDeployments/edges arrays, truncated history (pageInfo.hasNextPage),
//   non-boolean deploymentStopped (undefined tolerates legacy missing field),
//   and empty/non-string statuses are all READ_RETRYABLE, never defaulted.
//
// Exit codes: 0 ok / 1 retryable read error / 3 terminal refusal.
// No new dependencies: node builtins only.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PENDING_STATUSES,
  PROJECT_ID,
  SERVICE_IDS,
  TEST_ENV_ID,
  assertTestEnv,
  isParked,
  resolveTargetEnv,
} from "./railway-test-env-guard.mjs";

const SERVICE_LABELS = { web: "web-test", db: "Postgres-ltHj", push: "push-delivery" };

// Portable read timeout (execFileSync option; no new deps, no shell timeout).
const API_TIMEOUT_MS = 20000;

function retryable(message) {
  return Object.assign(new Error(message), { code: "READ_RETRYABLE" });
}

function terminal(message) {
  return Object.assign(new Error(message), { code: "READ_TERMINAL" });
}

function errMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

function describeExecError(err, timeoutMs) {
  const raw =
    err && (err.stderr || err.stdout || err.message)
      ? String(err.stderr || err.stdout || err.message)
      : String(err);
  if (err && (err.code === "ETIMEDOUT" || err.killed || /timed out|ETIMEDOUT/i.test(raw))) {
    return `timed out after ${timeoutMs}ms`;
  }
  return raw.trim().slice(0, 300);
}

function apiCall(query, variables) {
  // Exact argv contract (locked): railway api '<GraphQL>' --variables '<json>'
  // with explicit project+environment+service scoping inside variables.
  let out;
  try {
    out = execFileSync(
      "railway",
      ["api", query, "--variables", JSON.stringify(variables)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: API_TIMEOUT_MS },
    );
  } catch (err) {
    if (err && (err.code === "READ_RETRYABLE" || err.code === "READ_TERMINAL")) throw err;
    throw retryable(`railway api failed: ${describeExecError(err, API_TIMEOUT_MS)}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw retryable("railway api returned non-JSON");
  }
}

const INSTANCE_QUERY = `query SnapshotInstance($environmentId: String!, $serviceId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    serviceName region numReplicas
    source { image repo } startCommand
    latestDeployment { id status deploymentStopped canRedeploy }
    activeDeployments { id status deploymentStopped }
  }
}`;

const DEPLOYMENTS_QUERY = `query SnapshotDeployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
  deployments(input: {projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId}, first: 50) {
    edges { node { id status deploymentStopped serviceId environmentId } }
  }
}`;

export function unwrapData(envelope, ...paths) {
  // Tolerate CLI envelopes: raw object, {data:{...}}, or JSON string lines.
  // Fail closed: a non-empty GraphQL errors array is rejected outright, and a
  // requested field that resolves to null/undefined (or is absent) throws
  // READ_RETRYABLE instead of letting callers default to {} / [] / false.
  // The single carve-out is service absence: a null serviceInstance field
  // throws with err.nullField set, so fetchServiceSnapshot can map
  // null-instance + empty scoped deployments to READ_TERMINAL not-found
  // (and to READ_RETRYABLE when scoped deployments still exist).
  if (envelope && typeof envelope === "object") {
    for (const holder of [envelope, envelope.data]) {
      if (
        holder &&
        typeof holder === "object" &&
        Array.isArray(holder.errors) &&
        holder.errors.length > 0
      ) {
        throw retryable(
          `railway api returned GraphQL errors: ${JSON.stringify(holder.errors).slice(0, 200)}`,
        );
      }
    }
  }
  let root = envelope;
  if (root && typeof root === "object" && root.data && typeof root.data === "object") {
    root = root.data;
  }
  if (paths.length === 0) return root;
  for (const path of paths) {
    if (root && typeof root === "object" && root[path] !== undefined) {
      const value = root[path];
      if (value === null || value === undefined) {
        throw Object.assign(
          retryable(`railway api field ${path} is null (refusing to default)`),
          { nullField: true },
        );
      }
      return value;
    }
  }
  throw retryable(`railway api response missing field ${paths.join("/")} (refusing to default)`);
}

function num(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Strict shape check for one deployment object (latest, active entry, or
// scoped deployments-list node). Status must be a non-empty string (no
// UNKNOWN default); deploymentStopped must be boolean where present —
// undefined tolerates the legacy missing field, but non-boolean truthy
// shapes (1, "true", ...) are rejected instead of coerced.
function assertDeploymentShape(dep, where) {
  if (!dep || typeof dep !== "object" || Array.isArray(dep)) {
    throw retryable(`${where} has malformed deployment entry (refusing to skip; full stop set cannot be established)`);
  }
  if ((typeof dep.id !== "string" && typeof dep.id !== "number") || String(dep.id).length === 0) {
    throw retryable(`${where} deployment missing id (refusing to skip)`);
  }
  if (typeof dep.status !== "string" || dep.status.length === 0) {
    throw retryable(
      `${where} deployment ${String(dep.id)} status is not a non-empty string (refusing UNKNOWN default)`,
    );
  }
  if (dep.deploymentStopped !== undefined && typeof dep.deploymentStopped !== "boolean") {
    throw retryable(
      `${where} deployment ${String(dep.id)} deploymentStopped is not boolean (rejecting truthy shapes)`,
    );
  }
}

// Pure: merge one serviceInstance payload + scoped deployment nodes into a
// per-service snapshot. Exported for vitest; no Railway calls.
export function applyReplicaCounts(snapshot, entry) {
  // Live serviceInstance.numReplicas is an Int scalar (config count, no
  // running/crashed subfields). Running/configured/crashed come from the
  // scoped `railway service list --json` entry for the same service.
  // Fail closed: undefined entry, entry.id mismatch (exact identity
  // required), unconfirmed replicas, or any non-integer running/configured/
  // crashed throws — running=0 is never manufactured. See the file header
  // for the SOLE narrow allowance (source-less push with provably empty
  // scoped snapshot).
  const serviceId = snapshot && typeof snapshot === "object" ? snapshot.serviceId : undefined;
  const label = serviceId !== undefined ? String(serviceId) : "?";
  const service = snapshot && typeof snapshot === "object" && snapshot.service ? String(snapshot.service) : label;
  if (!entry || typeof entry !== "object") {
    throw terminal(`service ${service} has no service-list entry (refusing to default replicas)`);
  }
  if (typeof entry.id !== "string" || entry.id.length === 0 || String(entry.id) !== String(serviceId)) {
    throw terminal(
      `service-list entry identity mismatch for service ${service} (got id ${entry && entry.id})`,
    );
  }
  const reps = entry.replicas;
  if (reps === null || reps === undefined) {
    // SOLE narrow allowance: the witnessed live source-less push shape
    // carries no replicas object at all. Reading it as 0/0/0 is only sound
    // when the scoped snapshot itself already proves empty (latest null +
    // active [] + pending []; active already merges the scoped
    // deployments-list nodes, so empty active means no nodes either).
    if (
      snapshot &&
      (snapshot.latest === null || snapshot.latest === undefined) &&
      Array.isArray(snapshot.active) &&
      snapshot.active.length === 0 &&
      Array.isArray(snapshot.pending) &&
      snapshot.pending.length === 0
    ) {
      const running = 0;
      return {
        ...snapshot,
        running,
        configured: 0,
        crashed: 0,
        parked: isParked({ ...snapshot, running }),
      };
    }
    throw retryable(
      `service ${service} replica counts unconfirmed (replicas null/missing, snapshot not provably empty)`,
    );
  }
  if (typeof reps !== "object" || Array.isArray(reps)) {
    throw retryable(`service ${service} replicas malformed (refusing fallback 0)`);
  }
  for (const field of ["running", "configured", "crashed"]) {
    if (!Number.isInteger(reps[field]) || reps[field] < 0) {
      throw retryable(
        `service ${service} replicas.${field} is not a non-negative integer (got ${JSON.stringify(reps[field])}); refusing fallback 0`,
      );
    }
  }
  const running = reps.running;
  return {
    ...snapshot,
    running,
    configured: reps.configured,
    crashed: reps.crashed,
    parked: isParked({ ...snapshot, running }),
  };
}

export function fetchServiceListEntries(environmentId) {
  let out;
  try {
    out = execFileSync(
      "railway",
      ["service", "list", "-p", PROJECT_ID, "-e", environmentId, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: API_TIMEOUT_MS },
    );
  } catch (err) {
    if (err && (err.code === "READ_RETRYABLE" || err.code === "READ_TERMINAL")) throw err;
    throw retryable(`service list read failed: ${describeExecError(err, API_TIMEOUT_MS)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw retryable("service list returned non-JSON");
  }
  // Fail closed: accept Array or {services:Array}; reject malformed or empty
  // envelopes as retryable instead of returning an empty map (which would
  // misread every service as absent).
  const list =
    Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.services) ? parsed.services : null;
  if (!list || list.length === 0) {
    throw retryable("service list returned malformed/empty envelope (refusing empty map)");
  }
  const byId = {};
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.length === 0) {
      throw retryable("service list entry missing string id (refusing partial map)");
    }
    // Replicas, when present, must be an object with integer-or-null fields;
    // anything else (string, array, float/bool fields) is a corrupt read.
    // Null/missing replicas as a whole are deferred to applyReplicaCounts,
    // which only tolerates them for the provably-empty source-less shape.
    const reps = entry.replicas;
    if (reps !== undefined && reps !== null) {
      if (typeof reps !== "object" || Array.isArray(reps)) {
        throw retryable(`service list entry ${entry.id} has malformed replicas (refusing to default)`);
      }
      for (const field of ["running", "configured", "crashed"]) {
        const value = reps[field];
        if (
          value !== undefined &&
          value !== null &&
          (!Number.isInteger(value) || value < 0)
        ) {
          throw retryable(
            `service list entry ${entry.id} replicas.${field} is not integer-or-null (refusing to default)`,
          );
        }
      }
    }
    byId[entry.id] = entry;
  }
  return byId;
}

// Pure: merge one serviceInstance payload + scoped deployment nodes into a
export function buildSnapshot(service, serviceId, instance, nodes) {
  // Fail closed: a missing serviceInstance object or a non-array nodes list
  // throws instead of producing a vacuously-parked empty snapshot.
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw retryable(`snapshot for ${service}: serviceInstance object missing (refusing empty snapshot)`);
  }
  if (!Array.isArray(nodes)) {
    throw retryable(`snapshot for ${service}: scoped deployment nodes not an array (refusing to default [])`);
  }
  const inst = instance;
  const reps = inst.replicas || {};
  const latestSource = inst.latestDeployment !== undefined ? inst.latestDeployment : inst.latest;
  const latestRaw = latestSource || null;
  let latest = null;
  if (latestRaw !== null && latestRaw !== undefined) {
    // latestDeployment: null marks the source-less shape; a present value
    // must be well-formed (no silent null-latest on corrupt payloads).
    assertDeploymentShape(latestRaw, `${service} latestDeployment`);
    latest = {
      id: String(latestRaw.id),
      status: latestRaw.status,
      deploymentStopped: latestRaw.deploymentStopped === true,
    };
  }
  const activeRaw = Array.isArray(inst.activeDeployments)
    ? inst.activeDeployments
    : Array.isArray(inst.active)
      ? inst.active
      : null;
  if (activeRaw === null) {
    throw retryable(
      `snapshot for ${service}: activeDeployments array missing (refusing to default [])`,
    );
  }
  const active = [];
  const seen = new Set();
  const pushActive = (d, where) => {
    assertDeploymentShape(d, where);
    const id = String(d.id);
    if (seen.has(id)) return;
    seen.add(id);
    active.push({
      id,
      status: d.status,
      deploymentStopped: d.deploymentStopped === true,
    });
  };
  for (const d of activeRaw) {
    pushActive(d, `${service} activeDeployments`);
  }
  for (const n of nodes) {
    // Defense in depth: the deployments query is already scoped by
    // project+environment+service server-side, but the push service ID is
    // shared with production, so drop any node that affirmatively names a
    // different service or environment. Fields absent (older shapes) pass.
    if (n && typeof n === "object") {
      if (n.serviceId && String(n.serviceId) !== String(serviceId)) continue;
      if (n.environmentId && String(n.environmentId) !== String(TEST_ENV_ID)) continue;
    }
    pushActive(n, `${service} deployments node`);
  }
  const pending = active
    .filter(
      (d) =>
        d.deploymentStopped !== true &&
        PENDING_STATUSES.includes(String(d.status).toUpperCase()),
    )
    .map((d) => ({ id: d.id, status: d.status }));
  const snapshot = {
    service,
    serviceId,
    latest,
    active,
    running: num(reps.running, 0),
    configured: num(reps.configured, 0),
    crashed: num(reps.crashed, 0),
    pending,
    parked: false,
  };
  snapshot.parked = isParked(snapshot);
  return snapshot;
}

export function fetchServiceSnapshot(service, serviceId, environmentId, serviceListById) {
  const vars = {
    environmentId,
    serviceId,
  };
  let instanceEnv;
  try {
    instanceEnv = apiCall(INSTANCE_QUERY, vars);
  } catch (err) {
    throw retryable(`serviceInstance read failed for ${service}: ${errMessage(err)}`);
  }
  // Null serviceInstance marks service absence ONLY when the scoped
  // deployments list is also empty (mapped to READ_TERMINAL below); with
  // deployments present the service exists and the read is corrupt
  // (READ_RETRYABLE). GraphQL errors / missing keys stay retryable.
  let instance = null;
  let instanceNullField = false;
  try {
    const payload = unwrapData(instanceEnv, "serviceInstance");
    instance =
      payload &&
      typeof payload === "object" &&
      payload.serviceInstance &&
      typeof payload.serviceInstance === "object"
        ? payload.serviceInstance
        : payload;
  } catch (err) {
    if (err && err.nullField === true) {
      instanceNullField = true;
      instance = null;
    } else {
      throw err;
    }
  }
  let deploymentsEnv;
  try {
    deploymentsEnv = apiCall(DEPLOYMENTS_QUERY, { ...vars, projectId: PROJECT_ID });
  } catch (err) {
    throw retryable(`deployments read failed for ${service}: ${errMessage(err)}`);
  }
  let inner;
  try {
    const dep = unwrapData(deploymentsEnv, "deployments");
    inner =
      dep && typeof dep === "object" && dep.deployments && typeof dep.deployments === "object"
        ? dep.deployments
        : dep;
  } catch (err) {
    throw retryable(`deployments read failed for ${service}: ${errMessage(err)}`);
  }
  // Fail closed: a missing edges array is never defaulted to [] — and a
  // truncated page (hasNextPage) means the full stop set cannot be
  // established, so the read is refused outright.
  if (!inner || typeof inner !== "object" || !Array.isArray(inner.edges)) {
    throw retryable(
      `deployments read failed for ${service}: edges array missing (refusing to default [])`,
    );
  }
  if (
    inner.pageInfo &&
    typeof inner.pageInfo === "object" &&
    inner.pageInfo.hasNextPage === true
  ) {
    throw retryable(
      `deployments read failed for ${service}: history truncated (hasNextPage); full stop set cannot be established`,
    );
  }
  const nodes = inner.edges.map((e) => (e && typeof e === "object" && e.node ? e.node : e));
  const instanceEmpty =
    instanceNullField ||
    instance === null ||
    instance === undefined ||
    (typeof instance === "object" && !Array.isArray(instance) && Object.keys(instance).length === 0);
  if (instanceEmpty && nodes.length === 0) {
    throw terminal(`service ${service} not found in environment ${environmentId}`);
  }
  if (instanceEmpty) {
    throw retryable(
      `serviceInstance read failed for ${service}: instance object missing while scoped deployments exist (refusing partial snapshot)`,
    );
  }
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw retryable(
      `serviceInstance read failed for ${service}: instance object missing (refusing empty snapshot)`,
    );
  }
  if (!Array.isArray(instance.activeDeployments) && !Array.isArray(instance.active)) {
    throw retryable(
      `serviceInstance read failed for ${service}: activeDeployments array missing (refusing to default [])`,
    );
  }
  const snapshot = buildSnapshot(service, serviceId, instance, nodes);
  const listById = serviceListById || fetchServiceListEntries(environmentId);
  const entry =
    listById && typeof listById === "object" ? listById[String(serviceId)] : undefined;
  if (!entry) {
    throw terminal(`service ${service} not found in service list for environment ${environmentId}`);
  }
  return applyReplicaCounts(snapshot, entry);
}

// Read-only autodeploy probe for the TEST web service. Returns
// {enabled, canEnable} or throws READ_RETRYABLE — a missing payload or a
// non-boolean enabled NEVER reads as enabled:false (that would let the shell
// disable-verification false-succeed).
export function fetchAutodeployStatus(serviceId, environmentId) {
  const query = `query AutodeployStatus($projectId: String!, $serviceId: String!, $environmentId: String!) {
    serviceInstanceAutoDeployStatus(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
      enabled canEnable
    }
  }`;
  try {
    const env = apiCall(query, {
      projectId: PROJECT_ID,
      serviceId,
      environmentId,
    });
    const status = unwrapData(env, "serviceInstanceAutoDeployStatus");
    const payload =
      status &&
      typeof status === "object" &&
      status.serviceInstanceAutoDeployStatus &&
      typeof status.serviceInstanceAutoDeployStatus === "object"
        ? status.serviceInstanceAutoDeployStatus
        : status;
    if (!payload || typeof payload !== "object") {
      throw retryable(
        "serviceInstanceAutoDeployStatus read failed: payload missing (refusing enabled:false default)",
      );
    }
    if (typeof payload.enabled !== "boolean") {
      throw retryable(
        "serviceInstanceAutoDeployStatus read failed: enabled is not boolean (refusing enabled:false default)",
      );
    }
    return {
      enabled: payload.enabled,
      canEnable: payload.canEnable !== false,
    };
  } catch (err) {
    if (err && (err.code === "READ_RETRYABLE" || err.code === "READ_TERMINAL")) throw err;
    throw retryable("serviceInstanceAutoDeployStatus read failed");
  }
}

function usage() {
  console.error(
    "usage: node railway-test-env-state.mjs [--env <env-id>] [--autodeploy <web-service-id>]\n" +
      "  default: print {web,db,push,_meta} snapshot JSON to stdout",
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1] !== "-e" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let envOverride = "";
  let autodeployService = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && i + 1 < args.length) envOverride = args[++i];
    else if (args[i].startsWith("--env=")) envOverride = args[i].slice(6);
    else if (args[i] === "--autodeploy" && i + 1 < args.length)
      autodeployService = args[++i];
    else if (args[i] === "-h" || args[i] === "--help") {
      usage();
      process.exit(0);
    } else {
      usage();
      process.exit(2);
    }
  }
  const target = resolveTargetEnv(envOverride);
  const gate = assertTestEnv(target);
  if (!gate.ok) {
    console.error(`railway-test-env: REFUSING: ${gate.reason}`);
    process.exit(3);
  }
  if (autodeployService) {
    try {
      console.log(JSON.stringify(fetchAutodeployStatus(autodeployService, target)));
      process.exit(0);
    } catch {
      console.error("railway-test-env: autodeploy status read failed (retryable)");
      process.exit(1);
    }
  }
  try {
    const listById = fetchServiceListEntries(target);
    const out = {
      web: fetchServiceSnapshot("web", SERVICE_IDS.web, target, listById),
      db: fetchServiceSnapshot("db", SERVICE_IDS.db, target, listById),
      push: fetchServiceSnapshot("push", SERVICE_IDS.push, target, listById),
      _meta: { projectId: PROJECT_ID, environmentId: target, labels: SERVICE_LABELS },
    };
    console.log(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    console.error(`railway-test-env: snapshot read failed: ${err && err.message}`);
    process.exit(err && err.code === "READ_TERMINAL" ? 3 : 1);
  }
}
