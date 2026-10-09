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

function apiCall(query, variables) {
  // Exact argv contract (locked): railway api '<GraphQL>' --variables '<json>'
  // with explicit project+environment+service scoping inside variables.
  let out;
  try {
    out = execFileSync(
      "railway",
      ["api", query, "--variables", JSON.stringify(variables)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const detail = (err && err.stderr ? String(err.stderr) : String((err && err.message) || err)).trim().slice(0, 300);
    throw Object.assign(new Error(`railway api failed: ${detail}`), { code: "READ_RETRYABLE" });
  }
  try {
    return JSON.parse(out);
  } catch {
    throw Object.assign(new Error("railway api returned non-JSON"), { code: "READ_RETRYABLE" });
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
  let root = envelope;
  if (root && typeof root === "object" && root.data && typeof root.data === "object") {
    root = root.data;
  }
  for (const path of paths) {
    if (root && typeof root === "object" && root[path] !== undefined) return root[path];
  }
  return root;
}

function num(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Pure: merge one serviceInstance payload + scoped deployment nodes into a
// per-service snapshot. Exported for vitest; no Railway calls.
export function applyReplicaCounts(snapshot, entry) {
  // Live serviceInstance.numReplicas is an Int scalar (config count, no
  // running/crashed subfields). Running/configured/crashed come from the
  // scoped `railway service list --json` entry for the same service.
  const reps = (entry && entry.replicas) || {};
  const running = Number.isInteger(reps.running) ? reps.running : 0;
  const configured = Number.isInteger(reps.configured) ? reps.configured : 0;
  const crashed = Number.isInteger(reps.crashed) ? reps.crashed : 0;
  return { ...snapshot, running, configured, crashed, parked: isParked({ ...snapshot, running }) };
}

export function fetchServiceListEntries(environmentId) {
  try {
    const out = execFileSync(
      "railway",
      ["service", "list", "-p", PROJECT_ID, "-e", environmentId, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : parsed.services || [];
    const byId = {};
    for (const entry of list) {
      if (entry && entry.id) byId[String(entry.id)] = entry;
    }
    return byId;
  } catch (err) {
    const detail = err && (err.stderr || err.stdout || err.message) ? `: ${String(err.stderr || err.stdout || err.message).slice(0, 200)}` : "";
    throw Object.assign(new Error(`service list read failed${detail}`), { code: "READ_RETRYABLE" });
  }
}

// Pure: merge one serviceInstance payload + scoped deployment nodes into a
export function buildSnapshot(service, serviceId, instance, nodes) {
  const inst = instance && typeof instance === "object" ? instance : {};
  const reps = inst.replicas || {};
  const latestRaw = inst.latestDeployment || inst.latest || null;
  const latest =
    latestRaw && typeof latestRaw === "object" && latestRaw.id
      ? {
          id: String(latestRaw.id),
          status: String(latestRaw.status || "UNKNOWN"),
          deploymentStopped: latestRaw.deploymentStopped === true,
        }
      : null;
  const activeRaw = Array.isArray(inst.activeDeployments)
    ? inst.activeDeployments
    : Array.isArray(inst.active)
      ? inst.active
      : [];
  const active = activeRaw
    .filter((d) => d && d.id)
    .map((d) => ({
      id: String(d.id),
      status: String(d.status || "UNKNOWN"),
      deploymentStopped: d.deploymentStopped === true,
    }));
  const list = Array.isArray(nodes) ? nodes : [];
  const seen = new Set(active.map((d) => d.id));
  for (const n of list) {
    if (!n || !n.id || seen.has(String(n.id))) continue;
    // Defense in depth: the deployments query is already scoped by
    // project+environment+service server-side, but the push service ID is
    // shared with production, so drop any node that affirmatively names a
    // different service or environment. Fields absent (older shapes) pass.
    if (n.serviceId && String(n.serviceId) !== String(serviceId)) continue;
    if (n.environmentId && String(n.environmentId) !== String(TEST_ENV_ID)) continue;
    seen.add(String(n.id));
    active.push({
      id: String(n.id),
      status: String(n.status || "UNKNOWN"),
      deploymentStopped: n.deploymentStopped === true,
    });
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
  let instance = {};
  try {
    const env = apiCall(INSTANCE_QUERY, vars);
    instance = unwrapData(env, "serviceInstance") || {};
    if (instance && typeof instance === "object" && instance.serviceInstance) {
      instance = instance.serviceInstance;
    }
  } catch (err) {
    const detail = err && err.message ? `: ${err.message}` : "";
    throw Object.assign(new Error(`serviceInstance read failed for ${service}${detail}`), {
      code: "READ_RETRYABLE",
    });
  }
  let nodes = [];
  try {
    const env = apiCall(DEPLOYMENTS_QUERY, { ...vars, projectId: PROJECT_ID });
    const dep = unwrapData(env, "deployments") || {};
    const payload = dep && dep.deployments ? dep.deployments : dep;
    const edges = (payload && payload.edges) || [];
    nodes = edges.map((e) => (e && e.node ? e.node : e)).filter(Boolean);
  } catch (err) {
    const detail = err && err.message ? `: ${err.message}` : "";
    throw Object.assign(new Error(`deployments read failed for ${service}${detail}`), {
      code: "READ_RETRYABLE",
    });
  }
  if (
    instance &&
    typeof instance === "object" &&
    Object.keys(instance).length === 0 &&
    nodes.length === 0
  ) {
    throw Object.assign(
      new Error(`service ${service} not found in environment ${environmentId}`),
      { code: "READ_TERMINAL" },
    );
  }
  const snapshot = buildSnapshot(service, serviceId, instance, nodes);
  const listById = serviceListById || fetchServiceListEntries(environmentId);
  return applyReplicaCounts(snapshot, listById[String(serviceId)]);
}

// Read-only autodeploy probe for the TEST web service. Returns
// {enabled, canEnable} or throws READ_RETRYABLE.
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
    const status = unwrapData(env, "serviceInstanceAutoDeployStatus") || {};
    const payload =
      status && status.serviceInstanceAutoDeployStatus
        ? status.serviceInstanceAutoDeployStatus
        : status;
    return {
      enabled: payload.enabled === true,
      canEnable: payload.canEnable !== false,
    };
  } catch {
    throw Object.assign(new Error("serviceInstanceAutoDeployStatus read failed"), {
      code: "READ_RETRYABLE",
    });
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
