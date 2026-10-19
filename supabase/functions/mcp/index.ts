// The team app's connector for AI assistants (Claude, ChatGPT and other MCP clients).
//   A remote MCP server over Streamable HTTP, stateless: each POST is one JSON-RPC message, answered with JSON.
//   Sign-in is OAuth 2.1 through Supabase Auth: without a token it answers 401 pointing at its protected-resource
//   metadata, which names Supabase Auth as the authorization server. The consent screen is in the app itself.
//   Every read and write runs as the signed-in person, so the database's own rules decide what they can see and change.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const BASE = Deno.env.get("SUPABASE_URL")!;
const RESOURCE = BASE + "/functions/v1/mcp";
const META = RESOURCE + "/.well-known/oauth-protected-resource";
const APP_URL = "https://dmchipm.github.io/suu-rugby-prep/";
const STATUSES = ["Not Started", "In Progress", "Blocked", "On Hold", "Complete"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
};
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

const norm = (s: string | null | undefined) => String(s || "").trim().toLowerCase();
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function utahToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function sheetTitle(s: any) {
  if (!s) return "Game Prep";
  return s.label || (s.opponent ? s.master_name + " vs " + s.opponent : s.master_name) || "Game Prep";
}
function title(t: any) { return t.importance === "crucial" ? "!!! " + t.text + " !!!" : t.text; }
function isDate(s: unknown) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
class UserError extends Error {}

type Ctx = { db: SupabaseClient; me: { id: string; name: string; role: string; email: string } };

// ---------- tools ----------
const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; run: (c: Ctx, a: any) => Promise<unknown> }[] = [];
function tool(name: string, description: string, props: Record<string, unknown>, required: string[], readOnly: boolean, run: (c: Ctx, a: any) => Promise<unknown>) {
  TOOLS.push({ name, description, inputSchema: { type: "object", properties: props, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: false }, run });
}

function taskOut(t: any, kind: "game" | "project", where: string) {
  return { id: t.id, kind, task: title(t), where, status: t.status, owner: t.owner || null, helpers: t.supporters || [], due: t.due || null,
    completed: t.completed || null, optional: !!t.optional, critical: t.importance === "crucial", overdue: !!t.due && t.status !== "Complete" && t.due < utahToday() };
}
async function liveSheetTasks(db: SupabaseClient) {
  const { data, error } = await db.from("sheet_tasks").select("id,text,owner,supporters,due,status,completed,optional,importance,details,position,sheet_id,sheets(id,opponent,label,master_name,date,example,archived_at)").is("archived_at", null);
  if (error) throw error;
  return (data || []).filter((t: any) => t.sheets && !t.sheets.example && !t.sheets.archived_at);
}
async function liveProjectTasks(db: SupabaseClient) {
  const { data, error } = await db.from("project_tasks").select("id,text,owner,supporters,due,status,completed,optional,importance,notes,position,project_id,projects(id,name,archived_at)").is("archived_at", null);
  if (error) throw error;
  return (data || []).filter((t: any) => t.projects && !t.projects.archived_at);
}
function progress(ts: any[]) {
  const req = ts.filter((t) => !t.optional), done = req.filter((t) => t.status === "Complete").length;
  return { done, total: req.length, percent: req.length ? Math.round(done * 100 / req.length) : 0, overdue: ts.filter((t) => t.status !== "Complete" && t.due && t.due < utahToday()).length, blocked: ts.filter((t) => t.status === "Blocked").length };
}

tool("whoami", "Who you are signed in as in the SUU Women's Rugby team app, your role, and today's date for the team (Utah time).", {}, [], true, async (c) => ({ ...c.me, today: utahToday(), app: APP_URL }));

