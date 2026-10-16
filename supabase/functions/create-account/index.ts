// Creates a ready-to-use email + password account for someone already on the People list,
// so new teammates can start without a confirmation email. Anyone else is refused.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method" });
  let email = "", password = "";
  try { const b = await req.json(); email = String(b.email || "").trim().toLowerCase(); password = String(b.password || ""); } catch { return reply(400, { error: "bad_request" }); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "bad_email" });
  if (password.length < 8 || password.length > 72) return reply(400, { error: "weak_password" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: people, error: pe } = await admin.from("people").select("email,status");
  if (pe) return reply(500, { error: "lookup_failed" });
  const person = (people || []).find((p) => String(p.email || "").trim().toLowerCase() === email);
  if (!person || person.status === "Inactive") return reply(403, { error: "not_invited" });

  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) return reply(409, { error: "exists" });
    return reply(400, { error: "create_failed", message: error.message });
  }
  return reply(200, { ok: true });
});
