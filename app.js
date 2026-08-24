import {
  calculatePositionSize,
  closedCandles,
  emaSeries,
  evaluateStrategy,
  normalizeKlines,
  normalizeSymbol,
  SUPPORTED_SYMBOLS,
} from "./strategy.js";

const API_HOSTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://data-api.binance.vision",
];
const POLL_MS = 5 * 60 * 1000;
const $ = id => document.getElementById(id);

let snapshot = null;
let h4Candles = [];
let activeSymbol = normalizeSymbol(new URLSearchParams(location.search).get("symbol")
  || localStorage.getItem("regimeWatchSymbol"));
let serviceWorkerRegistration = null;
let toastTimer;
let workerUrl = normalizeWorkerUrl(
  localStorage.getItem("btcWorkerUrl") || window.BTC_CONFIG?.workerUrl || "",
);

function normalizeWorkerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function money(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function yen(value) {
  if (!Number.isFinite(value)) return "—";
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

function dateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function setTone(element, tone) {
  element.classList.remove("positive", "negative", "warning");
  if (tone) element.classList.add(tone);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body.error ? `: ${body.error}` : "";
    } catch {}
    throw new Error(`HTTP ${response.status}${detail}`);
  }
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
  throw lastError || new Error("価格データを取得できません");
}

function decisionDescription(result) {
  if (result.state === "READY") {
    return `${result.headline}です。価格構造を再確認し、損切りを先に決めてから執行してください。急騰を追いかけず、最低1.5Rの上値余地を維持します。`;
  }
  if (result.state === "WATCH") {
    return "長期レジームとトレンド強度は概ね良好です。4時間足の反転確定、またはブレイク後のリテストを待ちます。";
  }
  if (result.state === "RISK_OFF") {
    return "日足の長期フィルターが新規ロングを許可していません。SMA200を予測線ではなく、取引を休むためのフィルターとして扱います。";
  }
  return "一部の条件が未成立です。レンジ中央、水平な移動平均線、ADX低下中のエントリーは見送ります。";
}

function setupLabel(value) {
  if (value === "pullback") return "押し目";
  if (value === "breakout-retest") return "ブレイク・リテスト";
  return "未確定";
}

