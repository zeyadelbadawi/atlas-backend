# Refresh-token lost-response recovery (U-14d / OD-21)

Status: implemented on `b0d/refresh-be` (backend) and `b0d/refresh-fe` (frontend).
Config: `REFRESH_REISSUE_WINDOW_SECONDS` (default 30, allowed 0–30, `0` turns recovery off).

## 1. The failure

A browser refresh is `POST /auth/refresh`. The refresh token travels only in the
`__Host-atlas_session` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, Origin
checked; `session-cookie.ts`). Every refresh rotates the token:
`RefreshTokensRepository.rotate` revokes the presented row and inserts a
successor in the same family (`session_id`), in one transaction, using a
conditional `UPDATE … WHERE revoked_at IS NULL` as the compare-and-swap.

When the server committed the rotation but the response never reached the
browser (connection dropped, tab closed, timeout, a 5xx from the edge after the
commit), the browser still held the retired token. On its next attempt:

- within 60 s of the rotation (`REFRESH_REUSE_GRACE_MS`), the server answered
  `401` (`SupersededRefreshTokenException`, cookie kept). The browser has no
  newer cookie, so the frontend treated the 401 as a definitive refusal and
  ended the session in every tab;
- after 60 s, `findReusedRotation` classified the token as **reuse**. The whole
  family was revoked, the session ids were denylisted, and an
  `auth.sessions.revoked` audit row (`trigger: refresh_token_reuse`) was written.

The person was signed out either way. Before this change the frontend also did
not retry a failed refresh: `POST` is not replay-safe in `http-client.ts`, and
the timeout was 30 s.

## 2. The design

The frontend fix alone (one refresh at a time in each tab, plus a cross-tab
lock) cannot close the gap. Both were already in place:

