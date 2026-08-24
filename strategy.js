export const STRATEGY_VERSION = "2026.08";

export const SUPPORTED_SYMBOLS = Object.freeze({
  BTCUSDT: Object.freeze({ symbol: "BTCUSDT", ticker: "BTC", name: "Bitcoin", glyph: "₿", priceDigits: 0 }),
  ETHUSDT: Object.freeze({ symbol: "ETHUSDT", ticker: "ETH", name: "Ethereum", glyph: "Ξ", priceDigits: 2 }),
});

export function normalizeSymbol(value) {
  return Object.hasOwn(SUPPORTED_SYMBOLS, value) ? value : "BTCUSDT";
}

const finite = value => Number.isFinite(value);

export function sma(values, period, index = values.length - 1) {
  if (index < period - 1) return null;
  let total = 0;
  for (let i = index - period + 1; i <= index; i += 1) total += values[i];
  return total / period;
}

export function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = sma(values, period, period - 1);
  const multiplier = 2 / (period + 1);
  out[period - 1] = seed;
  for (let i = period; i < values.length; i += 1) {
    out[i] = (values[i] - out[i - 1]) * multiplier + out[i - 1];
  }
  return out;
}

export function dmiAdx(candles, period = 14) {
  const length = candles.length;
  const plusDi = Array(length).fill(null);
  const minusDi = Array(length).fill(null);
  const adx = Array(length).fill(null);
  if (length <= period * 2) return { plusDi, minusDi, adx };

  const tr = Array(length).fill(0);
  const plusDm = Array(length).fill(0);
  const minusDm = Array(length).fill(0);

  for (let i = 1; i < length; i += 1) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  }

  let smoothedTr = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;
  for (let i = 1; i <= period; i += 1) {
    smoothedTr += tr[i];
    smoothedPlus += plusDm[i];
    smoothedMinus += minusDm[i];
  }

  const dx = Array(length).fill(null);
  const updateDirectional = index => {
    plusDi[index] = smoothedTr ? (100 * smoothedPlus) / smoothedTr : 0;
    minusDi[index] = smoothedTr ? (100 * smoothedMinus) / smoothedTr : 0;
    const sum = plusDi[index] + minusDi[index];
    dx[index] = sum ? (100 * Math.abs(plusDi[index] - minusDi[index])) / sum : 0;
  };

  updateDirectional(period);
  for (let i = period + 1; i < length; i += 1) {
    smoothedTr = smoothedTr - smoothedTr / period + tr[i];
    smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[i];
    smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[i];
    updateDirectional(i);
  }

  const firstAdxIndex = period * 2 - 1;
  let dxTotal = 0;
  for (let i = period; i <= firstAdxIndex; i += 1) dxTotal += dx[i];
  adx[firstAdxIndex] = dxTotal / period;
  for (let i = firstAdxIndex + 1; i < length; i += 1) {
    adx[i] = ((adx[i - 1] * (period - 1)) + dx[i]) / period;
  }

  return { plusDi, minusDi, adx };
}

export function normalizeKlines(rows) {
  return rows.map(row => {
    if (!Array.isArray(row)) return row;
    return {
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      closeTime: Number(row[6]),
    };
  });
}

export function closedCandles(candles, now = Date.now()) {
  return candles.filter(candle => candle.closeTime < now - 2_000);
}

function highest(candles, start, end) {
  let value = -Infinity;
  for (let i = Math.max(0, start); i <= Math.min(end, candles.length - 1); i += 1) {
    value = Math.max(value, candles[i].h);
  }
  return finite(value) ? value : null;
}

function lowest(candles, start, end) {
  let value = Infinity;
  for (let i = Math.max(0, start); i <= Math.min(end, candles.length - 1); i += 1) {
    value = Math.min(value, candles[i].l);
  }
  return finite(value) ? value : null;
}

