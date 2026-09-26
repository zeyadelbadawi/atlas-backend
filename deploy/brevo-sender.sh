#!/usr/bin/env bash
# Atlas — ensure the platform sender exists in Brevo on the authenticated
# sending domain. Brevo API only (no DNS). Run ON the VPS by the
# `Brevo sender` workflow over the restricted deploy identity (stdin).
#
#   brevo-sender.sh <sender-email>
#
# Refuses unless the sender's domain is authenticated in Brevo. Uses
# BREVO_API_KEY / EMAIL_FROM_NAME from the backend container's environment
# and never prints the key.
set -uo pipefail
cd /opt/atlas
sender=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')
printf '%s' "$sender" | grep -Eq '^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$' || { echo "bad sender address" >&2; exit 2; }

docker compose exec -T backend node -e '
const sender = process.argv[1];
const domain = sender.split("@")[1];
const key = process.env.BREVO_API_KEY;
if (!key) { console.log("FAIL  BREVO_API_KEY not configured"); process.exit(1); }
const brevo = async (method, p, body) => {
  const r = await fetch("https://api.brevo.com/v3" + p, { method, headers: { "api-key": key, accept: "application/json", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, json: j };
};
(async () => {
  const d = await brevo("GET", "/senders/domains/" + encodeURIComponent(domain));
  const auth = d.json && d.json.authenticated, ver = d.json && d.json.verified;
  console.log("INFO  domain " + domain + ": verified=" + ver + " authenticated=" + auth);
  if (!auth) { console.log("FAIL  domain is not authenticated in Brevo; not creating a sender"); process.exit(1); }
  const list = await brevo("GET", "/senders");
  let s = ((list.json && list.json.senders) || []).find((x) => String(x.email).toLowerCase() === sender);
  if (s) console.log("OK    sender present:", sender, "id=" + s.id, "active=" + s.active);
  else {
    const c = await brevo("POST", "/senders", { name: process.env.EMAIL_FROM_NAME || "Atlas", email: sender });
    console.log(c.status < 300 ? "DONE  sender created:" : "FAIL  sender create:", sender, "->", c.status, (c.json && c.json.message) || "");
    if (c.status >= 300) process.exit(1);
    const again = await brevo("GET", "/senders");
    s = ((again.json && again.json.senders) || []).find((x) => String(x.email).toLowerCase() === sender);
    console.log("INFO  sender now:", sender, "active=" + (s && s.active));
  }
  const current = (process.env.EMAIL_FROM_EMAIL || "").toLowerCase();
  console.log("INFO  running backend sends as:", current.replace(/^(.{0,3})[^@]*@/, "$1***@"), current === sender ? "(already this sender)" : "(NOT yet this sender — EMAIL_FROM_EMAIL must be updated)");
})().catch((e) => { console.log("FAIL ", e.message); process.exit(1); });
' "$sender"
