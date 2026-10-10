# Atlas backend — where the handover lives

> **Current handover (10 Oct 2026), covering both repositories:**
> `atlas/ATLAS_FULL_PROJECT_HANDOVER_2026-10-10.md`
> (GitHub: <https://github.com/zeyadelbadawi/atlas/blob/main/ATLAS_FULL_PROJECT_HANDOVER_2026-10-10.md>).
>
> It supersedes every earlier handover, including `atlas/ATLAS_HANDOVER.md`,
> `atlas/NEW_HANDOVER.md` and the handover/state files under `docs/` and
> `Reports/` here. Those are kept as history only.

The handover is kept in one place on purpose. Atlas is two repositories deployed
to one VPS, and splitting the handover would guarantee the two halves drift apart.

A machine-local companion, `ATLAS_HANDOVER_SECRETS.local.md`, records credential
*locations* only. It is gitignored in both repos and must never be committed.