function findBreakoutRetest(candles) {
  const last = candles.length - 1;
  for (let breakoutIndex = last - 1; breakoutIndex >= last - 4; breakoutIndex -= 1) {
    const level = highest(candles, breakoutIndex - 20, breakoutIndex - 1);
    if (!level || candles[breakoutIndex].c <= level) continue;
    const retestCandles = candles.slice(breakoutIndex + 1);
    if (!retestCandles.length) continue;
    const held = retestCandles.some(candle => candle.l <= level * 1.008)
      && candles[last].c >= level
      && candles[last].c > candles[last].o;
    if (held) return { active: true, level, breakoutTime: candles[breakoutIndex].closeTime };
  }
  return { active: false, level: null, breakoutTime: null };
}

function round(value, digits = 2) {
  if (!finite(value)) return null;
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function condition(id, label, pass, value, required = true) {
  return { id, label, pass: Boolean(pass), value, required };
}

export function evaluateStrategy(dailyInput, h4Input, options = {}) {
  const symbol = normalizeSymbol(options.symbol);
  const daily = [...dailyInput].sort((a, b) => a.closeTime - b.closeTime);
  const h4 = [...h4Input].sort((a, b) => a.closeTime - b.closeTime);
  if (daily.length < 205 || h4.length < 60) {
    throw new Error("戦略判定に必要な確定足が不足しています");
  }

  const dailyCloses = daily.map(candle => candle.c);
  const h4Closes = h4.map(candle => candle.c);
  const d = daily.length - 1;
  const h = h4.length - 1;

  const dailySma20 = sma(dailyCloses, 20, d);
  const dailySma20Past = sma(dailyCloses, 20, d - 5);
  const dailySma200 = sma(dailyCloses, 200, d);
  const dailySma200Past = sma(dailyCloses, 200, d - 5);
  const ema20Series = emaSeries(h4Closes, 20);
  const ema20 = ema20Series[h];
  const ema20Past = ema20Series[h - 3];
  const dmi = dmiAdx(h4, 14);
  const adx = dmi.adx[h];
  const adxPast = dmi.adx[h - 3];
  const plusDi = dmi.plusDi[h];
  const minusDi = dmi.minusDi[h];

  const dailyClose = daily[d].c;
  const h4Close = h4[h].c;
  const sma200Rising = dailySma200 > dailySma200Past;
  const sma20Rising = dailySma20 > dailySma20Past;
  const regimeBullish = dailyClose > dailySma200 && sma200Rising && sma20Rising;
  const emaRising = ema20 > ema20Past;
  const adxStrong = adx >= 20;
  const adxStable = adx >= adxPast - 0.5;
  const dmiBullish = plusDi > minusDi;

  const pullbackDistancePct = ((h4Close - ema20) / ema20) * 100;
  const touchedEma = h4[h].l <= ema20 * 1.012 && h4[h].h >= ema20 * 0.988;
  const bullishConfirmation = h4[h].c > h4[h].o && h4[h].c > h4[h - 1].c;
  const recentSupport = lowest(h4, h - 10, h - 1);
  const structureHeld = h4[h].c >= recentSupport && h4[h].l >= recentSupport * 0.992;
  const pullback = {
    active: touchedEma && bullishConfirmation && structureHeld && Math.abs(pullbackDistancePct) <= 2,
    distancePct: pullbackDistancePct,
  };
  const breakoutRetest = findBreakoutRetest(h4);
  const setupType = breakoutRetest.active ? "breakout-retest" : pullback.active ? "pullback" : "none";
  const setupConfirmed = setupType !== "none";

  const entry = setupType === "pullback"
    ? Math.max(h4[h].h, h4Close)
    : setupType === "breakout-retest"
      ? h4Close
      : h4Close;
  const stopAnchor = setupType === "breakout-retest"
    ? Math.min(recentSupport, breakoutRetest.level)
    : Math.min(recentSupport, h4[h].l);
  const stop = stopAnchor * 0.997;
  const risk = entry - stop;
  const riskPct = risk > 0 ? (risk / entry) * 100 : null;
  const dailyResistance = highest(daily, d - 60, d - 1);
  const h4Resistance = highest(h4, h - 50, h - 2);
  const relevantResistance = [dailyResistance, h4Resistance]
    .filter(level => level > entry)
    .sort((a, b) => a - b)[0] ?? null;
  const roomR = risk > 0 && relevantResistance ? (relevantResistance - entry) / risk : 3;
  const rewardRiskOk = risk > 0 && roomR >= 1.5;

  const conditions = [
    condition("daily_above_sma200", "日足終値 > SMA200", dailyClose > dailySma200, round(dailyClose)),
    condition("sma200_rising", "日足SMA200が上向き", sma200Rising, `${round(((dailySma200 / dailySma200Past) - 1) * 100, 3)}% / 5日`),
    condition("sma20_rising", "日足SMA20が上向き", sma20Rising, `${round(((dailySma20 / dailySma20Past) - 1) * 100, 3)}% / 5日`),
    condition("h4_setup", "4時間足の押し目 / ブレイク・リテスト", setupConfirmed, setupType),
    condition("dmi_bullish", "+DI > -DI", dmiBullish, `${round(plusDi, 1)} / ${round(minusDi, 1)}`),
    condition("adx", "ADX 20以上", adxStrong, round(adx, 1)),
    condition("adx_stable", "ADXが横ばいまたは上昇", adxStable, `${round(adxPast, 1)} → ${round(adx, 1)}`),
    condition("reward_risk", "上値余地が1.5R以上", rewardRiskOk, `${round(roomR, 2)}R`),
  ];

  const passed = conditions.filter(item => item.pass).length;
  let state = "WAIT";
  let headline = "条件が整うまで待機";
  if (!regimeBullish) {
    state = "RISK_OFF";
    headline = "新規ロング見送り";
  } else if (conditions.every(item => !item.required || item.pass)) {
    state = "READY";
    headline = setupType === "pullback" ? "押し目買い候補" : "ブレイク・リテスト候補";
  } else if (passed >= 6 && dmiBullish && adxStrong) {
    state = "WATCH";
    headline = "ロング候補を監視";
  }

  const blockers = conditions.filter(item => item.required && !item.pass).map(item => item.label);
  const target1 = risk > 0 ? entry + risk : null;
  const target2 = risk > 0 ? entry + risk * 2 : null;

  return {
    version: STRATEGY_VERSION,
    symbol,
    evaluatedAt: Date.now(),
    candleCloseTime: h4[h].closeTime,
    state,
    headline,
    score: passed,
    scoreMax: conditions.length,
    regime: regimeBullish ? "BULL" : dailyClose < dailySma200 || !sma200Rising ? "BEAR_OR_NEUTRAL" : "CAUTION",
    setupType,
    conditions,
    blockers,
    levels: {
      entry: round(entry),
      stop: round(stop),
      target1: round(target1),
      target2: round(target2),
      resistance: round(relevantResistance),
      breakoutLevel: round(breakoutRetest.level),
      support: round(recentSupport),
      riskPct: round(riskPct, 2),
      roomR: round(roomR, 2),
    },
    daily: {
      close: round(dailyClose),
      sma20: round(dailySma20),
      sma200: round(dailySma200),
      sma20Rising,
      sma200Rising,
    },
    h4: {
      close: round(h4Close),
      ema20: round(ema20),
      ema20Rising: emaRising,
      adx: round(adx, 2),
      adxPast: round(adxPast, 2),
      plusDi: round(plusDi, 2),
      minusDi: round(minusDi, 2),
      pullbackDistancePct: round(pullbackDistancePct, 2),
    },
    strategyComparison: [
      { id: "A", label: "価格 + SMA20", active: dailyClose > dailySma20 },
      { id: "B", label: "価格 + SMA200", active: dailyClose > dailySma200 },
      { id: "C", label: "SMA20 + SMA200", active: regimeBullish && pullback.active },
      { id: "D", label: "SMA + ADX/DMI", active: state === "READY" },
    ],
  };
}

export function calculatePositionSize({ capital, riskPercent, entry, stop }) {
  const values = [capital, riskPercent, entry, stop].map(Number);
  if (!values.every(value => finite(value) && value > 0) || entry <= stop) return null;
  const allowedLoss = capital * (riskPercent / 100);
  const stopDistancePct = (entry - stop) / entry;
  return {
    allowedLoss,
    stopDistancePct: stopDistancePct * 100,
    positionValue: allowedLoss / stopDistancePct,
  };
}
