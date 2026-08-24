import { buildPushPayload } from "@block65/webcrypto-web-push";
import {
  closedCandles,
  evaluateStrategy,
  normalizeKlines,
  normalizeSymbol,
  SUPPORTED_SYMBOLS,
} from "../../strategy.js";

const API_HOSTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://data-api.binance.vision",
];
const MAX_BODY_BYTES = 8_192;
const DELIVERY_BATCH_SIZE = 10;
const SUBSCRIPTION_PREFIX = "subscription:";
const SYMBOLS = Object.keys(SUPPORTED_SYMBOLS);
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
  "webpush.apple.com",
  "notify.windows.com",
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function requestOrigin(request) {
  return request.headers.get("origin") || "";
}

function allowedOrigin(request, env) {
  const origin = requestOrigin(request);
  if (!origin) return "";
  const configured = String(env.APP_ORIGIN || "")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (configured.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-max-age": "86400",
        vary: "Origin",
      }
    : {};
}

async function parseBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "リクエストが大きすぎます");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "リクエストが大きすぎます");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSONを読み取れません");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validBase64Url(value, minLength, maxLength) {
  return typeof value === "string"
    && value.length >= minLength
    && value.length <= maxLength
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isKnownPushHost(hostname) {
  return PUSH_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") {
    throw new HttpError(400, "購読情報がありません");
  }
  if (typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2_048) {
    throw new HttpError(400, "Push endpointが不正です");
  }
  let endpoint;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    throw new HttpError(400, "Push endpointが不正です");
  }
  if (endpoint.protocol !== "https:" || !isKnownPushHost(endpoint.hostname)) {
    throw new HttpError(400, "対応していないPushサービスです");
  }
  if (!validBase64Url(subscription.keys?.p256dh, 40, 160)
    || !validBase64Url(subscription.keys?.auth, 8, 64)) {
    throw new HttpError(400, "Push暗号鍵が不正です");
  }
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };
}

async function endpointHash(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsEqual(value, secret) {
  if (typeof value !== "string" || typeof secret !== "string") return false;
  const encoder = new TextEncoder();
  const candidate = encoder.encode(value);
  const expected = encoder.encode(secret);
  if (candidate.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(candidate, expected);
}

function normalizePreferences(value = {}) {
  const symbols = Array.isArray(value.symbols)
    ? [...new Set(value.symbols.filter(symbol => Object.hasOwn(SUPPORTED_SYMBOLS, symbol)))]
    : SYMBOLS;
  return {
    notifyWatch: Boolean(value.notifyWatch),
    notifyRiskOff: value.notifyRiskOff !== false,
    symbols,
  };
}

function vapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID secrets are not configured");
  }
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

async function sendPush(subscription, payload, env) {
  const request = await buildPushPayload(
    {
      data: JSON.stringify(payload),
      options: { ttl: 60 * 60 * 8, urgency: payload.state === "READY" ? "high" : "normal" },
    },
    subscription,
    vapid(env),
  );
  return fetch(subscription.endpoint, request);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "crypto-regime-watch/3.0" },
  });
  if (!response.ok) throw new Error(`Market API ${response.status}`);
  return response.json();
}

