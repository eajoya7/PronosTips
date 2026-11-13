import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TZ = "America/Bogota";
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://pronostips.onrender.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" },
});
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const footballKey = Deno.env.get("API_FOOTBALL_KEY");
  const pitchKey = Deno.env.get("PITCHAPI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!footballKey || !pitchKey || !supabaseUrl || !serviceKey) {
    return json({
      ok: false,
      error: "Missing provider secrets",
      api_football_configured: Boolean(footballKey),
      pitchapi_configured: Boolean(pitchKey),
      database_configured: Boolean(supabaseUrl && serviceKey)
    }, 500);
  }

  const date = today();
  const results: Record<string, unknown> = {
    date, timezone: TZ, read_only: false, quota_reservation_write: true
  };

  const footballUrl = new URL("https://v3.football.api-sports.io/fixtures");
  footballUrl.searchParams.set("date", date);
  footballUrl.searchParams.set("timezone", TZ);
  const serviceHeaders = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  const reservation = await fetch(supabaseUrl + "/rest/v1/rpc/pronostips_reserve_api_football_call", {
    method: "POST", headers: serviceHeaders, body: JSON.stringify({ daily_limit: 100 })
  });
  if (!reservation.ok) return json({ ok: false, error: "Could not reserve API-Football request." }, 500);
  const reserved = await reservation.json().catch(() => null);
  if (reserved === null || reserved === false) return json({ ok: false, error: "Daily API-Football limit reached." }, 429);
  const footballResponse = await fetch(footballUrl, {
    headers: { "x-apisports-key": footballKey }
  });
  const footballBody = await footballResponse.json().catch(() => ({}));
  const footballErrors = footballBody?.errors && Object.keys(footballBody.errors).length
    ? footballBody.errors : null;
  results.api_football = {
    http_status: footballResponse.status,
    authenticated: footballResponse.ok && !footballErrors,
    fixtures_found: Array.isArray(footballBody?.response) ? footballBody.response.length : 0,
    requests_remaining_today: footballResponse.headers.get("x-ratelimit-requests-remaining"),
    requests_limit_today: footballResponse.headers.get("x-ratelimit-requests-limit"),
    errors: footballErrors
  };

  const pitchUrl = new URL(`https://api.pitchapi.dev/v1/date/${date}`);
  pitchUrl.searchParams.set("status", "upcoming");
  const pitchResponse = await fetch(pitchUrl, {
    headers: { "X-API-KEY": pitchKey }
  });
  const pitchBody = await pitchResponse.json().catch(() => ({}));
  const pitchMatches = Array.isArray(pitchBody?.data?.matches) ? pitchBody.data.matches : [];
  results.pitchapi = {
    http_status: pitchResponse.status,
    authenticated: pitchResponse.ok && !pitchBody?.error,
    fixtures_found: pitchMatches.length,
    error: pitchBody?.error?.message ?? (!pitchResponse.ok ? "Provider request failed" : null)
  };

  const bothOk = Boolean((results.api_football as any).authenticated)
    && Boolean((results.pitchapi as any).authenticated);
  return json({ ok: bothOk, ...results }, bothOk ? 200 : 502);
});

