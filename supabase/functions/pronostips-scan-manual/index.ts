import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TZ = "America/Bogota";
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://pronostips.onrender.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" },
});
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());
const str = (v: any) => String(v ?? "").trim();
const norm = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hash = async (v: string) => {
  const bytes = new TextEncoder().encode(v);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
};
const result = async (r: Response) => await r.json().catch(() => ({}));
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const footballKey = Deno.env.get("API_FOOTBALL_KEY");
  const pitchKey = Deno.env.get("PITCHAPI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!footballKey || !pitchKey || !supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "Missing server configuration", configured: {
      api_football: Boolean(footballKey), pitchapi: Boolean(pitchKey),
      database: Boolean(supabaseUrl && serviceKey)
    } }, 500);
  }

  let date = today();
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) date = body.date;
  } catch { /* use Bogota date */ }

  const dbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const reserveApiFootballCall = async () => {
    const response = await fetch(supabaseUrl + "/rest/v1/rpc/pronostips_reserve_api_football_call", {
      method: "POST", headers: dbHeaders, body: JSON.stringify({ daily_limit: 100 }),
    });
    if (!response.ok) throw new Error("quota_reservation_failed_" + response.status);
    const count = await response.json().catch(() => null);
    return count === null || count === false ? null : Number(count);
  };
  const log = async (provider: string, status: number | null, success: boolean, count: number, quota: string | null, error: string | null) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/pronostips_provider_logs`, {
      method: "POST", headers: { ...dbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ provider, operation: "manual_fixture_scan", match_date: date,
        http_status: status, success, records_received: count,
        quota_remaining: quota && /^\d+$/.test(quota) ? Number(quota) : null, error_message: error })
    });
    if (!response.ok) throw new Error(`log_write_${provider}_${response.status}`);
  };

  const footballUrl = new URL("https://v3.football.api-sports.io/fixtures");
  footballUrl.searchParams.set("date", date);
  footballUrl.searchParams.set("timezone", TZ);
  let footballStatus: number | null = null, footballError: string | null = null, quota: string | null = null;
  let football: any[] = [];
  try {
    const reserved = await reserveApiFootballCall();
    if (!reserved) throw new Error("API_FOOTBALL_DAILY_LIMIT_REACHED");
    const r = await fetch(footballUrl, { headers: { "x-apisports-key": footballKey } });
    footballStatus = r.status; quota = r.headers.get("x-ratelimit-requests-remaining");
    const body = await result(r);
    football = Array.isArray(body?.response) ? body.response : [];
    const errors = body?.errors && Object.keys(body.errors).length ? body.errors : null;
    if (!r.ok || errors) footballError = JSON.stringify(errors ?? body?.message ?? `HTTP ${r.status}`).slice(0, 1000);
  } catch (e) { footballError = String(e).slice(0, 1000); }
  await log("api_football", footballStatus, !footballError, football.length, quota, footballError);

  let pitchStatus: number | null = null, pitchError: string | null = null;
  let pitch: any[] = [];
  try {
    const url = new URL(`https://api.pitchapi.dev/v1/date/${date}`);
    url.searchParams.set("status", "upcoming");
    const r = await fetch(url, { headers: { "X-API-KEY": pitchKey } });
    pitchStatus = r.status;
    const body = await result(r);
    pitch = Array.isArray(body?.data?.matches) ? body.data.matches : [];
    if (!r.ok || body?.error) pitchError = JSON.stringify(body?.error ?? body?.message ?? `HTTP ${r.status}`).slice(0, 1000);
    else if (!Array.isArray(body?.data?.matches)) pitchError = "Unexpected response shape: expected data.matches array";
  } catch (e) { pitchError = String(e).slice(0, 1000); }
  await log("pitchapi", pitchStatus, !pitchError, pitch.length, null, pitchError);

  const normalized = (f: any, provider: "api_football" | "pitchapi") => {
    if (provider === "api_football") {
      const x = f?.fixture, h = f?.teams?.home, a = f?.teams?.away;
      return { id: str(x?.id), kickoff: str(x?.date), league_id: str(f?.league?.id),
        league: str(f?.league?.name), home_id: str(h?.id), home: str(h?.name),
        away_id: str(a?.id), away: str(a?.name), raw: f };
    }
    return { id: str(f?.id), kickoff: str(f?.time_utc), league_id: str(f?.league?.id),
      league: str(f?.league?.name), home_id: str(f?.home_team?.id), home: str(f?.home_team?.name),
      away_id: str(f?.away_team?.id), away: str(f?.away_team?.name), raw: f };
  };
  const entries = [
    ...football.map(f => normalized(f, "api_football")),
    ...pitch.map(f => normalized(f, "pitchapi"))
  ].filter(f => f.id && f.kickoff && f.home && f.away && !Number.isNaN(Date.parse(f.kickoff)))
   .sort((a,b) => Date.parse(a.kickoff)-Date.parse(b.kickoff));
  const groups: any[] = [];
  for (const f of entries) {
    const same = groups.find(g => norm(g.home) === norm(f.home) && norm(g.away) === norm(f.away)
      && Math.abs(Date.parse(g.kickoff)-Date.parse(f.kickoff)) <= 15 * 60 * 1000);
    if (same) same.sources[f.provider ?? (football.some(x => str(x?.fixture?.id) === f.id) ? "api_football" : "pitchapi")] = f.raw;
    else {
      const provider = football.some(x => str(x?.fixture?.id) === f.id) ? "api_football" : "pitchapi";
      groups.push({ ...f, sources: { [provider]: f.raw } });
    }
  }

  const rows = await Promise.all(groups.map(async g => {
    const canonical = [norm(g.home), norm(g.away), new Date(g.kickoff).toISOString().slice(0,16)].join("|");
    return { provider_fixture_key: `scan:${await hash(canonical)}`, match_date: date, kickoff_at: new Date(g.kickoff).toISOString(),
      league_id: g.league_id || null, league_name: g.league || "Unknown",
      home_team_id: g.home_id || null, home_team: g.home, away_team_id: g.away_id || null, away_team: g.away,
      source_payload: { providers: g.sources }, data_quality: Object.keys(g.sources).length > 1 ? "verified" : "partial" };
  }));
  let saved = 0, writeError: string | null = null;
  if (rows.length) {
    const r = await fetch(`${supabaseUrl}/rest/v1/pronostips_fixtures?on_conflict=provider_fixture_key`, {
      method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(rows)
    });
    if (r.ok) saved = (await result(r)).length;
    else writeError = (await r.text()).slice(0, 1200);
  }
  return json({ ok: !footballError && !pitchError && !writeError, date, timezone: TZ,
    api_football: { http_status: footballStatus, fixtures_received: football.length, requests_remaining_today: quota, error: footballError },
    pitchapi: { http_status: pitchStatus, fixtures_received: pitch.length, error: pitchError },
    normalized_unique_fixtures: groups.length, saved, deduplicated: entries.length - groups.length,
    database_error: writeError, cron_enabled: false, picks_published: false }, writeError ? 500 : 200);
});