async function fetchMarketData(symbol) {
  let lastError;
  for (const host of API_HOSTS) {
    try {
      const [dailyRows, h4Rows] = await Promise.all([
        fetchJson(`${host}/api/v3/klines?symbol=${symbol}&interval=1d&limit=320`),
        fetchJson(`${host}/api/v3/klines?symbol=${symbol}&interval=4h&limit=260`),
      ]);
      return {
        daily: closedCandles(normalizeKlines(dailyRows)),
        h4: closedCandles(normalizeKlines(h4Rows)),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Market data unavailable");
}

function pushPayload(snapshot) {
  const asset = SUPPORTED_SYMBOLS[snapshot.symbol];
  const stateLabel = snapshot.state === "READY"
    ? "エントリー候補"
    : snapshot.state === "WATCH"
      ? "監視条件に変化"
      : "新規ロング見送り";
  const details = snapshot.state === "READY"
    ? `${snapshot.headline} · ADX ${snapshot.h4.adx.toFixed(1)} · Entry ${snapshot.levels.entry.toLocaleString("en-US")} / Stop ${snapshot.levels.stop.toLocaleString("en-US")}`
    : `${snapshot.headline} · 条件 ${snapshot.score}/${snapshot.scoreMax} · ADX ${snapshot.h4.adx.toFixed(1)}`;
  return {
    title: `${asset.ticker} ${stateLabel}`,
    body: details,
    state: snapshot.state,
    timestamp: snapshot.candleCloseTime,
    tag: `${asset.ticker.toLowerCase()}-${snapshot.state}-${snapshot.candleCloseTime}`,
    renotify: snapshot.state === "READY",
    url: `./?symbol=${snapshot.symbol}`,
  };
}

function notificationKind(current, previous) {
  if (!previous) return null;
  if (current.state === "READY" && previous.state !== "READY") return "READY";
  if (current.state === "WATCH" && previous.state !== "WATCH") return "WATCH";
  if (current.state === "RISK_OFF" && previous.regime === "BULL") return "RISK_OFF";
  return null;
}

function wantsNotification(preferences, kind, symbol) {
  const normalized = normalizePreferences(preferences);
  if (!normalized.symbols.includes(symbol)) return false;
  if (kind === "READY") return true;
  if (kind === "WATCH") return normalized.notifyWatch;
  if (kind === "RISK_OFF") return normalized.notifyRiskOff;
  return false;
}

async function createPending(snapshot, kind, env) {
  await env.SIGNAL_DATA.put(`delivery:pending:${snapshot.symbol}`, JSON.stringify({
    id: `${snapshot.symbol}:${snapshot.candleCloseTime}:${kind}`,
    symbol: snapshot.symbol,
    kind,
    cursor: null,
    payload: pushPayload(snapshot),
    createdAt: Date.now(),
    sent: 0,
    failed: 0,
  }), { expirationTtl: 60 * 60 * 24 });
}

async function deliverPending(symbol, env) {
  const pendingKey = `delivery:pending:${symbol}`;
  const pending = await env.SIGNAL_DATA.get(pendingKey, "json");
  if (!pending) return { pending: false, sent: 0, failed: 0 };

  const page = await env.SIGNAL_DATA.list({
    prefix: SUBSCRIPTION_PREFIX,
    limit: DELIVERY_BATCH_SIZE,
    cursor: pending.cursor || undefined,
  });
  let sent = 0;
  let failed = 0;

  for (const key of page.keys) {
    const record = await env.SIGNAL_DATA.get(key.name, "json");
    if (!record || !wantsNotification(record.preferences || {}, pending.kind, symbol)) continue;
    try {
      const response = await sendPush(record.subscription, pending.payload, env);
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
        if (response.status === 404 || response.status === 410) {
          await env.SIGNAL_DATA.delete(key.name);
        }
      }
    } catch (error) {
      failed += 1;
      console.error("push delivery failed", { key: key.name, message: error.message });
    }
  }

  const totals = { sent: pending.sent + sent, failed: pending.failed + failed };
  if (page.list_complete) {
    await Promise.all([
      env.SIGNAL_DATA.delete(pendingKey),
      env.SIGNAL_DATA.put(`delivery:result:${pending.id}`, JSON.stringify({
        ...totals,
        completedAt: Date.now(),
      }), { expirationTtl: 60 * 60 * 24 * 30 }),
    ]);
  } else {
    await env.SIGNAL_DATA.put(pendingKey, JSON.stringify({
      ...pending,
      cursor: page.cursor,
      ...totals,
    }), { expirationTtl: 60 * 60 * 24 });
  }
  return { pending: !page.list_complete, ...totals };
}

async function runMonitor(env) {
  const markets = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return { symbol, market: await fetchMarketData(symbol), error: null };
    } catch (error) {
      console.error("market fetch failed", { symbol, message: error.message });
      return { symbol, market: null, error: error.message };
    }
  }));
  const results = [];

  for (const { symbol, market, error } of markets) {
    if (!market) {
      results.push({ symbol, error });
      continue;
    }
    const current = evaluateStrategy(market.daily, market.h4, { symbol });
    const latestKey = `signal:latest:${symbol}`;
    const previous = await env.SIGNAL_DATA.get(latestKey, "json")
      || (symbol === "BTCUSDT" ? await env.SIGNAL_DATA.get("signal:latest", "json") : null);
    const isNewCandle = !previous || previous.candleCloseTime !== current.candleCloseTime;

    if (isNewCandle) {
      const kind = notificationKind(current, previous);
      await env.SIGNAL_DATA.put(latestKey, JSON.stringify(current));
      if (kind) await createPending(current, kind, env);
    }
    results.push({ symbol, snapshot: current, isNewCandle });
  }

  if (!results.some(result => result.snapshot)) {
    throw new Error("All market data requests failed");
  }

  const deliveries = await Promise.all(SYMBOLS.map(async symbol => ({
    symbol,
    ...(await deliverPending(symbol, env)),
  })));
  return { results, deliveries };
}

