// Prints the generated seven-Worker plan for deployment.jsonc.
// Names, migration tags, flags, and binding identities only. Variable values are omitted:
// they can carry addresses and administrator lists, and this output is copied into CI logs.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { BaseConfigs, DeploymentConfig, ProdWranglerConfig } from "./core/deployment-config.ts";
import {
  deployOrder,
  generatedOutputs,
  generateConfigs,
  PACKAGE_DIRS,
  workerName,
  type WorkerId,
} from "./core/deployment.ts";
import { loadCatalog } from "./gatekeeper-catalog.ts";

const root = join(import.meta.dirname, "..", "..", "..");

interface MigrationView {
  tag: string;
  newSqliteClasses: string[];
  renamedClasses: string[];
  deletedClasses: string[];
}

interface WorkerView {
  id: string;
  name?: string;
  workersDev?: boolean;
  previewUrls?: boolean;
  routes: string[];
  compatibilityFlags: string[];
  migrations: MigrationView[];
  kv: { binding: string; id?: string }[];
  r2: { binding: string; bucket?: string }[];
  services: { binding: string; service: string; entrypoint?: string }[];
  ai?: string;
  versionMetadata?: string;
  browser?: string;
  workerLoaders: string[];
  varNames: string[];
  secretNames: string[];
}

export interface DeploymentPlan {
  workers: WorkerView[];
  deployOrder: string[];
}

const jsonc = { allowTrailingComma: true };

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsonc) as T;
  if (errors.length) {
    throw new Error(`${path}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

function classes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function migrationsOf(config: ProdWranglerConfig): MigrationView[] {
  return (config.migrations ?? []).map((migration) => ({
    tag: migration.tag,
    newSqliteClasses: classes(migration.new_sqlite_classes),
    renamedClasses: classes(migration["renamed_classes"]),
    deletedClasses: classes(migration["deleted_classes"]),
  }));
}

function viewOf(id: WorkerId, config: ProdWranglerConfig): WorkerView {
  return {
    id,
    name: config.name,
    workersDev: config.workers_dev,
    previewUrls: config.preview_urls,
    routes: (config.routes ?? []).map((route) => route.pattern),
    compatibilityFlags: [...(config.compatibility_flags ?? [])],
    migrations: migrationsOf(config),
    kv: (config.kv_namespaces ?? []).map((namespace) => ({ binding: namespace.binding, id: namespace.id })),
    r2: (config.r2_buckets ?? []).map((bucket) => ({ binding: bucket.binding, bucket: bucket.bucket_name })),
    services: (config.services ?? []).map((service) => ({
      binding: service.binding,
      service: service.service,
      ...(service.entrypoint ? { entrypoint: service.entrypoint } : {}),
    })),
    ...(config.ai?.binding ? { ai: config.ai.binding } : {}),
    ...(config.version_metadata?.binding ? { versionMetadata: config.version_metadata.binding } : {}),
    ...(config.browser?.binding ? { browser: config.browser.binding } : {}),
    workerLoaders: (config.worker_loaders ?? []).map((loader) => loader.binding),
    varNames: Object.keys(config.vars ?? {}).toSorted(),
    secretNames: [...(config.secrets?.required ?? [])].toSorted(),
  };
}

/** The plan `cf-os check` would write, with variable values removed. */
export async function buildProductionPlan(repoRoot = root): Promise<DeploymentPlan> {
  const deployment = await readJsonc<DeploymentConfig>(join(repoRoot, "deployment.jsonc"));
  const bases = Object.fromEntries(await Promise.all(Object.entries(PACKAGE_DIRS).map(async ([key, dir]) =>
    [key, await readJsonc<ProdWranglerConfig>(join(repoRoot, dir, "wrangler.jsonc"))] as const)));
  const catalog = await loadCatalog(repoRoot);
  const generated = generateConfigs(deployment, bases as unknown as BaseConfigs, catalog);
  return {
    workers: generatedOutputs(generated).map(([id, config]) => viewOf(id, config)),
    deployOrder: deployOrder(deployment).map((id) => workerName(deployment, id)),
  };
}

function worker(plan: DeploymentPlan, id: string): WorkerView {
  const found = plan.workers.find((item) => item.id === id);
  if (!found) throw new Error(`generated plan has no ${id}`);
  return found;
}

function sameClasses(actual: string[], expected: readonly string[], where: string): void {
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${where}: ${actual.join(", ") || "(none)"}`);
  }
}

