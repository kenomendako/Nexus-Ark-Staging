import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { liteContinuityState, readableApiError } from "../../../mobile_app/static/lite-continuity-state.js";

const index = await readFile(new URL("../../../mobile_app/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../../mobile_app/static/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../../../mobile_app/static/styles.css", import.meta.url), "utf8");

test("通常画面でもモード・お出かけ前データ・帰宅導線を表示する", () => {
  assert.match(index, /id="lite-mode-label"/);
  assert.match(index, /id="snapshot-freshness"/);
  assert.match(index, /id="return-home-button"/);
  assert.doesNotMatch(styles, /body:not\(\[data-active-page="settings"\]\) \.lite-mode-bar \{\s*display: none;/);
  assert.match(styles, /body:not\(\[data-active-page="settings"\]\) #home-mode-button/);
  assert.match(styles, /body:not\(\[data-active-page="settings"\]\) #travel-mode-button/);
});

test("お出かけ前データは保存時刻を平易に示し設定欄へ移動できる", () => {
  assert.match(index, /id="standby-shortcut-button"/);
  assert.match(index, /id="standby-status" tabindex="-1"/);
  assert.doesNotMatch(index, /退避/);
  assert.match(app, /お出かけ前データ 保存済み・/);
  assert.match(app, /function openStandbySettings\(\)[\s\S]*setActivePage\("settings"\)[\s\S]*standbyStatus\.scrollIntoView[\s\S]*standbyStatus\.focus/);
  assert.match(app, /standbyShortcutButton\.addEventListener\("click", openStandbySettings\)/);
});

test("保存時刻は6時間で更新おすすめになり可視セッションで定期更新する", () => {
  assert.match(app, /STANDBY_FRESHNESS_WARNING_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(app, /STANDBY_AUTO_CHECK_INTERVAL_MS = 60 \* 60 \* 1000/);
  assert.match(app, /ageMs >= STANDBY_FRESHNESS_WARNING_MS \? "・更新おすすめ"/);
  assert.match(app, /storedStandbyAutoRefresh === null \|\| storedStandbyAutoRefresh === "true"/);
  assert.match(app, /document\.hidden[\s\S]+state\.sending[\s\S]+state\.syncing[\s\S]+state\.standbyAutoRefreshing/);
  assert.match(app, /window\.setInterval\(\(\) => \{[\s\S]+maybeAutoRefreshStandby\(\)[\s\S]+STANDBY_AUTO_CHECK_INTERVAL_MS/);
});

test("active・returning中は保存を止め本体ボタンを署名付き帰宅へ統合する", () => {
  assert.deepEqual(liteContinuityState("active", "travel"), {
    status: "active",
    blocksStandby: true,
    homeLabel: "署名付き帰宅",
    homeDisabled: false,
    travelDisabled: true,
    freshnessText: "お出かけ前データ 使用中・帰宅後に更新",
    readinessText: "独立モード使用中",
    standbyStatusText: "お出かけ前のデータ: 独立モードで使用中です。署名付き帰宅後に更新できます。",
    standbyCode: "in_use",
    standbyLabel: "使用中",
    standbyNext: "署名付き帰宅後に新しいデータを保存できます。",
  });
  assert.deepEqual(liteContinuityState("returning", "travel"), {
    status: "returning",
    blocksStandby: true,
    homeLabel: "帰宅を再開",
    homeDisabled: false,
    travelDisabled: true,
    freshnessText: "お出かけ前データ 帰宅処理中・完了後に更新",
    readinessText: "署名付き帰宅の途中",
    standbyStatusText: "お出かけ前のデータ: 帰宅処理中です。帰宅完了後に更新できます。",
    standbyCode: "returning",
    standbyLabel: "帰宅処理中",
    standbyNext: "「帰宅を再開」で処理を完了してください。",
  });
  assert.equal(liteContinuityState("", "home").blocksStandby, false);
  assert.equal(liteContinuityState("", "home").homeDisabled, true);
  assert.match(app, /standbyRefreshButton\.disabled = view\.blocksStandby \|\| state\.returningHome/);
  assert.match(app, /function handleHomeModeAction\(\)[\s\S]*returnTravelToHome\(\)[\s\S]*enterHomeMode\(\)/);
  assert.match(app, /action === "home_return"[\s\S]*homeModeButton\.click\(\)/);
});

test("sessionなし・準備済み0件では旧保存表示を消し帰宅後に再保存する", () => {
  assert.match(app, /function forgetLatestStandby\(\)[\s\S]*removeItem\("nexusLite\.latestStandbySnapshot"\)/);
  assert.match(app, /else \{\s*forgetLatestStandby\(\);\s*els\.standbyStatus\.textContent = "お出かけ前のデータ: 未準備"/);
  assert.match(app, /署名付き帰宅を完了[\s\S]*maybeAutoRefreshStandby\(\{ forceCheck: true, forceSave: true \}\)/);
  assert.match(app, /prepareStandbyFromLite\(\{ automatic: !forceSave, silent: forceSave \}\)/);
  assert.match(app, /帰宅は完了しました。お出かけ前データは未保存です/);
});

test("本体APIのJSON detailだけを読みやすいエラーとして表示する", () => {
  assert.equal(
    readableApiError(409, "Conflict", "application/json; charset=utf-8", '{"detail":"署名付き帰宅を再開してください。"}'),
    "署名付き帰宅を再開してください。",
  );
  assert.equal(
    readableApiError(409, "Conflict", "application/json", '{"error":"raw"}'),
    '409 {"error":"raw"}',
  );
  assert.equal(readableApiError(503, "Unavailable", "text/plain", "停止中"), "503 停止中");
});

test("PWAインストール案内と通常ブラウザの誤ペアリング防止を備える", () => {
  assert.match(index, /id="install-app-button"/);
  assert.match(index, /id="browser-pairing-confirmation-checkbox"/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /ホーム画面に追加/);
  assert.match(app, /!isInstalledDisplayMode\(\) && !els\.browserPairingConfirmationCheckbox\.checked/);
  assert.match(app, /window\.addEventListener\("appinstalled"/);
  assert.match(styles, /\.install-card \{[\s\S]*?grid-column: 1 \/ -1;/);
});
