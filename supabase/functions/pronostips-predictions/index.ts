import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TZ = "America/Bogota";
const API_BASE = "https://v3.football.api-sports.io";
const DAILY_LIMIT = 100;
const MAX_FIXTURES_PER_RUN = 25;
const CORS = {
  "Access-Control-Allow-Origin": "https://pronostips.onrender.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const readJson = async (response: Response) => await response.json().catch(() => ({}));
const norm = (value: unknown) => String(value ?? "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hash = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const footballKey = Deno.env.get("API_FOOTBALL_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!footballKey || !supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "Falta configuración del servidor.", api_football_configured: Boolean(footballKey) }, 503);
  }

  const date = today();
  const dbHeaders = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  let requestsUsedToday = 0;
  let apiCalls = 0;
  let limitReached = false;

  const reserveCall = async (): Promise<boolean> => {
    const response = await fetch(supabaseUrl + "/rest/v1/rpc/pronostips_reserve_api_football_call", {
      method: "POST", headers: dbHeaders, body: JSON.stringify({ daily_limit: DAILY_LIMIT }),
    });
    if (!response.ok) throw new Error("No se pudo comprobar el límite diario de API-Football.");
    const count = await response.json().catch(() => null);
    if (count === null || count === false) return false;
    requestsUsedToday = Number(count);
    return Number.isSafeInteger(requestsUsedToday) && requestsUsedToday > 0;
  };

  const fixtureUrl = new URL(API_BASE + "/fixtures");
  fixtureUrl.searchParams.set("date", date);
  fixtureUrl.searchParams.set("timezone", TZ);
  fixtureUrl.searchParams.set("status", "NS");
  try {
    if (!await reserveCall()) return json({
      ok: true, date, timezone: TZ, limit_reached: true, requests_used_today: DAILY_LIMIT,
      daily_request_limit: DAILY_LIMIT, api_calls: 0, fixtures_available: 0, predictions_saved: 0,
    });
    apiCalls++;
    const fixtureResponse = await fetch(fixtureUrl, { headers: { "x-apisports-key": footballKey } });
    const fixtureBody = await readJson(fixtureResponse);
    const fixtureErrors = fixtureBody?.errors && Object.keys(fixtureBody.errors).length ? fixtureBody.errors : null;
    if (!fixtureResponse.ok || fixtureErrors) {
      return json({ ok: false, error: "API-Football no pudo devolver la lista de partidos.",
        api_status: fixtureResponse.status, api_calls: apiCalls, requests_used_today: requestsUsedToday }, 502);
    }

    const fixtures = (Array.isArray(fixtureBody?.response) ? fixtureBody.response : [])
      .filter((fixture: any) => fixture?.fixture?.id && fixture?.teams?.home?.name && fixture?.teams?.away?.name
        && fixture?.fixture?.status?.short === "NS" && Number.isFinite(Date.parse(fixture?.fixture?.date))
        && Date.parse(fixture.fixture.date) > Date.now())
      .sort((a: any, b: any) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));

    const cacheUrl = new URL(supabaseUrl + "/rest/v1/pronostips_predictions");
    cacheUrl.searchParams.set("match_date", "eq." + date);
    cacheUrl.searchParams.set("select", "fixture_id,fetch_status");
    const cacheResponse = await fetch(cacheUrl, { headers: dbHeaders });
    if (!cacheResponse.ok) throw new Error("No se pudo leer la caché de predicciones.");
    const cacheRows = await readJson(cacheResponse);
    const cached = new Set((Array.isArray(cacheRows) ? cacheRows : []).map((row: any) => String(row.fixture_id)));
    const pending = fixtures.filter((fixture: any) => !cached.has(String(fixture.fixture.id)));
    const selected = pending.slice(0, MAX_FIXTURES_PER_RUN);
    const warnings: string[] = [];
    let saved = 0;
    let available = 0;

    for (const fixture of selected) {
      if (!await reserveCall()) {
        limitReached = true;
        break;
      }
      apiCalls++;
      const fixtureId = Number(fixture.fixture.id);
      const predictionUrl = new URL(API_BASE + "/predictions");
      predictionUrl.searchParams.set("fixture", String(fixtureId));
      let fetchStatus: "ok" | "error" = "ok";
      let fetchError: string | null = null;
      let providerRow: any = null;
      try {
        const response = await fetch(predictionUrl, { headers: { "x-apisports-key": footballKey } });
        const body = await readJson(response);
        const errors = body?.errors && Object.keys(body.errors).length ? body.errors : null;
        if (!response.ok || errors) {
          fetchStatus = "error";
          fetchError = "No se obtuvo el consejo del proveedor (HTTP " + response.status + ").";
        } else {
          providerRow = Array.isArray(body?.response) ? body.response[0] ?? null : null;
        }
      } catch {
        fetchStatus = "error";
        fetchError = "Falló la conexión con API-Football.";
      }

      const prediction = providerRow?.predictions ?? null;
      const canonical = [norm(fixture.teams.home.name), norm(fixture.teams.away.name),
        new Date(fixture.fixture.date).toISOString().slice(0, 16)].join("|");
      const row = {
        fixture_id: fixtureId,
        provider_fixture_key: "apifootball:" + await hash(canonical),
        match_date: date,
        kickoff_at: new Date(fixture.fixture.date).toISOString(),
        league_id: fixture.league?.id == null ? null : String(fixture.league.id),
        league_name: fixture.league?.name ?? "Fútbol",
        home_team: fixture.teams.home.name,
        away_team: fixture.teams.away.name,
        advice: prediction?.advice ?? null,
        winner: prediction?.winner ?? null,
        percent: prediction?.percent ?? null,
        goals: prediction?.goals ?? null,
        comparison: prediction?.comparison ?? null,
        provider_response: providerRow,
        prediction_available: Boolean(prediction),
        fetch_status: fetchStatus,
        fetch_error: fetchError,
        fetched_at: new Date().toISOString(),
      };
      const saveUrl = new URL(supabaseUrl + "/rest/v1/pronostips_predictions");
      saveUrl.searchParams.set("on_conflict", "fixture_id");
      const saveResponse = await fetch(saveUrl, {
        method: "POST",
        headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
      if (!saveResponse.ok) {
        warnings.push("No se pudo guardar el pronóstico de " + fixture.teams.home.name + " vs " + fixture.teams.away.name + ".");
      } else {
        saved++;
        if (row.prediction_available) available++;
      }
    }

    const remaining = Math.max(0, DAILY_LIMIT - requestsUsedToday);
    return json({
      ok: true, date, timezone: TZ, fixtures_available: fixtures.length,
      predictions_saved: saved, predictions_available: available,
      cached: cached.size, truncated: pending.length > selected.length,
      max_fixtures_per_run: MAX_FIXTURES_PER_RUN, limit_reached: limitReached,
      api_calls: apiCalls, requests_used_today: requestsUsedToday,
      requests_remaining_today: remaining, daily_request_limit: DAILY_LIMIT, warnings,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error),
      date, api_calls: apiCalls, requests_used_today: requestsUsedToday }, 502);
  }
});