/**
 * The production file's generated plan: seven Workers, Workshop v0–v4 including
 * AdminAuditDurableObject, GitHub kept at v1, and no optional Worker.
 */
export function assertProductionPlan(plan: DeploymentPlan): void {
  const names = plan.workers.map((item) => item.name);
  const expected = [
    "cloudflareos-errors",
    "cloudflareos-gk-context",
    "cloudflareos-gk-scheduler",
    "cloudflareos-gk-github",
    "cloudflareos-gk-mcp",
    "cloudflareos-backend",
    "cloudflareos",
  ];
  const actual = new Set(names);
  if (actual.size !== expected.length || expected.some((name) => !actual.has(name))) {
    throw new Error(`generated Workers: ${names.join(", ")}`);
  }
  sameClasses(plan.deployOrder, expected, "deploy order");
  for (const item of plan.workers) {
    if (item.previewUrls !== false) throw new Error(`${item.id} preview_urls is not false`);
    if (item.workersDev !== false) throw new Error(`${item.id} workers_dev is not false`);
    for (const migration of item.migrations) {
      if (migration.renamedClasses.length || migration.deletedClasses.length) {
        throw new Error(`${item.id} ${migration.tag} renames or deletes a class`);
      }
    }
    for (const service of item.services) {
      if (service.binding === "GATEKEEPER_WEBSEARCH" || service.binding === "GATEKEEPER_CUSTOM") {
        throw new Error(`${item.id} binds ${service.binding}`);
      }
    }
  }

  const workshop = worker(plan, "workshop");
  const tags = workshop.migrations.map((migration) => migration.tag);
  sameClasses(tags, ["v0", "v1", "v2", "v3", "v4"], "workshop migration tags");
  sameClasses(workshop.migrations[0].newSqliteClasses, ["UserDurableObject", "OverseerDurableObject"], "workshop v0");
  sameClasses(workshop.migrations[1].newSqliteClasses, ["AdminSettings"], "workshop v1");
  sameClasses(workshop.migrations[2].newSqliteClasses, ["PendingLogin"], "workshop v2");
  sameClasses(workshop.migrations[3].newSqliteClasses, ["UserDirectoryDurableObject"], "workshop v3");
  sameClasses(workshop.migrations[4].newSqliteClasses, ["AdminAuditDurableObject"], "workshop v4");
  if (workshop.versionMetadata !== "CF_VERSION_METADATA") throw new Error("workshop version metadata binding missing");
  if (workshop.ai !== "WORKERS_AI") throw new Error("workshop WORKERS_AI binding missing");
  for (const name of ["ADMINS", "AUTH_GATEKEEPERS", "DISABLE_PASSWORD_AUTH", "PUBLIC_BASE_URL"]) {
    if (!workshop.varNames.includes(name)) throw new Error(`workshop var ${name} missing`);
  }
  for (const name of ["CF_ACCESS_ISS", "CF_ACCESS_AUD", "CF_AI_GATEWAY", "CF_AI_GATEWAY_ACCOUNT_ID", "CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_USE_BINDING"]) {
    if (workshop.varNames.includes(name)) throw new Error(`workshop var ${name} is set`);
  }

  const github = worker(plan, "gatekeepers.github");
  sameClasses(github.migrations.map((migration) => migration.tag), ["v0", "v1"], "github migration tags");
  sameClasses(github.migrations[1].newSqliteClasses, ["GitHubHookDriver"], "github v1");
  if (github.varNames.includes("CLIENT_ID") || github.varNames.includes("CLIENT_SECRET")) {
    throw new Error("github OAuth names are vars");
  }

  const mcp = worker(plan, "gatekeepers.mcp");
  if (!mcp.compatibilityFlags.includes("global_fetch_strictly_public")) {
    throw new Error("mcp is missing global_fetch_strictly_public");
  }
  sameClasses(mcp.migrations[0]?.newSqliteClasses ?? [], ["McpAccount", "McpGatekeeperImpl"], "mcp v0");

  const router = worker(plan, "router");
  if (!router.routes.includes("cloudflareos.apphub.work")) throw new Error("router custom domain missing");
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const plan = await buildProductionPlan();
  console.log(JSON.stringify(plan, null, 2));
  assertProductionPlan(plan);
}
