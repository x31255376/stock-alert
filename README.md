# 股票提醒（手機網頁版）

設定美股條件（價格、漲跌幅、RSI、KD、均線、成交量，可以多個條件組合），條件達成就通知用戶。
通知方式：網頁推播、Telegram、Discord、Email。

整個系統跑在 Cloudflare 上：

- **網頁**：`public/` 資料夾（手機優先，可「加入主畫面」當 App 用）
- **後端**：`src/` 資料夾，負責帳號、自選股、提醒設定
- **每分鐘排程**：查股價 → 算指標 → 檢查條件 → 發通知
- **資料庫**：Cloudflare D1（第一次執行時自動建立資料表）

沒有設定股價 API 時會自動進入**示範模式**（模擬股價），部署完就能先試用。

---

## 部署步驟（第一次大約 20 分鐘）

### 1. 準備帳號

- [GitHub](https://github.com)：放程式碼
- [Cloudflare](https://dash.cloudflare.com/sign-up)：跑網頁和後端（免費方案即可）

### 2. 把程式放上 GitHub

1. GitHub 右上角「+」→「New repository」，名稱填 `stock-alert`，選 Private，建立。
2. 在新 repo 頁面點「uploading an existing file」，把這個資料夾裡的**所有檔案和資料夾**拖進去（不用上傳 `node_modules`），按「Commit changes」。

### 3. 建立資料庫

1. Cloudflare 後台左側「Storage & databases」→「D1 SQL database」→「Create」。
2. 名稱填 `stock-alert`，建立。
3. 複製頁面上的 **Database ID**（一長串英數字）。
4. 回到 GitHub，打開 `wrangler.jsonc` → 點鉛筆圖示編輯 → 把 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 換成剛剛的 ID → Commit。

### 4. 部署

1. Cloudflare 後台「Workers & Pages」→「Create」→「Import a repository」。
2. 連接你的 GitHub，選 `stock-alert`。
3. 部署指令（Deploy command）保持 `npx wrangler deploy`，按「Deploy」。
4. 完成後會拿到一個網址，像 `https://stock-alert.你的帳號.workers.dev`。用手機打開，應該會看到「示範模式」。

之後只要改 GitHub 上的程式，Cloudflare 會自動重新部署。

### 5. 設定金鑰（開啟真實股價和通知）

在 Cloudflare：Workers & Pages → `stock-alert` →「Settings」→「Variables and Secrets」→「Add」，類型選 **Secret**，逐一加入：

| 名稱 | 用途 | 去哪裡拿 | 必要？ |
|---|---|---|---|
| `FINNHUB_KEY` | 即時股價、股票搜尋 | [finnhub.io](https://finnhub.io/register) 免費註冊後的 API Key | 必要（沒有就是示範模式） |
| `TWELVEDATA_KEY` | 技術指標用的日線資料 | [twelvedata.com](https://twelvedata.com/register) 免費註冊後的 API Key | 要用 RSI/KD/均線/成交量就必要 |
| `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` | 網頁推播 | 打開 `你的網址/setup`，按「產生金鑰」 | 要網頁推播就必要 |
| `TELEGRAM_BOT_TOKEN` | Telegram 通知 | Telegram 搜尋 @BotFather → `/newbot` → 照指示取名 → 拿到 token | 選用 |
| `RESEND_API_KEY`、`EMAIL_FROM` | Email 通知 | [resend.com](https://resend.com)；需要驗證自己的網域，`EMAIL_FROM` 例如 `股票提醒 <alert@你的網域>` | 選用 |

Discord 不需要任何設定，用戶自己貼 Webhook 網址即可。

存檔後打開 `你的網址/setup`，確認每一項都打勾。Telegram 機器人會自動設定好，不用另外操作。

> VAPID 金鑰設定後不要更換，否則已開啟推播的用戶需要重新開啟。

---

## 用戶怎麼用

1. 打開網址 → 「開始使用」→ 記下**帳號代碼**（換手機或從主畫面打開時用來登入）。
2. **iPhone**：先在 Safari 點「分享」→「加入主畫面」，從主畫面打開才收得到推播（需要 iOS 16.4 以上）。
3. 「通知設定」開啟網頁推播／連接 Telegram 或 Discord，按「發送測試通知」確認收得到。
4. 回到「自選股」按「＋」加入股票 → 「設定提醒條件」。

---

## 免費方案的容量

Cloudflare 免費方案每次排程最多 50 個對外請求，加上股價 API 的免費額度，這版設定是：

- 同時被設定提醒的股票：建議 **30 支以內**（每分鐘最多查 20 支，超過會輪流查，每支間隔會拉長）
- 技術指標日線：Twelve Data 每天 800 次，盤中每 15 分鐘以上更新一次，股票越多間隔越長
- 「今日成交量」用的是到目前為止的累積量，早盤時倍數自然偏低

用戶變多時，建議升級 Cloudflare Workers Paid（每月 5 美元）和付費股價方案，再把 `src/scheduler.js` 最上面的 `QUOTES_PER_TICK`、`BARS_PER_TICK` 調高。

**每年要更新一次**：`src/market.js` 裡的美股休市日（目前寫到 2027 年）。

---

## 給開發者

```bash
npm install
npm test                 # 指標與條件判斷的單元測試
cp .dev.vars.example .dev.vars
npm run dev              # http://localhost:8787 ，用模擬股價、強制開盤
curl localhost:8787/api/__tick   # 手動跑一次排程（只在 DEV_TOOLS=1 時有效）
```

主要檔案：

| 檔案 | 內容 |
|---|---|
| `src/index.js` | 入口：網頁、API、每分鐘排程 |
| `src/api.js` | 所有 `/api/*` 路由 |
| `src/scheduler.js` | 排程：查價、算指標、判斷條件、送通知、勿擾時段 |
| `src/engine.js` | 條件種類、中文標籤、判斷邏輯 |
| `src/indicators.js` | MA、RSI、KD(9,3,3)、成交量倍數 |
| `src/providers.js` | Finnhub、Twelve Data、示範資料 |
| `src/notify.js` | 網頁推播、Telegram、Discord、Email |
| `src/market.js` | 美股開收盤時間與休市日 |
| `public/` | 手機網頁（`app.js`）、推播 service worker（`sw.js`）、管理員檢查頁（`setup.html`） |

---

本工具只依使用者設定的條件發送通知，不構成任何投資建議。