tool("my_tasks", "Your open tasks (ones you own or help with) across upcoming game prep sheets and projects, most urgent first. Set include_done to also list ones you finished.",
  { include_done: { type: "boolean", description: "Also include tasks already marked Complete." } }, [], true, async (c, a) => {
    const me = norm(c.me.name), mine = (t: any) => norm(t.owner) === me || (t.supporters || []).some((s: string) => norm(s) === me);
    const st = (await liveSheetTasks(c.db)).filter(mine).filter((t: any) => !t.sheets.date || t.sheets.date >= utahToday() || t.status !== "Complete").map((t: any) => taskOut(t, "game", sheetTitle(t.sheets)));
    const pt = (await liveProjectTasks(c.db)).filter(mine).map((t: any) => taskOut(t, "project", t.projects.name));
    const all = st.concat(pt).filter((t) => a.include_done || t.status !== "Complete");
    const rank = (t: any) => t.overdue ? 0 : t.status === "Blocked" ? 1 : 2;
    return all.sort((x, y) => rank(x) - rank(y) || String(x.due || "9").localeCompare(String(y.due || "9")));
  });

tool("list_game_sheets", "Game prep checklists (one per game or event) with date and progress. Upcoming ones by default.",
  { include_past: { type: "boolean", description: "Also list games whose date has passed." } }, [], true, async (c, a) => {
    const { data, error } = await c.db.from("sheets").select("id,opponent,label,master_name,date,example,archived_at").is("archived_at", null);
    if (error) throw error;
    const ts = await liveSheetTasks(c.db), today = utahToday();
    return (data || []).filter((s: any) => !s.example && (a.include_past || !s.date || s.date >= today))
      .sort((x: any, y: any) => String(x.date || "9").localeCompare(String(y.date || "9")))
      .map((s: any) => ({ id: s.id, title: sheetTitle(s), date: s.date, kind: s.master_name, ...progress(ts.filter((t: any) => t.sheet_id === s.id)) }));
  });

tool("get_game_sheet", "Every task on one game prep sheet, in the sheet's order, with status, owner, helpers, due date and how-to details.",
  { sheet_id: { type: "string", description: "The sheet's id from list_game_sheets." } }, ["sheet_id"], true, async (c, a) => {
    const ts = (await liveSheetTasks(c.db)).filter((t: any) => t.sheet_id === a.sheet_id).sort((x: any, y: any) => x.position - y.position);
    if (!ts.length) throw new UserError("No game sheet with that id, or it has no tasks.");
    const s = ts[0].sheets;
    return { id: s.id, title: sheetTitle(s), date: s.date, ...progress(ts), tasks: ts.map((t: any) => ({ ...taskOut(t, "game", sheetTitle(s)), details: t.details || undefined })) };
  });

tool("list_projects", "Team projects (fundraisers, events and so on) with owner, purpose, due date and progress.", {}, [], true, async (c) => {
  const { data, error } = await c.db.from("projects").select("id,name,description,lead,members,due,archived_at,position").is("archived_at", null).order("position");
  if (error) throw error;
  const ts = await liveProjectTasks(c.db);
  return (data || []).map((p: any) => ({ id: p.id, name: p.name, purpose: p.description || null, owner: p.lead || null, people: p.members || [], due: p.due, ...progress(ts.filter((t: any) => t.project_id === p.id)) }));
});

tool("get_project", "One project's details and every task in it.", { project_id: { type: "string", description: "The project's id from list_projects." } }, ["project_id"], true, async (c, a) => {
  const { data: p, error } = await c.db.from("projects").select("id,name,description,lead,members,due,archived_at").eq("id", a.project_id).maybeSingle();
  if (error) throw error;
  if (!p || p.archived_at) throw new UserError("No project with that id.");
  const ts = (await liveProjectTasks(c.db)).filter((t: any) => t.project_id === p.id).sort((x: any, y: any) => x.position - y.position);
  return { id: p.id, name: p.name, purpose: p.description || null, owner: p.lead || null, people: p.members || [], due: p.due, ...progress(ts), tasks: ts.map((t: any) => ({ ...taskOut(t, "project", p.name), notes: t.notes || undefined })) };
});

