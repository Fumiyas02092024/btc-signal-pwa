import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePositionSize,
  dmiAdx,
  emaSeries,
  evaluateStrategy,
  normalizeSymbol,
  sma,
} from "../strategy.js";

function candle(index, close, stepMs) {
  return {
    t: index * stepMs,
    o: close * 0.997,
    h: close * 1.008,
    l: close * 0.992,
    c: close,
    closeTime: (index + 1) * stepMs - 1,
  };
}

function trendCandles(count, start, growth, stepMs) {
  return Array.from({ length: count }, (_, index) => candle(index, start + index * growth, stepMs));
}

test("SMAとEMAを期待どおり計算する", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("上昇系列のDMIは+DIが-DIを上回る", () => {
  const candles = trendCandles(80, 100, 2, 4 * 60 * 60 * 1000);
  const result = dmiAdx(candles);
  assert.ok(result.plusDi.at(-1) > result.minusDi.at(-1));
  assert.ok(result.adx.at(-1) > 20);
});

test("日足がSMA200より下ならRISK_OFF", () => {
  const daily = trendCandles(220, 500, -1, 24 * 60 * 60 * 1000);
  const h4 = trendCandles(100, 200, 1, 4 * 60 * 60 * 1000);
  const result = evaluateStrategy(daily, h4);
  assert.equal(result.state, "RISK_OFF");
  assert.equal(result.regime, "BEAR_OR_NEUTRAL");
});

test("ETHも同じ戦略で銘柄を保持して判定する", () => {
  const daily = trendCandles(220, 1_000, 3, 24 * 60 * 60 * 1000);
  const h4 = trendCandles(100, 2_000, 2, 4 * 60 * 60 * 1000);
  const result = evaluateStrategy(daily, h4, { symbol: "ETHUSDT" });
  assert.equal(result.symbol, "ETHUSDT");
  assert.equal(result.scoreMax, 8);
});

test("未対応銘柄はBTCへ正規化する", () => {
  assert.equal(normalizeSymbol("ETHUSDT"), "ETHUSDT");
  assert.equal(normalizeSymbol("DOGEUSDT"), "BTCUSDT");
});

test("ポジションサイズは許容損失とStop幅から逆算する", () => {
  const result = calculatePositionSize({
    capital: 1_000_000,
    riskPercent: 0.5,
    entry: 100,
    stop: 98,
  });
  assert.equal(result.allowedLoss, 5_000);
  assert.equal(result.positionValue, 250_000);
});

test("不正なStopではポジションサイズを返さない", () => {
  assert.equal(calculatePositionSize({
    capital: 1_000_000,
    riskPercent: 0.5,
    entry: 100,
    stop: 101,
  }), null);
});
