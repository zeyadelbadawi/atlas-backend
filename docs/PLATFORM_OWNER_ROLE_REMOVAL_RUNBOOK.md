# Removing the Platform Owner role (B0-OC-01)

**Tool:** `src/scripts/remove-platform-owner-role.ts`, built to `dist/scripts/remove-platform-owner-role.js`.
**Rules:** `src/identity/services/platform-owner-role-removal.ts`.
**Tests:** `test/platform-owner-role-removal.e2e-spec.ts`.

The tool retires **unused, unsecured** Platform Owner accounts. It removes the role and nothing else. After that the account is an ordinary user, and it can be deleted through **Platform → Users** like any other user (the product refuses to delete a Platform Owner).

## What it refuses (checked in the dry run and again inside the write transaction)

| Refusal | Why |
|---|---|
| `actor_not_platform_owner`, `actor_not_active`, `actor_without_confirmed_totp` | The person removing the role must be an active, secured Platform Owner |
| `target_is_actor` | Never your own account |
| `target_has_confirmed_totp` | Never a secured account, so the retained owner can't be removed by mistake |
| `target_not_platform_owner`, `target_not_found`, `invalid_id`, `duplicate_target`, `no_targets` | Exact ids only, never emails |
| `would_leave_no_secured_platform_owner` | At least one active Platform Owner with a confirmed authenticator must remain |

## What applying changes (one transaction)

1. `users.is_platform_owner = false` for each target.
2. Every unrevoked refresh session of each target is set to `revoked_at = now()`.
3. One `audit_log_entries` row per target:
   - action `platform_owner.role_removed_by_operator`;
   - actor = the operator;
   - context: reason, whether an authenticator was confirmed, number of owned organizations.

After commit, the revoked sessions' access tokens are denylisted in Redis. This is best-effort: Platform access already ended with the role, because `PlatformOwnerGuard` reads the role from the database on every request.

Nothing is deleted:
- the account, its password, its organizations, memberships and audit history stay as they are;
- an owned organization keeps its owner.

The script does **not** boot the application, so no scheduler or queue worker runs inside it.

## Procedure

Each production step needs the owner's written approval of the exact ids.

1. **Ship the tool.** Merge it and deploy it in a normal release. Until then `dist/scripts/remove-platform-owner-role.js` does not exist in the production image.
2. **Backup.** Run `deploy/backup.sh` and confirm `backup verified`.
3. **Dry run.** On the VPS, from `/opt/atlas`:
   ```
   docker compose exec -T \
     -e ROLE_REMOVAL_ACTOR_ID=<retained secured owner uuid> \
     -e ROLE_REMOVAL_USER_IDS=<uuid>,<uuid>,<uuid> \
     -e ROLE_REMOVAL_REASON="B0-OC-01: unused, unenrolled Platform Owner accounts" \
     backend node dist/scripts/remove-platform-owner-role.js
   ```
   The output must end with `DRY RUN: nothing was changed.` and show `"refusals": []`. Read every target's facts: `liveSessions`, `auditRowsAsActor`, `ownedOrganizations`.

   After the superuser-URL split (B0-OPS-03), `DATABASE_URL` is no longer in the backend's environment. Add `-e DATABASE_URL=...` from `/opt/atlas/.env.migrate`, as the OPS-03 runbook describes for operator scripts.
4. **Apply.** Same command, plus:

   `-e ROLE_REMOVAL_APPLY=yes -e ROLE_REMOVAL_CONFIRM=remove-platform-owner-role:<count>`

   Expect `{"applied":true,"removed":[...],"sessionsRevoked":{...}}`.
5. **Verify** with Release verify (`owners`, read-only):
   - Platform Owner count is now the retained number;
   - every remaining owner shows `totp-confirmed`;
   - the removed accounts no longer appear;
   - Platform → Audit log shows one `platform_owner.role_removed_by_operator` per target.
6. **Optional: delete** each account through Platform → Users. The dialog shows the deletion plan. This is a separate approval.

## Rollback and recovery

- **Undo the role removal** (owner connection, after a fresh backup), per account:
  ```sql
  UPDATE users SET is_platform_owner = true WHERE id = '<uuid>' AND is_platform_owner = false;
  ```
  Sessions stay revoked; the person signs in again. The audit row stays, as history. Add an explanatory audit note in the ticket.
- **If the transaction failed:** nothing changed. The write is one transaction and refuses as a whole.
- **If the retained owner is locked out afterwards** (phone and recovery codes lost): there is no second Platform Owner to run the audited reset (`docs/TWO_FACTOR_LOCKOUT_RECOVERY.md`), so provision a new Platform Owner with `provision-platform-owner.ts` on the VPS. Keeping a second enrolled Platform Owner avoids this.
- **Full restore** (last resort): restore the pre-change backup per the restore runbook. This loses every write made since the backup.
