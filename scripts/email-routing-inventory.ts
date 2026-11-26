import assert from "node:assert/strict";

const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Repository Actions secret CLOUDFLARE_API_TOKEN is required.");
const accountId = "18503a03d3ee1fd75ac41f76c8d155b4";
const hostname = "cloudflareos.apphub.work";

/** Reads metadata only; error output excludes response bodies and authentication. */
async function read<T>(path: string): Promise<T | undefined> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ path, status: response.status }));
    return undefined;
  }
  const body = await response.json() as { success: boolean; result: T };
  assert.equal(body.success, true, `Metadata read failed: ${path}`);
  return body.result;
}

type Rule = {
  id?: string;
  enabled?: boolean;
  matchers?: { type: string; field?: string; value?: string }[];
  actions?: { type: string; value?: string[] }[];
};

/** Do not expose mailbox names, forwarded recipient addresses, or rule descriptions in CI logs. */
function summarizeRule(rule: Rule) {
  return {
    id: rule.id,
    enabled: rule.enabled,
    matchers: rule.matchers?.map((matcher) => ({
      type: matcher.type,
      field: matcher.field,
      domain: matcher.value?.includes("@") ? matcher.value.split("@").at(-1) : undefined,
      matchesRequestedHostname: matcher.value?.endsWith(`@${hostname}`) ?? false,
    })),
    actions: rule.actions?.map((action) => ({
      type: action.type,
      workers: action.type === "worker" ? action.value : undefined,
    })),
  };
}

const zones = await read<{ id: string; name: string; status: string }[]>(`/zones?account.id=${accountId}&name=apphub.work`);
assert.ok(zones, "Cannot inspect the zone with the current deployment token.");
assert.equal(zones.length, 1, "Expected the existing apphub.work zone in the deployment account.");
const zone = zones[0];
console.log(JSON.stringify({ zone: zone.name, status: zone.status }));
const settings = await read<{ enabled?: boolean; status?: string; name?: string }>(`/zones/${zone.id}/email/routing`);
console.log(JSON.stringify({ emailRouting: settings && { enabled: settings.enabled, status: settings.status, name: settings.name } }));
const records = await read<{ type: string; name: string; content: string; proxied?: boolean }[]>(`/zones/${zone.id}/dns_records?name=${hostname}&per_page=100`);
console.log(JSON.stringify({ hostnameDns: records?.map((record) => ({
  type: record.type,
  name: record.name,
  mailServer: record.type === "MX" ? record.content : undefined,
  cloudflareSpf: record.type === "TXT" ? record.content.includes("_spf.mx.cloudflare.net") : undefined,
  proxied: record.proxied,
})) }));
const catchAll = await read<Rule>(`/zones/${zone.id}/email/routing/rules/catch_all`);
console.log(JSON.stringify({ catchAll: catchAll && summarizeRule(catchAll) }));
for (let page = 1; ; page++) {
  const rules = await read<Rule[]>(`/zones/${zone.id}/email/routing/rules?per_page=50&page=${page}`);
  if (!rules) break;
  console.log(JSON.stringify({ rules: rules.map(summarizeRule) }));
  if (rules.length < 50) break;
}
const workers = await read<{ id: string; handlers?: string[] }[]>(`/accounts/${accountId}/workers/scripts`);
console.log(JSON.stringify({ emailWorkers: workers?.filter((worker) => worker.handlers?.includes("email") || /email|mail/.test(worker.id)).map((worker) => ({ name: worker.id, handlers: worker.handlers })) }));
console.log("Read-only inventory complete. No DNS, routing rules, or Workers were changed.");
