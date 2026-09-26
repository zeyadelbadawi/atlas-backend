#!/usr/bin/env bash
# Atlas — authenticate the platform's sending domain in Brevo (SPF, DKIM,
# DMARC, Brevo ownership code) using the platform's own Cloudflare zone.
# Run ON the VPS by the `Email domain setup` workflow over the restricted
# deploy identity (stdin, like onboarding-verify.sh).
#
#   email-domain-setup.sh plan  <domain>   read-only: what exists, what is missing
#   email-domain-setup.sh apply <domain>   register in Brevo, ADD missing DNS
#                                          records, ask Brevo to authenticate
#
# ADDITIVE ONLY: it never deletes or edits an existing DNS record. If a
# record of the same name/type already exists with other content it is
# reported and left alone. Uses BREVO_API_KEY / CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ZONE_ID from the backend container's environment and never
# prints them.
set -uo pipefail
cd /opt/atlas

mode="${1:-plan}"; domain=$(printf '%s' "${2:-}" | tr 'A-Z' 'a-z')
case "$mode" in plan|apply) ;; *) echo "mode must be plan or apply" >&2; exit 2 ;; esac
if ! printf '%s' "$domain" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$'; then echo "bad domain" >&2; exit 2; fi

docker compose exec -T backend node -e '
const [mode, domain] = process.argv.slice(1);
const bk = process.env.BREVO_API_KEY, ct = process.env.CLOUDFLARE_API_TOKEN, zid = process.env.CLOUDFLARE_ZONE_ID;
if (!bk || !ct || !zid) { console.log("FAIL  missing BREVO_API_KEY / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID"); process.exit(1); }
const brevo = async (method, p, body) => {
  const r = await fetch("https://api.brevo.com/v3" + p, { method, headers: { "api-key": bk, accept: "application/json", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json };
};
const cf = async (method, p, body) => {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { method, headers: { authorization: "Bearer " + ct, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const show = (v) => String(v).length > 70 ? String(v).slice(0, 67) + "..." : String(v);
(async () => {
  const zone = await cf("GET", "/zones/" + zid);
  const zoneName = zone.result && zone.result.name;
  console.log("INFO  zone:", zoneName, "| target domain:", domain, "| mode:", mode);
  if (!zoneName || !(domain === zoneName || domain.endsWith("." + zoneName))) { console.log("FAIL  domain is not inside the platform zone"); process.exit(1); }

  let d = await brevo("GET", "/senders/domains/" + encodeURIComponent(domain));
  if (d.status === 404) {
    console.log("INFO  domain not registered in Brevo");
    if (mode === "plan") { console.log("PLAN  would register", domain, "in Brevo, then add the DNS records Brevo returns"); return; }
    const c = await brevo("POST", "/senders/domains", { name: domain });
    console.log(c.status < 300 ? "DONE " : "FAIL ", "register in Brevo ->", c.status, c.json && (c.json.message || ""));
    if (c.status >= 300) process.exit(1);
    d = await brevo("GET", "/senders/domains/" + encodeURIComponent(domain));
  }
  if (d.status >= 300 || !d.json) { console.log("FAIL  Brevo domain lookup ->", d.status); process.exit(1); }
  console.log("INFO  Brevo: verified=" + d.json.verified + " authenticated=" + d.json.authenticated);

  const wanted = [];
  const recs = d.json.dns_records || {};
  for (const [label, r] of Object.entries(recs)) {
    if (!r || !r.type || !r.value) continue;
    const host = String(r.host_name || "").replace(/\.$/, "");
    const name = !host || host === "@" ? domain : host === domain || host.endsWith("." + domain) ? host : host + "." + domain;
    wanted.push({ label, type: String(r.type).toUpperCase(), name, content: String(r.value).replace(/^"|"$/g, ""), brevoStatus: r.status });
  }
  // SPF / DMARC when Brevo does not list them: Brevo-recommended values.
  if (!wanted.some((w) => w.type === "TXT" && w.name === domain && /^v=spf1/i.test(w.content)))
    wanted.push({ label: "spf", type: "TXT", name: domain, content: "v=spf1 include:spf.brevo.com ~all" });
  if (!wanted.some((w) => w.name === "_dmarc." + domain))
    wanted.push({ label: "dmarc", type: "TXT", name: "_dmarc." + domain, content: "v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com" });

  for (const w of wanted) {
    const existing = await cf("GET", "/zones/" + zid + "/dns_records?type=" + w.type + "&name=" + encodeURIComponent(w.name));
    const rows = (existing.result || []);
    const same = rows.find((x) => x.content.replace(/^"|"$/g, "") === w.content);
    const spfClash = w.label === "spf" && rows.find((x) => /^"?v=spf1/i.test(x.content));
    if (same) { console.log("OK    present ", w.label, w.type, w.name, "=>", show(w.content)); continue; }
    if (spfClash || (w.type === "CNAME" && rows.length)) { console.log("SKIP  conflict", w.label, w.type, w.name, "existing =>", show(rows[0].content)); continue; }
    if (mode === "plan") { console.log("PLAN  add     ", w.label, w.type, w.name, "=>", show(w.content)); continue; }
    const res = await cf("POST", "/zones/" + zid + "/dns_records", { type: w.type, name: w.name, content: w.content, ttl: 1, proxied: false, comment: "Brevo sending-domain authentication (Atlas)" });
    console.log(res.success ? "DONE  added   " : "FAIL  add     ", w.label, w.type, w.name, res.success ? "" : JSON.stringify(res.errors || []).slice(0, 160));
  }
  if (mode === "apply") {
    await new Promise((r) => setTimeout(r, 20000));
    const a = await brevo("PUT", "/senders/domains/" + encodeURIComponent(domain) + "/authenticate");
    console.log("INFO  Brevo authenticate ->", a.status, a.json && (a.json.message || ""));
    const after = await brevo("GET", "/senders/domains/" + encodeURIComponent(domain));
    console.log("INFO  Brevo now: verified=" + (after.json && after.json.verified) + " authenticated=" + (after.json && after.json.authenticated));
    for (const [label, r] of Object.entries((after.json && after.json.dns_records) || {})) console.log("INFO  Brevo record", label, "status=" + (r && r.status));
    if (after.json && after.json.authenticated) {
      // The platform sender on the authenticated domain.
      const sender = "no-reply@" + domain;
      const list = await brevo("GET", "/senders");
      const has = ((list.json && list.json.senders) || []).find((x) => String(x.email).toLowerCase() === sender);
      if (has) console.log("OK    sender present", sender, "active=" + has.active);
      else {
        const c = await brevo("POST", "/senders", { name: process.env.EMAIL_FROM_NAME || "Atlas", email: sender });
        console.log(c.status < 300 ? "DONE  sender created" : "FAIL  sender create", sender, "->", c.status, (c.json && c.json.message) || "");
      }
    }
  }
})().catch((e) => { console.log("FAIL ", e.message); process.exit(1); });
' "$mode" "$domain"
