// Sends push notifications to team members' devices.
//   From the database (x-notify-key header): {type:"assigned"} when tasks get a new owner, {type:"reminders"} each morning.
//   {type:"message", ids} when chat messages are sent (everyone else in the conversation hears about it).
//   From an admin in the app (signed-in user): {type:"send", to:"team" | [personId...], title?, body}.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://dmchipm.github.io/suu-rugby-prep/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let keys: Record<string, string> | null = null;
async function loadKeys() {
  if (keys) return keys;
  const { data, error } = await admin.rpc("push_keys");
  if (error || !data) throw new Error("keys");
  keys = data as Record<string, string>;
  webpush.setVapidDetails(APP_URL, keys.vapid_public, keys.vapid_private);
  return keys;
}

type Person = { id: string; name: string; email: string | null; role: string; status: string };
const norm = (s: string | null | undefined) => String(s || "").trim().toLowerCase();
async function activePeople(): Promise<Person[]> {
  const { data } = await admin.from("people").select("id,name,email,role,status");
  return ((data || []) as Person[]).filter((p) => p.status !== "Inactive");
}

// Sends one message to every device of each person; removes devices the push service says are gone.
// Every message is also kept in each person's notification center (the notifications table), even if they have no devices.
async function deliver(personIds: string[], msg: { title: string; body: string; tag?: string; kind?: string }) {
  if (!personIds.length) return { devices: 0, reached: [] as string[] };
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint,person_id,p256dh,auth").in("person_id", personIds);
  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag || "", url: APP_URL });
  let devices = 0;
  const reached = new Set<string>();
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
      devices++; reached.add(s.person_id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }));
  const { error } = await admin.from("notifications").insert(personIds.map((id) => ({ person_id: id, kind: msg.kind || "", title: msg.title, body: msg.body, delivered: reached.has(id) })));
  if (error) console.error("record failed", error.message);
  return { devices, reached: [...reached] };
}

function mark(t: { text: string; importance?: string }) {
  return t.importance === "crucial" ? "!!! " + t.text + " !!!" : t.text;
}
function sheetName(s: { opponent?: string; label?: string; master_name?: string } | null) {
  if (!s) return "Game Prep";
  return s.label || (s.opponent ? s.master_name + " vs " + s.opponent : s.master_name) || "Game Prep";
}
function list(xs: string[]) { return xs.length <= 3 ? xs.join(", ") : xs.slice(0, 3).join(", ") + " and " + (xs.length - 3) + " more"; }

async function assigned(body: { table: string; items: { id: string; owner: string }[]; actor?: string }) {
  const ids = body.items.map((x) => x.id);
  type Row = { id: string; text: string; owner: string; importance?: string; where: string };
  let rows: Row[] = [];
  if (body.table === "sheet_tasks") {
    const { data } = await admin.from("sheet_tasks").select("id,text,owner,importance,status,sheets(opponent,label,master_name,example,archived_at)").in("id", ids);
    rows = (data || []).filter((t: any) => t.status !== "Complete" && t.sheets && !t.sheets.example && !t.sheets.archived_at)
      .map((t: any) => ({ id: t.id, text: t.text, owner: t.owner, importance: t.importance, where: sheetName(t.sheets) }));
  } else if (body.table === "project_tasks") {
    const { data } = await admin.from("project_tasks").select("id,text,owner,importance,status,projects(name,archived_at)").in("id", ids);
    rows = (data || []).filter((t: any) => t.status !== "Complete" && t.projects && !t.projects.archived_at)
      .map((t: any) => ({ id: t.id, text: t.text, owner: t.owner, importance: t.importance, where: t.projects.name }));
  }
  const people = await activePeople();
  const byOwner = new Map<string, Row[]>();
  rows.forEach((r) => { const k = norm(r.owner); byOwner.set(k, [...(byOwner.get(k) || []), r]); });
  let devices = 0;
  for (const [owner, tasks] of byOwner) {
    const p = people.find((x) => norm(x.name) === owner);
    if (!p || (body.actor && norm(p.email) === norm(body.actor))) continue; // no alert for assigning yourself
    const crucial = tasks.some((t) => t.importance === "crucial");
    const msg = tasks.length === 1
      ? { title: crucial ? "New critical task for you" : "New task for you", body: mark(tasks[0]) + " · " + tasks[0].where }
      : { title: "You have " + tasks.length + " new tasks", body: list(tasks.map(mark)) + " · " + [...new Set(tasks.map((t) => t.where))].join(", ") };
    devices += (await deliver([p.id], { ...msg, tag: "assigned-" + tasks[0].id, kind: "assigned" })).devices;
  }
  return { devices };
}

