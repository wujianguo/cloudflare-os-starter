import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionPlan, buildProductionPlan } from "./print-deployment-plan.ts";

test("the generated production plan keeps Workshop v0-v4 and the seven Workers", async () => {
  const plan = await buildProductionPlan();
  assert.doesNotThrow(() => assertProductionPlan(plan));
  const encoded = JSON.stringify(plan);
  assert.equal(encoded.includes("CF_ACCESS_ISS"), false);
  assert.equal(encoded.includes("GATEKEEPER_WEBSEARCH"), false);
  assert.equal(encoded.includes("GATEKEEPER_CUSTOM"), false);
  assert.equal(plan.workers.find((worker) => worker.id === "workshop")!.migrations.at(-1)!.newSqliteClasses[0],
    "AdminAuditDurableObject");
});
