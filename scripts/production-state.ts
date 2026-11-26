import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { publicOrigin, validateConfig } from "./deploy.ts";
import type { DeploymentConfig } from "./deployment-config.ts";

const config = validateConfig(parse(await readFile("deployment.jsonc", "utf8")) as DeploymentConfig);
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "CLOUDFLARE_API_TOKEN must be supplied through Actions secrets.");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, config.accountId);
const accountPath = `/accounts/${config.accountId}`;
const mode = process.argv[2];
assert.ok(mode === "before" || mode === "after", "Expected before or after.");

/** Reads Cloudflare metadata without logging responses, authentication, or binding values. */
async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Cloudflare metadata request ${path} failed: HTTP ${response.status}`);
  const body = await response.json() as { success: boolean; result: T };
  assert.equal(body.success, true, `Cloudflare metadata request ${path} failed.`);
  return body.result;
}

type Version = { version_id: string; percentage: number };
type Deployment = { id: string; versions: Version[] };
type Binding = { name: string; type: string; namespace_id?: string; bucket_name?: string; service?: string; entrypoint?: string };
type Snapshot = { root: string; submodule: string; workers: Record<string, Deployment | null> };
const snapshot: Snapshot = {
  root: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  submodule: execFileSync("git", ["-C", "cloudflare-os", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workers: {},
};
await mkdir("deployment-records", { recursive: true });
// Save every completed stage so a partial deployment still leaves a useful record.
async function save(): Promise<void> {
  await writeFile(`deployment-records/${mode}.json`, JSON.stringify(snapshot, null, 2) + "\n");
}
await save();

await api(`${accountPath}`);
const namespaces = await api<{ id: string }[]>(`${accountPath}/storage/kv/namespaces?per_page=1000`);
for (const id of [config.context.kvNamespaceId, config.resources.blueprintsKvNamespaceId, config.resources.avatarsKvNamespaceId]) {
  assert.ok(namespaces.some((namespace) => namespace.id === id), "Expected production KV namespace missing.");
}
const buckets = await api<{ buckets: { name: string }[] }>(`${accountPath}/r2/buckets?per_page=1000`);
assert.ok(buckets.buckets.some((bucket) => bucket.name === config.resources.blueprintContentBucket), "Production R2 bucket missing.");
const githubSecrets = await api<{ name: string }[]>(`${accountPath}/workers/scripts/${config.workers.githubGatekeeper.name}/secrets`);
assert.ok(githubSecrets.some((secret) => secret.name === "CLIENT_SECRET"), "GitHub CLIENT_SECRET must already exist; this workflow never writes secrets.");

const existingWorkers = await api<{ id: string; handlers?: string[] }[]>(`${accountPath}/workers/scripts`);
for (const worker of Object.values(config.workers)) {
  if (!worker) continue;
  if (mode === "before" && worker.name === config.workers.emailGatekeeper.name) {
    if (!existingWorkers.some((existing) => existing.id === worker.name)) {
      snapshot.workers[worker.name] = null;
      await save();
      console.log(`${worker.name}: new Email Worker, not yet provisioned`);
      continue;
    }
    const settings = await api<{ bindings: (Binding & { text?: string })[] }>(`${accountPath}/workers/scripts/${worker.name}/settings`);
    assert.equal(settings.bindings.find((binding) => binding.name === "BASE_URL")?.text, `${publicOrigin(config)}/gatekeeper/email`, "Existing Email Worker name belongs to a different configuration.");
  }
  const { deployments } = await api<{ deployments: Deployment[] }>(`${accountPath}/workers/scripts/${worker.name}/deployments`);
  const active = deployments[0];
  assert.ok(active, `${worker.name}: no active deployment.`);
  assert.equal(active.versions.length, 1, `${worker.name}: expected a single active version.`);
  assert.equal(active.versions[0].percentage, 100, `${worker.name}: expected 100% traffic.`);
  snapshot.workers[worker.name] = { id: active.id, versions: active.versions };
  await save();
  console.log(`${worker.name}: ${active.versions[0].version_id} at 100%`);
}

if (mode === "after") {
  const before = JSON.parse(await readFile("deployment-records/before.json", "utf8")) as Snapshot;
  for (const [name, deployment] of Object.entries(snapshot.workers)) {
    assert.ok(deployment, `${name}: missing active deployment.`);
    assert.notEqual(deployment.versions[0].version_id, before.workers[name]?.versions[0].version_id, `${name}: active version did not change.`);
    const subdomain = await api<{ enabled: boolean; previews_enabled: boolean }>(`${accountPath}/workers/scripts/${name}/subdomain`);
    assert.equal(subdomain.enabled, false, `${name}: unexpected workers.dev route.`);
    assert.equal(subdomain.previews_enabled, false, `${name}: preview URLs must be disabled.`);
  }
  const domains = await api<{ service: string; hostname: string }[]>(`${accountPath}/workers/domains`);
  assert.ok(domains.some((domain) => domain.service === config.workers.router.name && domain.hostname === config.workers.router.route.customDomain), "Router custom domain missing.");
  const { bindings } = await api<{ bindings: Binding[] }>(`${accountPath}/workers/scripts/${config.workers.workshop.name}/settings`);
  for (const [name, type, target] of [
    ["BLUEPRINTS", "kv_namespace", config.resources.blueprintsKvNamespaceId],
    ["AVATARS", "kv_namespace", config.resources.avatarsKvNamespaceId],
    ["BLUEPRINT_CONTENT", "r2_bucket", config.resources.blueprintContentBucket],
    ["GATEKEEPER_CONTEXT", "service", config.workers.context.name],
    ["GATEKEEPER_SCHEDULER", "service", config.workers.scheduler.name],
    ["GATEKEEPER_MCP", "service", config.workers.mcpGatekeeper.name],
    ["GATEKEEPER_GITHUB", "service", config.workers.githubGatekeeper.name],
    ["GATEKEEPER_EMAIL", "service", config.workers.emailGatekeeper.name],
  ]) {
    const binding = bindings.find((item) => item.name === name);
    assert.equal(binding?.type, type, `${name}: binding type mismatch.`);
    assert.equal(binding?.namespace_id ?? binding?.bucket_name ?? binding?.service, target, `${name}: production resource mismatch.`);
  }
  assert.ok(bindings.some((binding) => binding.name === "WORKERS_AI" && binding.type === "ai"));
  assert.ok(!bindings.some((binding) => binding.name === "GATEKEEPER_CUSTOM"));
  assert.equal(bindings.find((binding) => binding.name === "GATEKEEPER_EMAIL")?.entrypoint, "GatekeeperVendor");
  const router = await api<{ bindings: Binding[] }>(`${accountPath}/workers/scripts/${config.workers.router.name}/settings`);
  const routerEmail = router.bindings.find((binding) => binding.name === "GATEKEEPER_EMAIL");
  assert.equal(routerEmail?.service, config.workers.emailGatekeeper.name);
  assert.ok(!routerEmail?.entrypoint, "Router must reach Email's default fetch/email handlers.");
  const email = await api<{ bindings: (Binding & { text?: string })[]; migration_tag?: string }>(`${accountPath}/workers/scripts/${config.workers.emailGatekeeper.name}/settings`);
  assert.equal(email.bindings.find((binding) => binding.name === "BASE_URL")?.text, `${publicOrigin(config)}/gatekeeper/email`);
  assert.ok(existingWorkers.find((worker) => worker.id === config.workers.emailGatekeeper.name)?.handlers?.includes("email"), "Email Worker has no email handler.");
  for (const [path, expectedStatus] of [["/", 200], ["/gatekeeper/github/oauth", 200], ["/gatekeeper/email", 404]] as const) {
    const response = await fetch(`${publicOrigin(config)}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, expectedStatus, `${path}: unexpected response or Access redirect.`);
    console.log(`${path}: HTTP ${expectedStatus}`);
    await response.body?.cancel();
  }
  console.log("All eight production Workers verified. Authenticated data and model checks require a signed-in session.");
}