function renderSnapshot(result) {
  snapshot = result;
  const asset = SUPPORTED_SYMBOLS[result.symbol];
  document.title = `${asset.ticker} Regime Watch`;
  $("brandMark").textContent = asset.glyph;
  $("brandMark").classList.toggle("eth", result.symbol === "ETHUSDT");
  $("assetCaption").textContent = `${asset.ticker} / USDT`;
  $("brandAsset").textContent = `${asset.ticker} / USDT · LONG ONLY`;
  $("chart").setAttribute("aria-label", `${asset.ticker} 4時間足チャート`);
  const panel = $("signalPanel");
  panel.dataset.state = result.state;
  $("stateBadge").textContent = result.state;
  $("headline").textContent = result.headline;
  $("score").textContent = result.score;
  $("scoreRing").style.setProperty("--score", result.score);
  $("decisionCopy").textContent = decisionDescription(result);

  const blockers = $("blockers");
  blockers.replaceChildren(...result.blockers.slice(0, 4).map(label => {
    const item = document.createElement("span");
    item.textContent = `未成立 · ${label}`;
    return item;
  }));

  $("price").textContent = money(result.h4.close, asset.priceDigits);
  const latest = h4Candles.at(-1);
  const previous = h4Candles.at(-2);
  const change = latest && previous ? ((latest.c / previous.c) - 1) * 100 : 0;
  $("priceChange").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}% / 直近4H · ${dateTime(result.candleCloseTime)}確定`;
  $("priceChange").className = `price-change ${change >= 0 ? "up" : "down"}`;

  const bull = result.regime === "BULL";
  $("regime").textContent = bull ? "強気" : "見送り";
  setTone($("regime"), bull ? "positive" : "negative");
  $("regimeDetail").textContent = `終値 ${money(result.daily.close, asset.priceDigits)} / SMA200 ${money(result.daily.sma200, asset.priceDigits)}`;

  $("dailyTrend").textContent = result.daily.sma20Rising ? "上向き" : "横ばい・下向き";
  setTone($("dailyTrend"), result.daily.sma20Rising ? "positive" : "warning");
  $("dailyTrendDetail").textContent = `SMA20 ${money(result.daily.sma20, asset.priceDigits)}`;

  $("adx").textContent = result.h4.adx >= 25 ? "明確" : result.h4.adx >= 20 ? "発生中" : "弱い";
  setTone($("adx"), result.h4.adx >= 20 ? "positive" : "warning");
  $("adxDetail").textContent = `ADX ${result.h4.adx.toFixed(1)} · +DI ${result.h4.plusDi.toFixed(1)} · -DI ${result.h4.minusDi.toFixed(1)}`;

  $("setup").textContent = setupLabel(result.setupType);
  setTone($("setup"), result.setupType !== "none" ? "positive" : "warning");
  $("setupDetail").textContent = `終値とEMA20の距離 ${result.h4.pullbackDistancePct.toFixed(2)}%`;

  const checklist = $("checklist");
  checklist.replaceChildren(...result.conditions.map(item => {
    const row = document.createElement("div");
    row.className = `check-item ${item.pass ? "pass" : ""}`;
    const icon = document.createElement("span");
    icon.className = "check-icon";
    icon.textContent = item.pass ? "✓" : "·";
    const label = document.createElement("span");
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "check-value";
    value.textContent = item.value ?? "—";
    row.append(icon, label, value);
    return row;
  }));

  $("entryLevel").textContent = money(result.levels.entry, asset.priceDigits);
  $("stopLevel").textContent = money(result.levels.stop, asset.priceDigits);
  $("target1Level").textContent = money(result.levels.target1, asset.priceDigits);
  $("target2Level").textContent = money(result.levels.target2, asset.priceDigits);

  const steps = $("strategySteps");
  steps.replaceChildren(...result.strategyComparison.map(item => {
    const step = document.createElement("div");
    step.className = `strategy-step ${item.active ? "active" : ""}`;
    step.dataset.id = `STRATEGY ${item.id}`;
    const label = document.createElement("strong");
    label.textContent = item.label;
    step.append(label);
    return step;
  }));

  renderPosition();
  renderHistory(result);
  drawChart();
}

function renderPosition() {
  if (!snapshot) return;
  const position = calculatePositionSize({
    capital: Number($("capital").value),
    riskPercent: Number($("riskPercent").value),
    entry: snapshot.levels.entry,
    stop: snapshot.levels.stop,
  });
  if (!position) {
    $("positionValue").textContent = "—";
    $("positionDetail").textContent = "有効な価格を入力してください";
    return;
  }
  $("positionValue").textContent = yen(position.positionValue);
  $("positionDetail").textContent = `許容損失 ${yen(position.allowedLoss)} · Stop幅 ${position.stopDistancePct.toFixed(2)}%`;
}

function renderHistory(result) {
  const historyKey = `regimeDecisionHistory:${result.symbol}`;
  const legacyHistory = result.symbol === "BTCUSDT" ? localStorage.getItem("btcDecisionHistory") : null;
  const history = JSON.parse(localStorage.getItem(historyKey) || legacyHistory || "[]");
  if (!localStorage.getItem(historyKey) && legacyHistory) {
    localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 30)));
  }
  if (!history.some(item => item.candleCloseTime === result.candleCloseTime)) {
    history.unshift({
      candleCloseTime: result.candleCloseTime,
      state: result.state,
      headline: result.headline,
      score: result.score,
    });
    localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 30)));
  }

  const current = JSON.parse(localStorage.getItem(historyKey) || "[]");
  const container = $("history");
  if (!current.length) return;
  container.replaceChildren(...current.slice(0, 12).map(item => {
    const row = document.createElement("div");
    row.className = "history-item";
    const state = document.createElement("span");
    state.className = `history-state ${item.state === "READY" ? "positive" : item.state === "RISK_OFF" ? "negative" : ""}`;
    state.textContent = item.state;
    const detail = document.createElement("span");
    detail.textContent = item.headline;
    const meta = document.createElement("span");
    meta.className = "history-score";
    meta.textContent = `${item.score}/8 · ${dateTime(item.candleCloseTime)}`;
    row.append(state, detail, meta);
    return row;
  }));
}

function drawChart() {
  if (h4Candles.length < 30 || !snapshot) return;
  const canvas = $("chart");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(280, rect.width);
  const height = Math.max(240, rect.height);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  context.clearRect(0, 0, width, height);

  const view = h4Candles.slice(-72);
  const closes = h4Candles.map(candle => candle.c);
  const ema = emaSeries(closes, 20).slice(-view.length);
  const padding = { left: 4, right: 67, top: 10, bottom: 25 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const extraLevels = [
    snapshot.levels.support,
    snapshot.levels.resistance,
    snapshot.levels.breakoutLevel,
  ].filter(Number.isFinite);
  let low = Math.min(...view.map(candle => candle.l), ...extraLevels);
  let high = Math.max(...view.map(candle => candle.h), ...extraLevels);
  const margin = (high - low) * 0.05 || 1;
  low -= margin;
  high += margin;
  const x = index => padding.left + ((index + 0.5) / view.length) * plotWidth;
  const y = value => padding.top + ((high - value) / (high - low)) * plotHeight;

  context.font = "10px ui-sans-serif";
  context.textBaseline = "middle";
  context.strokeStyle = "rgba(139,163,155,.12)";
  context.fillStyle = "#718a82";
  for (let i = 0; i <= 4; i += 1) {
    const price = low + ((high - low) * i) / 4;
    const yy = y(price);
    context.beginPath();
    context.moveTo(padding.left, yy);
    context.lineTo(width - padding.right, yy);
    context.stroke();
    const digits = SUPPORTED_SYMBOLS[activeSymbol].priceDigits;
    context.fillText(`$${price.toLocaleString("en-US", { maximumFractionDigits: digits })}`, width - padding.right + 8, yy);
  }

  const candleWidth = Math.max(2, (plotWidth / view.length) * 0.62);
  view.forEach((candle, index) => {
    const rising = candle.c >= candle.o;
    context.strokeStyle = context.fillStyle = rising ? "#42d99c" : "#ff6f66";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x(index), y(candle.h));
    context.lineTo(x(index), y(candle.l));
    context.stroke();
    const top = y(Math.max(candle.o, candle.c));
    const bottom = y(Math.min(candle.o, candle.c));
    context.fillRect(x(index) - candleWidth / 2, top, candleWidth, Math.max(1.5, bottom - top));
  });

  context.beginPath();
  ema.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (index === 0 || !Number.isFinite(ema[index - 1])) context.moveTo(x(index), y(value));
    else context.lineTo(x(index), y(value));
  });
  context.strokeStyle = "#ffcc66";
  context.lineWidth = 1.7;
  context.stroke();

  const drawLevel = (value, color, label) => {
    if (!Number.isFinite(value) || value < low || value > high) return;
    context.save();
    context.setLineDash([5, 5]);
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(padding.left, y(value));
    context.lineTo(width - padding.right, y(value));
    context.stroke();
    context.restore();
    context.fillStyle = color;
    context.fillText(label, padding.left + 6, y(value) - 9);
  };
  drawLevel(snapshot.levels.support, "#65a5ff", "SUPPORT");
  drawLevel(snapshot.levels.resistance, "#bc8cff", "RESISTANCE");
  drawLevel(snapshot.levels.breakoutLevel, "#bbf451", "RETEST");

  context.fillStyle = "#718a82";
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let index = 0; index < view.length; index += 18) {
    const date = new Date(view[index].closeTime);
    context.fillText(`${date.getMonth() + 1}/${date.getDate()}`, x(index), height - 17);
  }
  context.textAlign = "start";
}

async function update() {
  $("connection").className = "connection";
  $("connectionText").textContent = "更新中";
  $("refreshButton").disabled = true;
  try {
    const symbolAtRequest = activeSymbol;
    const market = await fetchMarketData(symbolAtRequest);
    if (symbolAtRequest !== activeSymbol) return;
    h4Candles = market.h4;
    renderSnapshot(evaluateStrategy(market.daily, market.h4, { symbol: symbolAtRequest }));
    $("connection").className = "connection online";
    $("connectionText").textContent = `更新 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    $("connection").className = "connection error";
    $("connectionText").textContent = "取得エラー";
    toast(`データ取得に失敗しました: ${error.message}`);
  } finally {
    $("refreshButton").disabled = false;
  }
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(character => character.charCodeAt(0)));
}

