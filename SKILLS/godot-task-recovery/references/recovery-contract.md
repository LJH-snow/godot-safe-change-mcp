# Task Recovery Contract

## Persisted evidence

Task state lives under the project task directory used by the existing
FileTaskStore. Every step has an operation ID and timeline events for running,
succeeded, failed, paused, cancelled, and interrupted attempts. Lease events
include acquire, renew, renewal failure, release, reclaim, and recovery.

## Lease outcomes

| Situation | Required state/evidence |
| --- | --- |
| First acquisition | Record owner ID, lease ID, expiry, and lease_acquired. |
| Normal heartbeat | Extend expiry and record lease_renewed. |
| Renewal failure | Stop heartbeat, record lease_renew_failed, pause the task, keep it recoverable. |
| Same owner with valid lease | Allow resume and record lease_recovered. |
| Expired or missing lease | Reclaim only after ownership checks; record previous owner, new owner, and lease_expired or lease_missing. |
| Replaced lease | Reject the old owner and record lease_replaced. |
| Release or terminal task | Stop heartbeat and record lease_released. |

## Step recovery

An old running step is not silently discarded. Write step_interrupted with its
old operation ID, then retry with a new operation ID. Keep the old attempt
queryable through task_timeline. A live same-coordinator advance is a conflict
and must return PROJECT_BUSY rather than creating a second attempt.

## FileTaskStore invariant

For one task target, saves are serialized in request order. Each save uses a
unique temporary filename before an atomic rename; failed saves remove their
temporary file. This prevents one heartbeat or transition from renaming away
another writer's shared temporary file.