async function saveSubscription(request, env) {
  const body = await parseBody(request);
  const subscription = validateSubscription(body.subscription);
  const hash = await endpointHash(subscription.endpoint);
  await env.SIGNAL_DATA.put(`${SUBSCRIPTION_PREFIX}${hash}`, JSON.stringify({
    subscription,
    preferences: normalizePreferences(body.preferences),
    updatedAt: Date.now(),
  }));
  return { ok: true, id: hash.slice(0, 12) };
}

async function deleteSubscription(request, env) {
  const body = await parseBody(request);
  if (typeof body.endpoint !== "string") throw new HttpError(400, "endpointが必要です");
  const hash = await endpointHash(body.endpoint);
  await env.SIGNAL_DATA.delete(`${SUBSCRIPTION_PREFIX}${hash}`);
  return { ok: true };
}

async function testSubscription(request, env) {
  const body = await parseBody(request);
  const subscription = validateSubscription(body.subscription);
  const hash = await endpointHash(subscription.endpoint);
  const testKey = `test:${hash}`;
  if (await env.SIGNAL_DATA.get(testKey)) {
    return { ok: true, skipped: true, message: "テスト通知は24時間に1回です" };
  }
  const response = await sendPush(subscription, {
    title: "Crypto Regime Watch",
    body: "BTC・ETHのバックグラウンド通知設定が完了しました。",
    state: "TEST",
    timestamp: Date.now(),
    tag: `crypto-test-${hash.slice(0, 12)}`,
    url: "./",
  }, env);
  if (!response.ok) throw new HttpError(502, `Pushサービスが${response.status}を返しました`);
  await env.SIGNAL_DATA.put(testKey, "1", { expirationTtl: 60 * 60 * 24 });
  return { ok: true };
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    if (!allowedOrigin(request, env)) return json({ error: "Origin not allowed" }, 403);
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "crypto-regime-watch", symbols: SYMBOLS, time: Date.now() }, 200, cors);
  }
  if (url.pathname === "/api/config" && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) throw new HttpError(503, "VAPID公開鍵が未設定です");
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
  }
  if (url.pathname === "/api/snapshot" && request.method === "GET") {
    const requestedSymbol = url.searchParams.get("symbol") || "BTCUSDT";
    if (!Object.hasOwn(SUPPORTED_SYMBOLS, requestedSymbol)) {
      throw new HttpError(400, "対応していない銘柄です");
    }
    const symbol = normalizeSymbol(requestedSymbol);
    const latest = await env.SIGNAL_DATA.get(`signal:latest:${symbol}`, "json")
      || (symbol === "BTCUSDT" ? await env.SIGNAL_DATA.get("signal:latest", "json") : null);
    return latest ? json(latest, 200, cors) : json({ error: "まだCron判定がありません" }, 404, cors);
  }
  if (url.pathname === "/api/subscriptions" && request.method === "POST") {
    if (requestOrigin(request) && !allowedOrigin(request, env)) throw new HttpError(403, "Origin not allowed");
    return json(await saveSubscription(request, env), 201, cors);
  }
  if (url.pathname === "/api/subscriptions" && request.method === "DELETE") {
    if (requestOrigin(request) && !allowedOrigin(request, env)) throw new HttpError(403, "Origin not allowed");
    return json(await deleteSubscription(request, env), 200, cors);
  }
  if (url.pathname === "/api/test" && request.method === "POST") {
    if (requestOrigin(request) && !allowedOrigin(request, env)) throw new HttpError(403, "Origin not allowed");
    return json(await testSubscription(request, env), 200, cors);
  }
  if (url.pathname === "/api/run" && request.method === "POST") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!env.ADMIN_TOKEN || !await secretsEqual(token, env.ADMIN_TOKEN)) throw new HttpError(401, "Unauthorized");
    const result = await runMonitor(env);
    return json(result, 200, cors);
  }
  if (url.pathname === "/" && request.method === "GET") {
    return json({
      service: "Crypto Regime Watch Push Worker",
      symbols: SYMBOLS,
      health: "/api/health",
      snapshot: "/api/snapshot?symbol=BTCUSDT",
    }, 200, cors);
  }
  return json({ error: "Not found" }, 404, cors);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("request failed", error);
      return json({ error: status === 500 ? "Internal server error" : error.message }, status, corsHeaders(request, env));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runMonitor(env).then(result => {
        console.log("scheduled monitor complete", {
          scheduledTime: controller.scheduledTime,
          results: result.results.map(item => item.snapshot ? {
            symbol: item.symbol,
            state: item.snapshot.state,
            candle: item.snapshot.candleCloseTime,
            isNewCandle: item.isNewCandle,
          } : { symbol: item.symbol, error: item.error }),
          deliveries: result.deliveries,
        });
      }),
    );
  },
};