async function currentSubscription() {
  if (!serviceWorkerRegistration) return null;
  return serviceWorkerRegistration.pushManager.getSubscription();
}

async function updatePushUi() {
  const subscription = await currentSubscription();
  const enabled = Boolean(subscription);
  $("pushStatus").textContent = enabled ? "配信中" : workerUrl ? "接続可能" : "未設定";
  $("pushStatus").classList.toggle("active", enabled);
  $("pushButton").textContent = enabled ? "通知を解除" : "通知を設定";
}

function subscriptionPayload(subscription) {
  return {
    subscription: subscription.toJSON(),
    preferences: {
      notifyWatch: $("watchToggle").checked,
      notifyRiskOff: true,
      symbols: [
        ...($("notifyBtcToggle").checked ? ["BTCUSDT"] : []),
        ...($("notifyEthToggle").checked ? ["ETHUSDT"] : []),
      ],
    },
  };
}

async function enablePush() {
  if (!workerUrl) {
    openSettings();
    return;
  }
  if (!("Notification" in window) || !serviceWorkerRegistration?.pushManager) {
    toast("この環境はWeb Pushに対応していません");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("通知の許可が必要です");
    return;
  }
  const config = await fetchJson(`${workerUrl}/api/config`);
  let subscription = await currentSubscription();
  if (!subscription) {
    subscription = await serviceWorkerRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey),
    });
  }
  await fetchJson(`${workerUrl}/api/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionPayload(subscription)),
  });
  await fetchJson(`${workerUrl}/api/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  await updatePushUi();
  toast("バックグラウンド通知を有効にしました");
}