tool("search_tasks", "Find tasks across all live game sheets and projects by words in the task name, and optionally by owner or status.",
  { query: { type: "string", description: "Words to look for in task names. Leave empty to match every task." },
    owner: { type: "string", description: "Only tasks owned by this person's name." },
    status: { type: "string", enum: STATUSES, description: "Only tasks with this status." },
    overdue_only: { type: "boolean", description: "Only tasks past their due date and not complete." } }, [], true, async (c, a) => {
    const q = norm(a.query), o = norm(a.owner);
    const all = (await liveSheetTasks(c.db)).map((t: any) => taskOut(t, "game", sheetTitle(t.sheets))).concat((await liveProjectTasks(c.db)).map((t: any) => taskOut(t, "project", t.projects.name)));
    return all.filter((t) => (!q || norm(t.task).includes(q)) && (!o || norm(t.owner) === o) && (!a.status || t.status === a.status) && (!a.overdue_only || t.overdue)).slice(0, 100);
  });

tool("update_task", "Change a task on a game sheet or project: its status, owner, due date, or add a note. Marking it Complete records you as the person who finished it. Anyone on the team can update tasks.",
  { task_id: { type: "string", description: "The task's id." },
    status: { type: "string", enum: STATUSES },
    owner: { type: "string", description: "The new owner's name exactly as in list_people, or an empty string for no owner." },
    due: { type: "string", description: "New due date as YYYY-MM-DD, or an empty string to clear it." },
    note: { type: "string", description: "A note to add to the task, signed with your name." } }, ["task_id"], false, async (c, a) => {
    let table = "sheet_tasks", { data: t } = await c.db.from("sheet_tasks").select("id,text,status,owner,due,completed,notes").eq("id", a.task_id).maybeSingle();
    if (!t) { table = "project_tasks"; ({ data: t } = await c.db.from("project_tasks").select("id,text,status,owner,due,completed,notes").eq("id", a.task_id).maybeSingle()); }
    if (!t) throw new UserError("No task with that id.");
    const upd: Record<string, unknown> = {};
    if (a.status !== undefined) {
      if (!STATUSES.includes(a.status)) throw new UserError("Status must be one of: " + STATUSES.join(", "));
      upd.status = a.status;
      if (a.status === "Complete" && t.status !== "Complete") Object.assign(upd, { completed: utahToday(), completed_at: new Date().toISOString(), done_by: c.me.name });
      if (a.status !== "Complete") Object.assign(upd, { completed: null, completed_at: null, done_by: null });
    }
    if (a.owner !== undefined) {
      if (a.owner) {
        const { data: ppl } = await c.db.from("people").select("name,status");
        const p = (ppl || []).find((x: any) => norm(x.name) === norm(a.owner) && x.status !== "Inactive");
        if (!p) throw new UserError("No active team member called " + a.owner + ". Use list_people for exact names.");
        upd.owner = p.name;
      } else upd.owner = "";
    }
    if (a.due !== undefined) { if (a.due && !isDate(a.due)) throw new UserError("Due date must look like 2026-10-31."); upd.due = a.due || null; }
    if (a.note) {
      if (table === "sheet_tasks") { const { error } = await c.db.from("task_notes").insert({ sheet_task_id: t.id, author: c.me.name, body: String(a.note).slice(0, 2000) }); if (error) throw error; }
      else upd.notes = (t.notes ? t.notes + "\n" : "") + c.me.name + " (" + utahToday() + "): " + String(a.note).slice(0, 2000);
    }
    if (Object.keys(upd).length) {
      const { data, error } = await c.db.from(table).update(upd).eq("id", t.id).select("id");
      if (error) throw error;
      if (!data || !data.length) throw new UserError("You don't have permission to change that task.");
    }
    return { ok: true, task: t.text, changed: Object.keys(upd).concat(a.note && table === "sheet_tasks" ? ["note"] : []) };
  });

