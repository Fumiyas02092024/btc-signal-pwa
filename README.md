# BTC Regime Watch

BTC/USDTの「買ってよい相場だけを選ぶ」ためのロング限定PWAです。日足のSMA200をレジームフィルター、日足SMA20と4時間足EMA20をトレンド・押し目判定、ADX/DMIをトレンド強度の確認に使います。

Cloudflare WorkersのCron TriggerとWeb Pushを組み合わせているため、ブラウザのタブやインストール済みPWAを閉じている間も確定足を監視して通知できます。

## 戦略

エントリー候補（`READY`）は、次の8条件を確定足ですべて満たした場合だけ表示します。

1. 日足終値が日足SMA200より上
2. 日足SMA200が5日前より上
3. 日足SMA20が5日前より上
4. 4時間足でEMA20への押し目反転、またはブレイク・リテストを確認
5. 4時間足の `+DI > -DI`
6. 4時間足ADXが20以上
7. ADXが3本前と比べて横ばいまたは上昇
8. 直近レジスタンスまで1.5R以上

ショート、RSI、MACD、ボリンジャーバンド、単純な移動平均クロスは採用していません。

| 状態 | 意味 | デフォルト通知 |
|---|---|---|
| `READY` | 8条件成立。価格構造を再確認して買いを検討 | 通知する |
| `WATCH` | 6条件以上成立。反転・リテスト確定待ち | 設定で選択 |
| `WAIT` | 条件不足。見送り | 通知しない |
| `RISK_OFF` | 日足レジームが新規ロングを許可しない | 強気からの変化時に通知 |

判定値は売買助言ではありません。経済イベント、週足水平線、手数料、スリッページ、実際の約定可否は別途確認してください。

## 構成

```text
GitHub Pages (PWA)
├── Binance公開APIから画面表示用データを取得
├── strategy.jsで日足・4時間足を同一ルールで判定
└── Push APIで端末をCloudflare Workerへ購読登録

Cloudflare Worker
├── Cron (15分ごと) で確定足を確認
├── strategy.jsと同じ判定ロジックを実行
├── KVに最新状態・購読先・配信カーソルを保存
└── 状態変化をWeb Pushサービスへ暗号化配信

Service Worker
└── アプリ終了中もpushイベントを受信してOS通知を表示
```

Workerは同じ4時間足を二重通知しません。購読数が1回の実行で処理できる件数を超えた場合はKVカーソルを保存し、次回Cronで続きを配信します。Pushサービスが`404`または`410`を返した購読は自動削除します。

## ローカル確認

Node.js 20以上が必要です。

```bash
npm install
npm test
python3 -m http.server 8321
```

ブラウザで `http://localhost:8321` を開きます。localhostではPWAとService Workerを確認できます。

## Cloudflare Workerを無料枠で設定

CloudflareアカウントとWranglerへのログインが必要です。

### 1. KVを作成

```bash
npx wrangler login
npx wrangler kv namespace create SIGNAL_DATA --config worker/wrangler.jsonc
```

表示されたKV namespace IDを [worker/wrangler.jsonc](worker/wrangler.jsonc) の `REPLACE_WITH_KV_NAMESPACE_ID` と置き換えます。

### 2. 公開元とVAPID連絡先を設定

[worker/wrangler.jsonc](worker/wrangler.jsonc) の次を編集します。

- `APP_ORIGIN`: GitHub PagesのOrigin。例: `https://fumiyas02092024.github.io`
- `VAPID_SUBJECT`: 管理者の `mailto:` URL。例: `mailto:alerts@example.com`

別Originを複数許可する場合は `APP_ORIGIN` をカンマ区切りにします。購読登録APIは、それ以外のブラウザOriginを拒否します。

### 3. VAPID鍵と管理用トークンをSecretへ登録

```bash
npm run vapid
npx wrangler secret put VAPID_PUBLIC_KEY --config worker/wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config worker/wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.jsonc
```

`npm run vapid` が出力した対応する公開鍵・秘密鍵を貼り付けます。`ADMIN_TOKEN`には十分に長いランダム値を設定してください。SecretをGitへコミットしないでください。

### 4. Workerをデプロイ

```bash
npm run deploy
```

デプロイ後に表示される `https://...workers.dev` URLを控えます。

### 5. PWAへWorker URLを設定

方法は2つあります。

- リポジトリの [config.js](config.js) にWorker URLを設定してGitHub Pagesを再公開
- アプリの「Worker URL」ボタンから端末ごとに入力

`config.js` の例:

```js
window.BTC_CONFIG = {
  workerUrl: "https://btc-regime-watch.YOUR_SUBDOMAIN.workers.dev",
};
```

### 6. 初回監視を手動実行

Cronは反映まで時間がかかることがあります。初回だけ管理APIを呼び出すと、最新スナップショットをKVへ保存できます。

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://YOUR_WORKER.workers.dev/api/run
```

以後は `7,22,37,52 * * * *`（UTC）のCronで15分ごとに確認します。シグナル判定自体は新しい4時間足が確定したときだけ更新されます。

## スマートフォンの通知設定

### iPhone / iPad

1. iOS / iPadOS 16.4以降を使用
2. SafariでGitHub Pagesを開く
3. 共有メニューから「ホーム画面に追加」
4. ホーム画面からPWAを起動
5. 「通知を設定」を押して許可

### Android

1. ChromeでGitHub Pagesを開く
2. メニューから「アプリをインストール」
3. PWAを起動して「通知を設定」を押す

Web PushはPWAを閉じても受信できますが、OSの省電力設定、通知設定、ネットワーク状態、Pushサービスの配送状況により遅延する場合があります。

## API

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/health` | ヘルスチェック |
| `GET` | `/api/config` | VAPID公開鍵 |
| `GET` | `/api/snapshot` | Cronの最新判定 |
| `POST` | `/api/subscriptions` | 購読登録・通知設定更新 |
| `DELETE` | `/api/subscriptions` | 購読解除 |
| `POST` | `/api/test` | 24時間に1回のテスト通知 |
| `POST` | `/api/run` | 管理者による手動監視実行 |

## 無料枠の目安

この構成はCloudflare Workers Freeで利用できます。Cronは1日96回、KVの状態書き込みは主に4時間足確定時、購読書き込みは端末設定時だけです。利用者が増えた場合は、Workersの1日リクエスト数、KVの読み書き・list回数、1回のWorker実行における外部サブリクエスト数を監視してください。

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Web Push API (MDN)](https://developer.mozilla.org/docs/Web/API/Push_API)

## 検証

```bash
npm run check
```

テストはSMA/EMA、Wilder方式のADX/DMI、弱気レジーム判定、損切り幅からのポジションサイズ計算を確認します。