- each tab runs at most one refresh (`sessionService.refresh` `refreshInFlight`,
  and the interceptor's `refreshPromise`);
- tabs take turns through the Web Locks API (`atlas:session-refresh`).

Neither helps when the one response that carried the new cookie is lost. The
fix is therefore **idempotent rotation for the same browser, for a short
window**. Re-issue means handing back the SAME successor. The server never mints
a new token for a retry.

### 2.1 Mechanism

On every cookie rotation of A into its successor S, inside the rotation
transaction and before it commits, `RefreshReissueService.remember` writes one
Redis key, `refresh:reissue:<sha256(A)>`, with TTL equal to the window. It holds:

- S, encrypted with AES-256-GCM under `HKDF-SHA256(raw A)`. Only a caller that
  presents raw A can decrypt it. The database stores only SHA-256(A), so a read
  of Redis, of Postgres, or of both yields no usable token;
- a SHA-256 digest of the client that rotated: transport (`cookie`),
  `User-Agent`, the `atlas_device` cookie, and the host. The digest is bound into
  the ciphertext as AAD, so it cannot be swapped.

When a later refresh with A fails to rotate (A is already revoked),
`AuthService.recoverLostRefresh`:

1. reads the record. A missing record, a Redis error, or no answer within
   250 ms all mean no recovery (fail closed);
2. decrypts it with the presented token. If decryption fails, the record is
   ignored;
3. compares the client digest. A mismatch is **foreign**: the family is revoked
   at once, as reuse (see 2.3);
4. confirms in Postgres, in the owner's RLS context
   (`findReissuableSuccessor`), that:
   - A was retired at most `window` seconds ago;
   - exactly one row of the family is newer than A, so S has never been
     rotated;
   - that row is S;
   - S is unrevoked and unexpired;
5. checks that the account is still `active`. If it is not, the family is
   revoked and the request gets a 401, the same as a normal rotation;
6. answers with the same S (the interceptor puts it in the cookie) and a fresh
   access token for the same `sid`. The log event is `auth.refresh.reissued` and
   the metric is `atlas_auth_refresh_reissued_total`.

Re-issue writes nothing to `refresh_tokens`.

### 2.2 Frontend

`sessionService.refresh` retries an ambiguous failure (network error, timeout,
5xx, 429) after 500 ms and again after 1 500 ms. Each `POST /auth/refresh`
attempt is capped at 8 s (`REFRESH_TIMEOUT_MS`), so every attempt starts within
about 18 s of the first, inside the 30 s window. All attempts run under the same
cross-tab lock.

A 401 or 403 is final when Web Locks exist. Without them it is retried once
after 400 ms, as before. A pre-cookie localStorage token is presented once and
never retried.

### 2.3 What still revokes, and what is refused

| Presentation of a retired token A | Result |
|---|---|
| Same browser, within the window, S never used, family live, account active | **S re-issued**, nothing minted, nothing revoked |
| Within the window, **different client** (User-Agent, device cookie, host), or the cookie token sent in a request **body** | **Family revoked at once** (reuse audit, log `reason: foreign_client`) |
| S already used (rotated onward) | Never re-issued. Within the 60 s grace: 401, cookie kept (unchanged). After it: family revoked (unchanged) |
| After the window but within the 60 s grace | Never re-issued. 401, cookie kept (unchanged) |
| After the 60 s grace | Family revoked (unchanged) |
| Family already revoked (sign-out, password change or reset, revoked device session, academy block, reuse, absolute cap) | Never re-issued. The same 401 as before |
| Account no longer `active` | Never re-issued. Family revoked and 401 |
| Legacy body token, any time | Never re-issued (unchanged path) |
| Redis down or slow | No recovery. Behaviour is exactly as before this change |

## 3. Security properties

1. **No token becomes reusable indefinitely.** A retired token is honoured only
   for `≤ 30 s` after its rotation, a ceiling enforced in `env.validation.ts` and
   clamped again in code. It is honoured only while its direct successor is
   unused, and only by handing back that successor.
2. **The chain never forks.** Re-issue is read-only on `refresh_tokens`. Rotation
   itself is unchanged: one conditional `UPDATE` claims the presented row inside
   a transaction, so of N concurrent requests exactly one mints S. The others are
   answered with the same S (`auth-refresh-lost-response` LR-06) or, without a
   record, refused as before (`auth-refresh-concurrency`, body path).
3. **Replay detection is preserved and, within the window, stronger.** Once
   either holder uses S, the other holder's copy (A or S) is outside the
   re-issue rules, and its next presentation after the grace revokes the family,
   exactly as before. A copy of A replayed from another client inside the window
   now revokes immediately. Before, it was a silent 401 for 60 s.
4. **A revoked family stays dead.** The re-issue check requires S to be live in
   Postgres, the durable source of truth, never Redis.
5. **No new secret at rest.** The record can be opened only with the raw token
   it protects. Losing Redis yields ciphertext and digests only.
6. **Fail-closed availability.** Redis trouble disables recovery and never
   blocks a rotation. The write is bounded to 250 ms inside the transaction.

## 4. Residual risks

- **A thief who copies A and replays it from the same User-Agent and device
  cookie within ≤ 30 s of the legitimate rotation receives S.** This is the
  same position as stealing A before the rotation. Detection is unchanged: the
  first holder to use S makes the other holder's next refresh a replay, and
  their access token lives at most `JWT_ACCESS_TTL_SECONDS` (15 min). The
  binding is an observation of the client, not proof of possession: an
  infostealer that copies the whole cookie jar and the User-Agent passes it.
  The short window is what limits the exposure.
- **Lost response, then no network for longer than the window.** Examples are
  closing the laptop lid during the refresh, or the 30 s cap being exceeded. The
  next attempt finds A outside the window. It gets a 401 within 60 s, and the
  family is revoked after that. This failure is narrower than before but still
  possible. Extending the window is the owner decision in §5.
- **Delayed duplicate after a later rotation.** A request that was abandoned
  client-side but delivered late, after S was already rotated onward, is refused
  (401 within the grace). It is not re-issued and does not revoke. The browser's
  cookie is unaffected because nobody reads that response.
- **Stale cookie ordering.** If two responses carrying S and S′ arrive out of
  order and the browser keeps S after S′ was minted from it, the next refresh
  presents S within the window and is re-issued S′. This is self-healing.
- **Browsers without Web Locks** can still send overlapping refreshes from
  different tabs. Within the window those are now answered with S instead of a
  401.

## 5. Owner decision (OD-21 follow-up, only if wanted)

> The recovery window is capped at 30 s. A lost refresh response is recovered
> only if the browser retries within 30 s of the rotation. The frontend retries
> after 0.5 s and 1.5 s with 8 s timeouts. A device that goes offline exactly
> during a refresh and comes back later is signed out, as before. Options:
> (A) keep the 30 s cap (recommended; no change to the threat model);
> (B) raise the cap to at most 120 s, which widens the copied-token window in
> §4 proportionally; (C) bind re-issue to a proof-of-possession key (a
> non-extractable WebCrypto key per session, with a signed refresh request).
> Option C removes the copied-cookie risk entirely but is a new subsystem and
> needs a schema change and a frontend key store.

## 6. Tests

- `test/auth-refresh-lost-response.e2e-spec.ts` covers LR-01 to LR-07: normal
  rotation, lost-response recovery, successor already used, foreign client
  (User-Agent, device cookie, body), after the window, concurrent duplicates
  (exactly one chain), and sign-out, password change or suspension not undone.
- `test/session-cookie.e2e-spec.ts` SC-07 was updated. The race loser now
  receives the same newer cookie. The stale-tab 401 (cookie kept) is still
  asserted, now just outside the window.
- `src/identity/services/refresh-reissue.service.spec.ts` covers the record:
  confidentiality, binding, tamper resistance, and failing closed on Redis
  trouble.
- `src/config/env.validation.spec.ts` checks the 0–30 ceiling.
- Frontend: `src/services/identity/session-refresh-lost-response.test.ts`
  covers prompt retries, the bounded schedule inside the window, no retry of a
  refusal, one lock for all attempts, and two tabs never overlapping.