tool("add_task", "Add a task to a game sheet (coaches and admins) or a project (its owner, the presidency and admins).",
  { sheet_id: { type: "string", description: "Add to this game sheet. Give this or project_id." },
    project_id: { type: "string", description: "Add to this project. Give this or sheet_id." },
    text: { type: "string", description: "What needs doing." },
    owner: { type: "string", description: "Who owns it, by name from list_people." },
    due: { type: "string", description: "Due date as YYYY-MM-DD." },
    critical: { type: "boolean", description: "Mark it Critical." },
    optional: { type: "boolean", description: "Mark it Optional (doesn't count toward progress)." } }, ["text"], false, async (c, a) => {
    const text = String(a.text || "").trim().slice(0, 300);
    if (!text) throw new UserError("Give the task a name.");
    if (!!a.sheet_id === !!a.project_id) throw new UserError("Give exactly one of sheet_id or project_id.");
    if (a.due && !isDate(a.due)) throw new UserError("Due date must look like 2026-10-31.");
    let owner = "";
    if (a.owner) {
      const { data: ppl } = await c.db.from("people").select("name,status");
      const p = (ppl || []).find((x: any) => norm(x.name) === norm(a.owner) && x.status !== "Inactive");
      if (!p) throw new UserError("No active team member called " + a.owner + ". Use list_people for exact names.");
      owner = p.name;
    }
    const table = a.sheet_id ? "sheet_tasks" : "project_tasks", parent = a.sheet_id ? "sheet_id" : "project_id", pid = a.sheet_id || a.project_id;
    const { data: sib } = await c.db.from(table).select("position").eq(parent, pid).order("position", { ascending: false }).limit(1);
    const row: Record<string, unknown> = { id: uid(), [parent]: pid, text, owner, due: a.due || null, status: "Not Started", position: sib && sib.length ? sib[0].position + 1 : 0,
      supporters: [], subtasks: [], files: [], importance: a.critical ? "crucial" : "", optional: !!a.optional && !a.critical };
    if (table === "sheet_tasks") Object.assign(row, { details: "", links: "", notes: "", confirmation: "" }); else row.notes = "";
    const { error } = await c.db.from(table).insert(row);
    if (error) throw new UserError(error.code === "42501" ? "You don't have permission to add tasks there." : error.message);
    return { ok: true, id: row.id, task: text };
  });

tool("list_people", "Everyone on the team list with their role.", {}, [], true, async (c) => {
  const { data, error } = await c.db.from("people").select("name,role,status").order("name");
  if (error) throw error;
  return (data || []).filter((p: any) => p.status !== "Inactive").map((p: any) => ({ name: p.name, role: p.role }));
});

tool("list_conversations", "Your chats in the team app (group chats and direct messages) with their latest message.", {}, [], true, async (c) => {
  const { data, error } = await c.db.from("conversations").select("id,name,member_ids");
  if (error) throw error;
  const { data: ppl } = await c.db.from("people").select("id,name");
  const nameOf = (id: string) => ((ppl || []).find((p: any) => p.id === id) || { name: "Someone" }).name;
  const out = [];
  for (const cv of data || []) {
    const { data: last } = await c.db.from("messages").select("author,author_id,body,created_at").eq("conversation_id", cv.id).order("created_at", { ascending: false }).limit(1);
    const others = (cv.member_ids || []).filter((id: string) => id !== c.me.id).map(nameOf);
    out.push({ id: cv.id, name: cv.name || others.join(", ") || "Just you", members: (cv.member_ids || []).map(nameOf),
      last: last && last.length ? { from: last[0].author || nameOf(last[0].author_id), text: last[0].body, at: last[0].created_at } : null });
  }
  return out;
});

tool("read_messages", "The latest messages in one of your chats, oldest first.", { conversation_id: { type: "string" }, limit: { type: "number", description: "How many (default 30, at most 100)." } }, ["conversation_id"], true, async (c, a) => {
  const { data, error } = await c.db.from("messages").select("author,body,created_at,attachments").eq("conversation_id", a.conversation_id).order("created_at", { ascending: false }).limit(Math.min(Number(a.limit) || 30, 100));
  if (error) throw error;
  return (data || []).reverse().map((m: any) => ({ from: m.author, text: m.body, at: m.created_at, files: (m.attachments || []).length || undefined }));
});