async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  if (workerUrl) {
    try {
      await fetchJson(`${workerUrl}/api/subscriptions`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    } catch {}
  }
  await subscription.unsubscribe();
  await updatePushUi();
  toast("通知を解除しました");
}

async function togglePush() {
  $("pushButton").disabled = true;
  try {
    const subscription = await currentSubscription();
    if (subscription) await disablePush();
    else await enablePush();
  } catch (error) {
    toast(`通知設定に失敗しました: ${error.message}`);
  } finally {
    $("pushButton").disabled = false;
  }
}

async function updatePreferences() {
  localStorage.setItem("btcNotifyWatch", $("watchToggle").checked ? "1" : "0");
  localStorage.setItem("regimeNotifyBTC", $("notifyBtcToggle").checked ? "1" : "0");
  localStorage.setItem("regimeNotifyETH", $("notifyEthToggle").checked ? "1" : "0");
  const subscription = await currentSubscription();
  if (!subscription || !workerUrl) return;
  try {
    await fetchJson(`${workerUrl}/api/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscriptionPayload(subscription)),
    });
    toast("通知条件を更新しました");
  } catch (error) {
    toast(`通知条件の更新に失敗しました: ${error.message}`);
  }
}

async function selectAsset(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (normalized === activeSymbol && snapshot) return;
  activeSymbol = normalized;
  snapshot = null;
  h4Candles = [];
  localStorage.setItem("regimeWatchSymbol", activeSymbol);
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("symbol", activeSymbol);
  history.replaceState(null, "", nextUrl);
  document.querySelectorAll("[data-symbol]").forEach(button => {
    const selected = button.dataset.symbol === activeSymbol;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  $("assetCaption").textContent = `${SUPPORTED_SYMBOLS[activeSymbol].ticker} / USDT`;
  $("brandAsset").textContent = `${SUPPORTED_SYMBOLS[activeSymbol].ticker} / USDT · LONG ONLY`;
  $("brandMark").textContent = SUPPORTED_SYMBOLS[activeSymbol].glyph;
  $("brandMark").classList.toggle("eth", activeSymbol === "ETHUSDT");
  $("price").textContent = "—";
  $("priceChange").textContent = "4時間足を取得中";
  $("history").innerHTML = '<p class="empty">最初の判定を待っています。</p>';
  await update();
}

function openSettings() {
  $("workerUrl").value = workerUrl;
  $("settingsDialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const nextUrl = normalizeWorkerUrl($("workerUrl").value);
  if (!/^https:\/\/[^/]+/i.test(nextUrl) && !/^http:\/\/localhost(?::\d+)?$/i.test(nextUrl)) {
    toast("HTTPSのWorker URLを入力してください");
    return;
  }
  $("saveSettings").disabled = true;
  try {
    const health = await fetchJson(`${nextUrl}/api/health`);
    if (!health.ok) throw new Error("Workerが正常応答しません");
    workerUrl = nextUrl;
    localStorage.setItem("btcWorkerUrl", workerUrl);
    $("settingsDialog").close();
    await updatePushUi();
    toast("Workerへ接続しました");
  } catch (error) {
    toast(`接続できません: ${error.message}`);
  } finally {
    $("saveSettings").disabled = false;
  }
}

async function initialize() {
  $("watchToggle").checked = localStorage.getItem("btcNotifyWatch") === "1";
  $("notifyBtcToggle").checked = localStorage.getItem("regimeNotifyBTC") !== "0";
  $("notifyEthToggle").checked = localStorage.getItem("regimeNotifyETH") !== "0";
  $("capital").addEventListener("input", renderPosition);
  $("riskPercent").addEventListener("change", renderPosition);
  $("refreshButton").addEventListener("click", update);
  $("pushButton").addEventListener("click", togglePush);
  $("settingsButton").addEventListener("click", openSettings);
  $("saveSettings").addEventListener("click", saveSettings);
  $("watchToggle").addEventListener("change", updatePreferences);
  $("notifyBtcToggle").addEventListener("change", updatePreferences);
  $("notifyEthToggle").addEventListener("change", updatePreferences);
  document.querySelectorAll("[data-symbol]").forEach(button => {
    button.addEventListener("click", () => selectAsset(button.dataset.symbol));
    const selected = button.dataset.symbol === activeSymbol;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  const initialAsset = SUPPORTED_SYMBOLS[activeSymbol];
  $("assetCaption").textContent = `${initialAsset.ticker} / USDT`;
  $("brandAsset").textContent = `${initialAsset.ticker} / USDT · LONG ONLY`;
  $("brandMark").textContent = initialAsset.glyph;
  $("brandMark").classList.toggle("eth", activeSymbol === "ETHUSDT");
  window.addEventListener("resize", drawChart);

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      serviceWorkerRegistration = await navigator.serviceWorker.ready;
    } catch (error) {
      console.warn("Service Worker registration failed", error);
    }
  }
  await updatePushUi();
  await update();
  setInterval(update, POLL_MS);
}

initialize();
