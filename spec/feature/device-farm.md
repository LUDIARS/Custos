# Self-hosted device farm

## Product scope

Custos manages a pool of owned Android and iOS **physical devices** attached to registered hosts. A user reserves a device for manual investigation or a test job. Both modes must eventually use the same reservation authority. Cloud device providers are outside this implementation.

This first slice implements the **control-plane API**: configured inventory, host observations, durable leases, and cleanup barriers. It does not yet launch a mobile application, discover a USB device, run Appium/ADB, stream a mobile screen, execute a test job, or provide a device-farm UI. No simulated device is advertised as connected by default. Integration with real host workers is required before physical-device acceptance.

## Architecture and ownership

- `src/farm/schema.ts`: validated configuration, stored state, request contracts.
- `src/farm/store.ts`: atomic local-file transactions under an exclusive lock.
- `src/farm/lifecycle.ts`: fencing and availability transitions.
- `src/farm/pool.ts`: reservation authority and inventory observations.
- `src/farm/host-auth.ts`: one credential per registered host.
- `src/farm/runtime.ts`: explicit opt-in configuration and startup validation.
- `src/routes/farm-routes.ts`: HTTP input validation and authorization boundary.

No subprocess, socket, periodic timer, or physical-device action is created by the pool. The existing desktop/Unity execution model is separate. Farm workers and mobile execution must join this authority before enabling manual or automated device actions. Registering the same physical device in an independent direct-input path would bypass exclusivity and is unsupported.

The file store is intended for a small, single-machine coordinator with up to 1,000 registered devices. The two existing HTTP listeners share one pool. Concurrent local processes using identical configuration and the same state path serialize via `open(..., "wx")`; a contending request receives 503 and may retry. Multiple machines must call the same coordinator API, not each maintain independent copies of its state. Network filesystems and multiple replicas with divergent configuration are unsupported. JSON persistence is synchronous and intentionally bounded by the inventory size; migrate to a transactional database before increasing scale.

## Provisioning

1. Copy `config/farm.example.json` to an operator-owned configuration file. Replace all serial/UDID, model and OS placeholders with real inventory. Keep device IDs and `(platform, serial)` identities unique across hosts.
2. Supply a distinct random bearer token (32–512 non-whitespace characters) in the environment variable named by each host's `tokenEnv`. Provision the same credential to that host through the normal secret-management channel. Do not put tokens in configuration, commits, URLs or logs.
3. Create a separate, local, operator-owned state file **once**, containing `{"version":1,"devices":{}}`. Preserve this file across deployments and restarts. Do not overwrite a populated state file as part of startup or recovery.
4. Set `CUSTOS_FARM_CONFIG` and `CUSTOS_FARM_STATE_FILE` to those absolute paths. The parent directory must exist and allow state-file replacement and `.lock`/`.pending` creation. On Windows the directory ACL is the effective access boundary.
5. Configure genuine Cernere user verification through `CERNERE_URL`. Farm startup rejects `CUSTOS_OPEN=1` and missing Cernere configuration, because anonymous/stub identities cannot distinguish reservation owners.
6. Use the normal Excubitor deployment workflow from the project root. This change does not start or restart services. Connections crossing machines must use the deployment's authenticated, protected network transport (for example TLS via its existing gateway); this API does not configure network exposure.

With `CUSTOS_FARM_CONFIG` absent, farm routes are not mounted. An explicitly empty/invalid setting is an error. Missing credentials, missing/corrupt state, or invalid inventory fail startup instead of creating a usable-looking empty farm. Additional devices may be registered by updating configuration and restarting normally. Removing devices or changing a registered device's host/platform/serial requires an explicit state migration after leases and physical work have stopped; accidental identity changes fail closed. Tokens rotate on a normal configuration reload/restart; they are never saved to the state file.

## HTTP API

Paths below are relative to `/api/farm`. User routes use `Authorization: Bearer <Cernere access token>`. Owner identity comes exclusively from verification, never from a submitted `ownerId`.