async function messages(body: { ids: string[] }) {
  const { data: msgs } = await admin.from("messages").select("id,conversation_id,author_id,author,body,attachments,created_at").in("id", body.ids || []).order("created_at");
  if (!msgs || !msgs.length) return { devices: 0 };
  const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
  const { data: convs } = await admin.from("conversations").select("id,name,member_ids").in("id", convIds);
  const people = await activePeople();
  const nameOf = (id: string) => (people.find((p) => p.id === id) || { name: "" }).name;
  // Messages is admin-only in the app, so only admins hear about new messages.
  const { data: ra } = await admin.from("role_access").select("role,admin");
  const adminRoles = new Set((ra || []).filter((r) => r.admin).map((r) => r.role));
  let devices = 0;
  for (const c of convs || []) {
    const ms = msgs.filter((m) => m.conversation_id === c.id), last = ms[ms.length - 1];
    const who = last.author || nameOf(last.author_id) || "Someone";
    const files = Array.isArray(last.attachments) ? last.attachments.length : 0;
    const text = String(last.body || "").trim() || (files ? (files === 1 ? "Sent a file" : "Sent " + files + " files") : "New message");
    const members: string[] = c.member_ids || [];
    const group = c.name || (members.length > 2 ? "Group chat" : "");
    const to = members.filter((id) => !ms.every((m) => m.author_id === id) && people.some((p) => p.id === id && adminRoles.has(p.role)));
    const msg = { title: group ? who + " in " + group : who, body: (ms.length > 1 ? ms.length + " messages. " : "") + text.slice(0, 180), tag: "chat-" + c.id, kind: "message" };
    devices += (await deliver(to, msg)).devices;
  }
  return { devices };
}

function utahToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso: string, n: number) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function reminders() {
  const today = utahToday(), tomorrow = addDays(today, 1);
  type Row = { text: string; owner: string; importance?: string; due: string };
  const { data: st } = await admin.from("sheet_tasks").select("text,owner,importance,due,status,optional,archived_at,sheets(example,archived_at)")
    .neq("status", "Complete").not("due", "is", null).lte("due", tomorrow).is("archived_at", null);
  const { data: pt } = await admin.from("project_tasks").select("text,owner,importance,due,status,archived_at,projects(archived_at)")
    .neq("status", "Complete").not("due", "is", null).lte("due", tomorrow).is("archived_at", null);
  const rows: Row[] = [
    ...(st || []).filter((t: any) => !t.optional && t.sheets && !t.sheets.example && !t.sheets.archived_at),
    ...(pt || []).filter((t: any) => t.projects && !t.projects.archived_at),
  ].filter((t: any) => norm(t.owner));
  const people = await activePeople();
  const byOwner = new Map<string, Row[]>();
  rows.forEach((r) => { const k = norm(r.owner); byOwner.set(k, [...(byOwner.get(k) || []), r]); });
  let devices = 0;
  for (const [owner, tasks] of byOwner) {
    const p = people.find((x) => norm(x.name) === owner);
    if (!p) continue;
    const late = tasks.filter((t) => t.due < today).length, now = tasks.filter((t) => t.due === today).length, soon = tasks.filter((t) => t.due === tomorrow).length;
    const parts = [late && late + " overdue", now && now + " due today", soon && soon + " due tomorrow"].filter(Boolean);
    const order = (t: Row) => (t.importance === "crucial" ? 0 : 1);
    const names = tasks.slice().sort((a, b) => order(a) - order(b) || (a.due < b.due ? -1 : 1)).map(mark);
    devices += (await deliver([p.id], { title: "Tasks: " + parts.join(", "), body: list(names), tag: "reminders", kind: "reminder" })).devices;
  }
  return { devices };
}

async function send(req: Request, body: { to: string | string[]; title?: string; body?: string }) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const email = norm(u?.user?.email);
  if (!email) return reply(401, { error: "signin" });
  const people = await activePeople();
  const me = people.find((p) => norm(p.email) === email);
  const { data: ra } = await admin.from("role_access").select("role,admin");
  if (!me || !(ra || []).some((r) => r.role === me.role && r.admin)) return reply(403, { error: "not_admin" });
  const text = String(body.body || "").trim().slice(0, 500);
  if (!text) return reply(400, { error: "empty" });
  const ids = body.to === "team" ? people.map((p) => p.id) : (Array.isArray(body.to) ? body.to : []).filter((id) => people.some((p) => p.id === id));
  if (!ids.length) return reply(400, { error: "no_one" });
  const title = String(body.title || "").trim().slice(0, 80) || "From " + me.name;
  const r = await deliver(ids, { title, body: text, tag: "admin-" + Date.now(), kind: "admin" });
  return reply(200, { ok: true, devices: r.devices, reached: r.reached.length, people: ids.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method" });
  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  try {
    const k = await loadKeys();
    if (body.type === "public_key") return reply(200, { key: k.vapid_public });
    if (body.type === "send") return await send(req, body);
    if (req.headers.get("x-notify-key") !== k.notify_key) return reply(401, { error: "key" });
    if (body.type === "assigned") return reply(200, await assigned(body));
    if (body.type === "reminders") return reply(200, await reminders());
    if (body.type === "message") return reply(200, await messages(body));
    return reply(400, { error: "type" });
  } catch (e) {
    console.error(e);
    return reply(500, { error: "failed" });
  }
});
