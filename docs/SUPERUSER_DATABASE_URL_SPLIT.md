# Keeping the superuser `DATABASE_URL` out of the running backend (B0-OPS-03)

## Why

The backend container reads `/opt/atlas/.env` through `env_file`. That file
holds `DATABASE_URL`, the connection Prisma's CLI uses for migrations. It is
a superuser connection, so row-level security does not apply to it. The
running application never uses it: `PrismaService` connects only with
`APP_DATABASE_URL` (the `atlas_app` role, RLS applies). Anyone who can read
the backend process's environment can also read a connection that bypasses
every tenant-isolation policy.

## What the code does now

- `DATABASE_URL` is **optional** at boot; `APP_DATABASE_URL` stays required.
- `deploy.sh` loads `/opt/atlas/.env.migrate` after `.env` **when it exists**.
  Migrations get `DATABASE_URL` explicitly (`docker compose run -e
  DATABASE_URL=… backend npx prisma migrate deploy`), so they work from
  either file.
- The deploy workflow never writes `DATABASE_URL` into `.env`, so it cannot
  undo the split.

Nothing changes until the host is changed. Until then, `DATABASE_URL` stays
in `.env` and everything works as before.

## Host steps (owner, after this code is deployed)

Run on the VPS as the deploy user, from `/opt/atlas`. Never print the value.

1. Take a backup first: `bash /opt/atlas/backup.sh`.
2. Move the line into its own file, readable only by the deploy user:

   ```bash
   cd /opt/atlas
   umask 077
   grep -E '^DATABASE_URL=' .env > .env.migrate
   test -s .env.migrate && sed -i '/^DATABASE_URL=/d' .env
   ls -l .env.migrate          # -rw------- deploy deploy
   grep -c '^DATABASE_URL=' .env   # 0
   ```

3. Recreate only the backend so its environment no longer carries the
   variable: `docker compose up -d --force-recreate --no-deps backend`.
4. Verify:
   - `docker compose exec -T backend sh -c 'test -z "$DATABASE_URL" && echo absent'` prints `absent`;
   - `docker compose ps backend` shows it healthy (the container healthcheck hits `/health`), and one sign-in works;
   - the next deploy with a pending migration applies it. To check without
     one, `bash deploy.sh --preflight` must still read the migration state.

## Operator scripts

Scripts that need the superuser connection take it explicitly, and each one
refuses to run without it:

```bash
set -a; . /opt/atlas/.env.migrate; set +a
docker compose exec -T -e DATABASE_URL="$DATABASE_URL" backend node dist/scripts/provision-platform-owner.js …
```

**Known dependency:** `deploy/ledger-backfill/remote.sh` (the one-off
customer-ledger backfill workflow) runs `docker compose exec backend node
dist/scripts/backfill-customer-ledgers.js` and relies on `DATABASE_URL` being in
the backend's own environment. After the split, that helper fails closed: the
script refuses to run without the variable. Run the split only once that
backfill is no longer needed, or pass `-e DATABASE_URL=…` as above.

## Rolling back

Append the line back to `.env` and recreate the backend:

```bash
cat .env.migrate >> .env
docker compose up -d --force-recreate --no-deps backend
```
