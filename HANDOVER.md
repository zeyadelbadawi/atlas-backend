# Atlas backend — where the handover lives

The complete, current project handover for **both** Atlas repositories is:

> `atlas-front/ATLAS_HANDOVER.md`
> (GitHub: <https://github.com/zeyadelbadawi/atlas/blob/main/ATLAS_HANDOVER.md>)

It is kept in one place on purpose. Atlas is two repositories deployed to one
VPS by one script, and splitting the handover would guarantee the two halves
drift apart.

Read it before changing anything here. In particular it covers:

- the dual tenancy model (application guards **and** PostgreSQL RLS) and why
  both must stay;
- why media is served by this backend rather than directly from R2;
- why `expectedVersion` is required on CMS page updates;
- the real deploy flow (GHCR image → SSH → `/opt/atlas/deploy.sh` → Prisma
  migrate → health check) and the fact that **deploy is not gated on CI**;
- which backend e2e failures are pre-existing, and the shared-database test
  interference that causes most of them;
- where credentials live — `.env` here, `/opt/atlas/.env` in production,
  GitHub Actions secrets for deployment. No values are in any tracked file.

A machine-local companion, `ATLAS_HANDOVER_SECRETS.local.md`, records credential
*locations* only. It is gitignored in both repos and must never be committed.
