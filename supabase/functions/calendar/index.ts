// A private calendar feed (iCalendar) for one person, for Google Calendar or Apple Calendar to subscribe to.
//   GET ?t=<token>: the token comes from my_calendar_token() in the app's profile settings.
// Holds the person's open tasks with due dates (owner or helper), their projects' due dates, and every upcoming game day.
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_URL = "https://dmchipm.github.io/suu-rugby-prep/";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const norm = (s: string | null | undefined) => String(s || "").trim().toLowerCase();

function sheetName(s: { opponent?: string; label?: string; master_name?: string } | null) {
  if (!s) return "Game Prep";
  return s.label || (s.opponent ? s.master_name + " vs " + s.opponent : s.master_name) || "Game Prep";
}
function mark(t: { text: string; importance?: string }) {
  return t.importance === "crucial" ? "!!! " + t.text + " !!!" : t.text;
}
function addDays(iso: string, n: number) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function esc(s: string) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
// Lines longer than 75 bytes are folded onto continuation lines that start with a space.
function fold(line: string) {
  const enc = new TextEncoder(), out: string[] = [];
  let cur = "", n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
type Ev = { uid: string; date: string; title: string; desc: string };
function ics(name: string, evs: Ev[]) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SUU Womens Rugby//Team app//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + esc(name), "X-WR-TIMEZONE:America/Denver", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const e of evs) {
    lines.push("BEGIN:VEVENT", "UID:" + e.uid + "@suu-rugby-prep", "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + e.date.replace(/-/g, ""), "DTEND;VALUE=DATE:" + addDays(e.date, 1).replace(/-/g, ""),
      "SUMMARY:" + esc(e.title), "DESCRIPTION:" + esc(e.desc), "URL:" + APP_URL, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const token = new URL(req.url).searchParams.get("t") || "";
  if (!/^[0-9a-f]{20,64}$/.test(token)) return new Response("Not found", { status: 404 });
  try {
    const { data: feed } = await admin.from("calendar_feeds").select("person_id").eq("token", token).maybeSingle();
    if (!feed) return new Response("Not found", { status: 404 });
    const { data: me } = await admin.from("people").select("id,name,status").eq("id", feed.person_id).maybeSingle();
    if (!me || me.status === "Inactive") return new Response("Not found", { status: 404 });
    const who = norm(me.name);
    const mine = (t: { owner?: string; supporters?: string[] | null }) => norm(t.owner) === who || (t.supporters || []).some((s) => norm(s) === who);
    const evs: Ev[] = [];

    const { data: st } = await admin.from("sheet_tasks").select("id,text,owner,supporters,due,status,importance,details,sheets(opponent,label,master_name,example,archived_at)")
      .neq("status", "Complete").not("due", "is", null).is("archived_at", null);
    for (const t of (st || []) as any[]) {
      if (!t.sheets || t.sheets.example || t.sheets.archived_at || !mine(t)) continue;
      const role = norm(t.owner) === who ? "You own this task." : "You're helping " + (t.owner || "on this task") + ".";
      evs.push({ uid: "st-" + t.id, date: t.due, title: mark(t) + " · " + sheetName(t.sheets), desc: [role, "Status: " + t.status, t.details || "", "Open the team app: " + APP_URL].filter(Boolean).join("\n") });
    }
    const { data: pt } = await admin.from("project_tasks").select("id,text,owner,supporters,due,status,importance,notes,projects(name,archived_at)")
      .neq("status", "Complete").not("due", "is", null).is("archived_at", null);
    for (const t of (pt || []) as any[]) {
      if (!t.projects || t.projects.archived_at || !mine(t)) continue;
      const role = norm(t.owner) === who ? "You own this task." : "You're helping " + (t.owner || "on this task") + ".";
      evs.push({ uid: "pt-" + t.id, date: t.due, title: mark(t) + " · " + t.projects.name, desc: [role, "Status: " + t.status, "Open the team app: " + APP_URL].join("\n") });
    }
    const { data: pj } = await admin.from("projects").select("id,name,description,lead,members,due").not("due", "is", null).is("archived_at", null);
    for (const p of (pj || []) as any[]) {
      if (norm(p.lead) !== who && !(p.members || []).some((m: string) => norm(m) === who)) continue;
      evs.push({ uid: "pj-" + p.id, date: p.due, title: "Project due: " + p.name, desc: [p.description || "", p.lead ? "Owner: " + p.lead : "", "Open the team app: " + APP_URL].filter(Boolean).join("\n") });
    }
    const since = addDays(new Date().toISOString().slice(0, 10), -60);
    const { data: sh } = await admin.from("sheets").select("id,opponent,label,master_name,date,example,archived_at").not("date", "is", null).gte("date", since).is("archived_at", null);
    for (const s of (sh || []) as any[]) {
      if (s.example) continue;
      evs.push({ uid: "game-" + s.id, date: s.date, title: "🏉 " + sheetName(s), desc: "Game day. Prep checklist in the team app: " + APP_URL });
    }

    return new Response(req.method === "HEAD" ? null : ics("SUU Rugby: " + me.name, evs), {
      headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="suu-rugby.ics"', "Cache-Control": "max-age=900" },
    });
  } catch (e) {
    console.error(e);
    return new Response("Failed", { status: 500 });
  }
});