tool("send_message", "Send a message, as you, in one of your chats. Everyone else in that chat gets a notification.",
  { conversation_id: { type: "string" }, text: { type: "string" } }, ["conversation_id", "text"], false, async (c, a) => {
    const body = String(a.text || "").trim().slice(0, 4000);
    if (!body) throw new UserError("The message is empty.");
    const { error } = await c.db.from("messages").insert({ id: uid(), conversation_id: a.conversation_id, author: c.me.name, body });
    if (error) throw new UserError(error.code === "42501" ? "You're not in that chat." : error.message);
    return { ok: true };
  });

tool("my_notifications", "Notifications the team app has sent you (new tasks, reminders, messages, announcements), newest first.", { limit: { type: "number", description: "How many (default 20, at most 100)." } }, [], true, async (c, a) => {
  const { data, error } = await c.db.from("notifications").select("kind,title,body,created_at,read_at").order("created_at", { ascending: false }).limit(Math.min(Number(a.limit) || 20, 100));
  if (error) throw error;
  return data || [];
});

// ---------- MCP plumbing ----------
async function signedIn(req: Request): Promise<Ctx | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const db = createClient(BASE, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: "Bearer " + token } }, auth: { persistSession: false } });
  const { data: u } = await db.auth.getUser(token);
  const email = norm(u?.user?.email);
  if (!email) return null;
  const { data: ppl } = await db.from("people").select("id,name,role,email,status");
  const me = (ppl || []).find((p: any) => norm(p.email) === email && p.status !== "Inactive");
  if (!me) throw new UserError("not_member");
  return { db, me: { id: me.id, name: me.name, role: me.role, email } };
}
function unauthorized() {
  return json(401, { error: "unauthorized", error_description: "Sign in with your SUU Women's Rugby team account." },
    { "WWW-Authenticate": 'Bearer resource_metadata="' + META + '"' });
}

async function handle(c: Ctx, msg: any) {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({ protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(asked) ? asked : "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "suu-rugby", title: "SUU Women's Rugby", version: "1.0.0" },
        instructions: "The SUU Women's Rugby team app: game prep checklists (one per game), team projects, chats and notifications. Dates are YYYY-MM-DD in Utah time. Critical tasks show as !!! name !!!. Use my_tasks for what the signed-in person needs to do." });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === msg.params?.name);
      if (!t) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool: " + msg.params?.name } };
      try {
        const out = await t.run(c, msg.params?.arguments || {});
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        if (!(e instanceof UserError)) console.error(t.name, e);
        return ok({ content: [{ type: "text", text: e instanceof UserError ? e.message : "Something went wrong: " + ((e as Error).message || "unknown error") }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + msg.method } };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname;
  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json(200, { resource: RESOURCE, authorization_servers: [BASE + "/auth/v1"], bearer_methods_supported: ["header"], resource_name: "SUU Women's Rugby team app", resource_documentation: APP_URL });
  }
  if (req.method === "GET") return json(405, { error: "This connector only answers POST requests." }, { Allow: "POST" });
  if (req.method !== "POST") return json(405, { error: "method" });
  let c: Ctx | null;
  try { c = await signedIn(req); } catch (e) {
    if (e instanceof UserError) return json(403, { error: "forbidden", error_description: "This account isn't on the SUU Women's Rugby team list." });
    console.error(e); return json(500, { error: "failed" });
  }
  if (!c) return unauthorized();
  let body: any;
  try { body = await req.json(); } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) { if (m && m.method && m.id !== undefined && m.id !== null) out.push(await handle(c, m)); }
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  return json(200, Array.isArray(body) ? out : out[0]);
});
