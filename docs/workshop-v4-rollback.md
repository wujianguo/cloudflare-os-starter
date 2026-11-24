# Workshop v4 rollback boundary

This is the release constraint for the pinned upgrade. It does not authorize a deploy.

Production Workshop is on migration tag `v3`. The generated plan adds `v4` with `new_sqlite_classes: ["AdminAuditDurableObject"]` and keeps v0–v3. GitHub is on `v1` (`GitHubHookDriver`) and the generated plan does not add a later tag.

Cloudflare's rollback rule: a rollback is refused when a Durable Object class lifecycle change, through `exports` or the legacy `migrations` array, happened between the active deployment and the selected version. Resources and stored data are not restored by a version rollback. See [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) and [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## After v4 has been applied

`wrangler rollback` to the current Workshop version, or to any older Workshop version, is not a credible route. Those versions do not contain the v4 lifecycle change. Keeping their version IDs does not make the upgrade reversible.

The forward fix is a new Workshop upload that:

- still lists migrations v0, v1, v2, v3, and v4 unchanged
- still exports `AdminAuditDurableObject` (`packages/workshop-backend/src/server.ts`)
- does not add `deleted_classes` or `renamed_classes` for that class

That keeps the v4 SQLite namespace and any rows already written. It changes code only. It does not return the Worker to tag v3.

## What a version rollback can still target

Only a Worker whose new upload does not change its migration history can be pointed back at its current 100% version. That is the Router and Error Reporter, which have no migration, and Context, Scheduler, MCP, and GitHub if their tags stay v0, v1, v0, and v1. The GitHub target is the current v1 version, not an older upload. An older GitHub version may be v0, and this upgrade must not select one. Version details that include bindings were not read, so no other historical version ID is a rollback target.

Do not delete Workers, namespaces, KV, or R2 as a rollback step.