| Method | Path | Request / behavior |
|---|---|---|
| GET | `/devices` | Inventory, platform/model/OS/tags/host, availability, last observation and current lease |
| POST | `/devices/:id/lease` | `{ "ttlSec": 60 }`; 201 with the reserved device and lease |
| POST | `/devices/:id/lease/renew` | `{ "leaseId": "<uuid>", "ttlSec": 60 }`; same owner and live lease required |
| POST | `/devices/:id/lease/release` | `{ "leaseId": "<uuid>" }`; same owner required, transitions to cleanup |
| POST | `/hosts/:hostId/report` | Host-specific bearer credential; full inventory report, returns that host's device states |

Lease TTL is an integer from 10 to 1,800 seconds. Responses use UTC ISO timestamps. The internal persisted timestamps are UTC epoch milliseconds. Host heartbeat timeout is configured from 10 to 300 seconds (default 60). Reports should normally arrive at less than half that interval. Expiry is evaluated transactionally on every pool request, including host reports; no timer is required. A lost acquire response leaves an actual reservation, visible through GET; a retry receives a conflict until the owner discovers/releases it or it expires. Release is not silently idempotent: a replay returns `stale_lease` and cannot affect a newer owner.

Example host report (IDs must match its full configured inventory exactly):

```json
{
  "devices": [
    { "id": "android-01", "connected": true }
  ]
}
```

A report without `readyGeneration` only reports connectivity. The returned `generation` is an epoch used to fence old work. To make a device ready, the worker must first ensure previous execution/input has stopped and complete cleanup, then send the exact returned generation as `readyGeneration`. A stale acknowledgement is ignored. This field is a trusted worker's assertion, not proof that this initial API implementation has performed cleanup.

Response availability values:

- `offline`: unreported, disconnected or host observation expired.
- `cleanup`: connected, but cleanup for the current generation is unconfirmed.
- `available`: connected, fresh, cleanup acknowledged, no live lease.
- `leased`: connected, with a live reservation.

Failures include 400 for invalid requests/inventory, 401 for missing/invalid authentication, 403 for another owner's lease, 404 for an unknown device, 409 for unavailable devices/stale lease IDs, 413 for excessive request bodies, and 503 for locked/unavailable/corrupt persistence. State-file validation failures are storage errors, not client JSON errors. Error responses omit paths, tokens and submitted bodies.

## Fencing and recovery

Every acquisition increments a durable per-device generation. Release, lease expiry, disconnect and heartbeat timeout also increment it, revoke the old lease, and require cleanup. Mere reconnection or a delayed heartbeat cannot authorize reassignment. An active lease ignores readiness acknowledgements. Any future device command must contain the lease ID and generation and be checked by the host against its last authoritative state and expiry time.

Workers must independently stop injecting input and stop the test process on lease expiration or coordinator connectivity loss; the central pool cannot physically stop a disconnected host. They must not treat a renewed TTL as effective until receiving the coordinator response. Generation changes require terminating old work before acknowledging readiness. iOS and Android workers must implement these same rules before physical-device testing is enabled.

Persistence uses UTF-8 JSON, a `.lock` file opened exclusively, and a sibling `.pending` file which is written and fsynced before rename. It returns success only after commit. This protects against concurrent reservations and ordinary process interruption. It does not claim a database's power-loss guarantees: directory durability/rename behavior depend on the local OS and filesystem. A crash may leave `.lock` or `.pending`; startup/requests fail closed rather than deleting another writer's evidence. Recovery requires confirming all coordinator writers are stopped, inspecting the state and pending file, retaining the correct committed reservations, and stopping/cleaning affected device work before removing residue. Do not automatically age out locks or reset generations.

Inventory and reservations survive coordinator restart. A still-valid lease remains owned; expired connectivity or lease deadlines fence it on the next transaction. The same state file must be retained; restoring an old backup while devices are active is unsupported. Physical recovery and deliberate migrations belong to the deployment workflow.

## Validation and remaining work

`tests/farm-*.test.ts` cover exclusivity across independent pool instances sharing a file, owner checks, expiry, delayed readiness, disconnect, timeout after restart, invalid inventory, persistent-state failures and host credential separation. They also cover exact-list and subpath authentication, invalid client JSON versus corrupt server state, and failed acquisition commits. They are intended for Revisor's test execution; physical-device behavior is not covered by these tests.

Tracked follow-ups and physical acceptance are in `spec/tasks/2026-09-11-self-hosted-device-farm.md`: host workers, job scheduling, manual control, evidence storage, and Android/iOS real-device runs. The deployed API and device workflows are not claimed as verified by this first slice.
