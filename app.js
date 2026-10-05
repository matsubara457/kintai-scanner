'use strict';
// ============================================================
//  ナハトX勤怠 ― 常設QR表示ページ（iPad用）
//  このページは「30秒ごとに変わるQRを表示し続ける」だけ。カメラも、打刻の確定もしない。
//  通信は、疎通と時計のずれの確認（同じオリジンへの fetch）だけ。
//  各自がスマホでQRを読む → 中継ページ（go/）が Chrome で GAS の受付（?p=scan）を開かせる
//  → GAS が署名と時刻を検証し、会社のGoogleアカウントで本人を確認して記録する。
//  QRの中身は「中継ページのURL + 時刻窓 w + 署名 s」。署名の鍵（KIOSK_KEY）は端末の中だけにあり、画面にも console にも出さない。
// ============================================================

// GASのURL（受付ページ）は、このページには持たない。行き先は中継ページ go/go.js の GAS_EXEC だけにある

// 出勤／退勤の境目（HH:mm）。画面の案内文に出すだけの表示用で、実際の判定はGAS側が行う。
// GAS は境目ちょうどを退勤として扱う（境目より前＝出勤、境目以降＝退勤）。
// ※ gas/config.js の CONFIG.SCAN_CUTOFF と必ず同じ値にすること（ずれると案内と実際の判定が食い違う）
var SCAN_CUTOFF = '15:00';

var WINDOW_MS = 30000;                    // QRが切り替わる間隔（GAS側の署名仕様と同じ）
var KEY_RE = /^[A-Za-z0-9_-]{43}$/;       // KIOSK_KEY: base64url の43文字
var KEY_STORE = 'kintai-kiosk-key';
var LEGACY_STORES = ['kintai-scanner-key', 'kintai-scanner-cam'];   // 旧方式（カメラ読み取り用のアクセスキー・カメラ向き）の保存値。使わないので起動時に消す
var RELOAD_HOUR = 4;                      // 毎日この時刻にページを再読み込みして更新を取り込む
var RETRY_MS = 3600000;                   // 再読み込みを見送ったとき、次に試すまでの間隔（翌日まで待たず1時間後）
var PROBE_TIMEOUT_MS = 10000;             // 疎通確認を打ち切るまでの時間
var SKEW_WARN_MS = 20000;                 // 時計のずれがこれ以上なら警告バッジを出す
var SKEW_EVERY_MS = 3600000;              // 時計のずれを測る間隔（1時間）
var SKEW_FIRST_MS = 10000;                // 起動してから最初に測るまでの時間
var STALE_WINDOWS = 2;                    // 表示中のQRがこの窓数だけ古くなったら隠す
var SIGN_RETRY_MS = 5000;                 // 署名の計算が返ってこないとき、この時間がたったら作り直す
var IMPORT_RETRY_MS = 10000;              // 鍵の取り込みが返ってこないとき、この時間がたったら作り直す

function $(id) { return document.getElementById(id); }
function p2(n) { return (n < 10 ? '0' : '') + n; }

var bootAt = Date.now();

// 1つの処理の失敗で、時計や他の処理まで止めない。ログに出すのは処理名とエラー名だけ（鍵やQRの中身は出さない）
var warned = {};
function guard(label, fn) {
  try { fn(); } catch (e) {
    if (!warned[label]) { warned[label] = true; try { console.warn('kiosk: ' + label + ' failed (' + (e && e.name) + ')'); } catch (e2) {} }
  }
}

// ---- 鍵の受け取りと保存 ----
// セットアップ用URL: <このページ>#ks=<KIOSK_KEY>（管理者のPCのセットアップ画面に出るQRを、iPadのカメラで読んで開く）
//
// ・ホーム画面に追加したWebアプリは、Safari のタブとは別の保存領域を持ち、「操作のないサイトの保存データを7日で消す」
//   仕組み（ITP）の対象外になる（https://webkit.org/tracking-prevention/#home-screen-web-application-domain-exempt-from-itp）。
//   そこで、ホーム画面アプリとして動いているときは、鍵を localStorage に保存できたあと、アドレス欄・履歴に鍵を残さないよう
//   フラグメントを消す。アイコンの起動URLは「追加した時点のURL（鍵つき）」になる想定で、保存データが消えても起動のたびに
//   取り込み直せる。この想定（起動URLにフラグメントが残ること）は webkit.org の記述になく、実機での確認が要る。
// ・Safari のタブで開いているときは、フラグメントを消さない。ホーム画面に追加する瞬間のURLに鍵が要るため。
//   このときの localStorage は Safari 側の保存領域で、7日で消えうる。QRの下の案内で、ホーム画面アプリへ移るよう促す。
function isStandalone() {
  try { if (navigator.standalone === true) return true; } catch (e) {}
  try { return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { return false; }
}
var STANDALONE = isStandalone();

function loadKioskKey() {
  var m = /(?:^#|&)ks=([^&]*)/.exec(location.hash || '');
  if (m) {
    if (!KEY_RE.test(m[1])) return { key: null, bad: true };
    var saved = false;
    try { localStorage.setItem(KEY_STORE, m[1]); saved = (localStorage.getItem(KEY_STORE) === m[1]); } catch (e) {}
    // 保存できなかったときは消さない（消すと、再読み込みで鍵を失う）
    if (STANDALONE && saved) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
    return { key: m[1], bad: false };
  }
  var stored = null;
  try { stored = localStorage.getItem(KEY_STORE); } catch (e) {}
  return { key: (stored && KEY_RE.test(stored)) ? stored : null, bad: false };
}
function purgeLegacyStores() {
  try { for (var i = 0; i < LEGACY_STORES.length; i++) localStorage.removeItem(LEGACY_STORES[i]); } catch (e) {}
}
purgeLegacyStores();
var kiosk = loadKioskKey();
var KIOSK_KEY = kiosk.key;

// ---- 署名（GAS側 kioskSig と完全に一致させる。仕様を変えないこと） ----
//   w = floor(Date.now() / 30000)
//   s = HMAC-SHA256(鍵 = KIOSK_KEY 文字列そのもののUTF-8（base64として復号しない）, "kiosk:v1:" + w) を base64url にした先頭22文字
//   QR = ROUTER_URL + '?w=' + w + '&s=' + s      （ROUTER_URL は下。中継ページが GAS_EXEC + '?p=scan&w=' + w + '&s=' + s を開く）
function windowOf(ms) { return Math.floor(ms / WINDOW_MS); }

function b64url(buf) {
  var bytes = new Uint8Array(buf), bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// importKey は鍵が変わらない限り1回だけ。返ってこないまま IMPORT_RETRY_MS たったときだけ、作り直す
var hmacKey = { src: null, promise: null, at: 0, ok: false };
function getHmacKey(keyStr) {
  var h = hmacKey, now = Date.now();
  if (h.promise && h.src === keyStr && (h.ok || now - h.at < IMPORT_RETRY_MS)) return h.promise;
  var p = crypto.subtle.importKey('raw', new TextEncoder().encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var cur = hmacKey = { src: keyStr, promise: p, at: now, ok: false };
  p.then(function () { cur.ok = true; },
         function () { if (hmacKey === cur) hmacKey = { src: null, promise: null, at: 0, ok: false }; });   // 失敗は覚えない（次回やり直す）
  return p;
}

async function signWindow(w, keyStr) {
  var key = await getHmacKey(keyStr === undefined ? KIOSK_KEY : keyStr);
  var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('kiosk:v1:' + w));
  return b64url(sig).slice(0, 22);
}

// QRの中身は、GASの受付ページのURLそのものではなく、中継ページ（go/）のURLにする。
// スマホの標準カメラはQRの中身を Safari などで開くので、Chrome で開かせるための中継ページを経由する（GAS 側の受付は変えていない）。
// 中継ページのURLは、このページの origin と path だけから作る。#ks= のフラグメント（鍵）も、? 以降の検索文字列も、QRには入れない。
var ROUTER_URL = (function () {
  try { return new URL('go/', location.origin + location.pathname).href; } catch (e) { return null; }
})();

function scanUrl(w, s) { return ROUTER_URL + '?w=' + w + '&s=' + s; }

// ---- 画面の部品 ----
var shiftEl = $('shift'), card = $('qrCard'), frame = $('qrFrame'), canvas = $('qr'), barEl = $('bar');

// 案内・エラーはQRの代わりに同じ場所へ出す。文字はすべて textContent で入れる
function showMessage(icon, title, body, hint, isError) {
  $('msgIcon').textContent = icon;
  $('msgTitle').textContent = title;
  $('msgBody').textContent = body;        // 指示
  $('msgHint').textContent = hint || '';  // 補足（空なら表示しない）
  card.classList.add('is-msg');
  card.classList.toggle('is-err', !!isError);
}
function showQrMode() { card.classList.remove('is-msg', 'is-err'); }

// ---- QRを描く（白地に黒・周囲に4モジュールの余白） ----
// 1モジュールを整数の実ピクセルにそろえ、拡大縮小で境目がぼけないようにする
var lastQR = null, lastBox = 0, lastDpr = 0;                  // 最後に描いたときの台座の一辺・DPR（寸法の変化に気づくため）
function drawQR(qr) {
  var n = qr.getModuleCount(), total = n + 8;                 // 上下左右に4モジュールずつ足す
  var dpr = window.devicePixelRatio || 1;
  var box = frame.getBoundingClientRect().width;              // 白い台座の一辺（CSSピクセル）
  lastBox = box; lastDpr = dpr;
  if (!(box >= 64)) box = 320;                                // レイアウト未確定でも描けるように
  var mod = Math.max(1, Math.floor(box * dpr / total));       // 1モジュールの実ピクセル数
  var px = mod * total;
  canvas.width = px; canvas.height = px;                      // 描画ピクセル数（リサイズで状態が初期化される）
  canvas.style.width = (px / dpr) + 'px'; canvas.style.height = (px / dpr) + 'px';   // 表示サイズ（CSSピクセル）
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + 4) * mod, (r + 4) * mod, mod, mod);
    }
  }
}

// ---- QRの更新（二段構え） ----
// ①次の30秒境界の50ms後に発火する setTimeout  ②1秒ごとの時計更新の中で、窓が変わっていたら描き直す
// タイマーが遅れたり止まったりしても、②が1秒以内に追いつく。
//
// 署名の計算は非同期なので、計算中に窓が進んだり、古い要求が新しい要求より後に終わったりしうる。
// 要求ごとに世代番号を振り、描く直前に「今の窓がまだ w で、かつ自分が最新の要求である」ことを確かめ、違えば捨てる。
var qrReady = false, drawnW = null, renderTimer = null;
var qrGen = 0, inflightW = null, inflightAt = 0;

function scheduleRender() {
  clearTimeout(renderTimer);
  var now = Date.now();
  renderTimer = setTimeout(refreshQR, (windowOf(now) + 1) * WINDOW_MS + 50 - now);
}

async function refreshQR() {
  scheduleRender();                       // 先に次を予約する（以降で失敗しても、次の境界でやり直せる）
  var w = windowOf(Date.now());
  if (!qrReady || w === drawnW) return;
  if (w === inflightW && Date.now() - inflightAt < SIGN_RETRY_MS) return;   // 同じ窓を計算中（返ってこないまま長引いたら作り直す）
  var gen = ++qrGen;
  inflightW = w; inflightAt = Date.now();
  try {
    var s = await signWindow(w);
    var qr = qrcode(0, 'M');
    qr.addData(scanUrl(w, s));
    qr.make();
    if (gen !== qrGen || windowOf(Date.now()) !== w) return;   // 古い結果は捨てる（次の窓の要求は、タイマーか1秒ごとの更新が出す）
    showQrMode();                         // 台座を表示してから寸法を測る
    drawQR(qr);
    lastQR = qr; drawnW = w;
  } catch (e) {
    if (gen !== qrGen) return;            // 古い要求の失敗で、新しい表示を壊さない
    lastQR = null; drawnW = null;         // 古いQRを出し続けない。次の1秒の更新で再挑戦する
    showMessage('⚠️', 'QRを作れませんでした', '自動でやり直しています。', '直らないときは、ページを再読み込みするか、管理者に知らせてください。', true);
  } finally {
    if (gen === qrGen) inflightW = null;
  }
}

// 表示中のQRが STALE_WINDOWS 窓以上古い（署名の計算が返ってこない等）ときは、古いQRを出し続けず隠す。
// まだ一度も描けていない場合も、起動から SIGN_RETRY_MS たったら同じ扱いにする（真っ白な台座を出し続けない）
function hideStaleQR(ms) {
  if (!qrReady || card.classList.contains('is-msg')) return;
  var behind = (drawnW === null) ? (ms - bootAt >= SIGN_RETRY_MS ? STALE_WINDOWS : 0) : windowOf(ms) - drawnW;
  if (behind >= STALE_WINDOWS) showMessage('🔄', 'QRを更新しています', '', '', false);
}

// 画面の大きさ・向きが変わったら、同じQRを新しい寸法で描き直す。
// resize はレイアウト確定後に届くのでまず即座に描き、寸法が遅れて確定する端末のために少し後にもう一度描く。
// それでもイベントを取りこぼした場合は、1秒ごとの更新が「台座の寸法やDPRが最後に描いたときと違う」ことで気づく
var resizeTimer = null;
function redrawQR() { guard('resize', function () { if (lastQR) drawQR(lastQR); }); }
function onResize() {
  redrawQR();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawQR, 250);
}
function layoutChanged() {
  return !!lastQR && !card.classList.contains('is-msg') &&
    (frame.getBoundingClientRect().width !== lastBox || (window.devicePixelRatio || 1) !== lastDpr);
}

// ---- 時計＋時間帯パレット ----
var DOW = ['日','月','火','水','木','金','土'];
function todOf(h) { return h < 5 ? 'night' : h < 9 ? 'dawn' : h < 17 ? 'day' : h < 20 ? 'dusk' : 'night'; }
function greetOf(h) { return (h >= 5 && h < 11) ? 'おはようございます' : (h >= 11 && h < 17) ? 'こんにちは' : 'こんばんは'; }
function updateClock(ms) {
  var n = new Date(ms);
  $('hh').textContent = p2(n.getHours()); $('mm').textContent = p2(n.getMinutes()); $('ss').textContent = p2(n.getSeconds());
  $('date').textContent = n.getFullYear() + '年' + (n.getMonth() + 1) + '月' + n.getDate() + '日 ' + DOW[n.getDay()] + '曜日';
  $('greet').textContent = greetOf(n.getHours());
  document.documentElement.setAttribute('data-tod', todOf(n.getHours()));
}

// ---- 次の切り替わりまでの残り時間バー ----
// 次の更新（1秒後）の値へ線形に動かすので、バーはその時点の残り時間とぴったり重なる。窓が変わった瞬間だけ満タンへ跳ねる
var barW = null;
function updateBar(ms) {
  var w = windowOf(ms), remain = (w + 1) * WINDOW_MS - ms;
  if (w !== barW) {
    barW = w;
    barEl.style.transition = 'none';
    barEl.style.transform = 'scaleX(' + (remain / WINDOW_MS) + ')';
    void barEl.offsetWidth;               // 変更を確定させてから、動きを戻す
    barEl.style.transition = '';
  }
  barEl.style.transform = 'scaleX(' + (Math.max(0, remain - 1000) / WINDOW_MS) + ')';
}

// ---- オフライン表示（QRは端末内で計算するので、表示は止めない） ----
function updateOnline() { $('offline').classList.toggle('on', navigator.onLine === false); }

// ---- 画面を消さない（Screen Wake Lock） ----
var wakeLock = null, wakePending = false;
async function requestWakeLock() {
  if (wakeLock || wakePending || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  wakePending = true;
  try {
    var lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
  } catch (e) {
    // 取れなくても表示は続ける。取り直しは visibilitychange と毎分の処理で試す
  } finally { wakePending = false; }
}

// ---- 疎通の確認（同じオリジンへ。再読み込みの前と、時計のずれの測定に使う） ----
// navigator.onLine が true でも GitHub Pages に届かないことがあるので、実際に取りに行って確かめる。
// 返すのは { ok: 応答が 2xx か, skewMs: iPadの時計 − サーバーの時計（測れなければ null） }。
// 応答ヘッダー Date は同一オリジンなので読める。キャッシュ越しの応答（Age が付く）は古い時刻を返すので、測定に使わない
async function probe() {
  var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, PROBE_TIMEOUT_MS);
  try {
    var t0 = Date.now();
    var res = await fetch('./?probe=' + t0, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    var t1 = Date.now();
    var skewMs = null;
    if (res.ok) {
      var d = Date.parse(res.headers.get('Date') || ''), age = parseInt(res.headers.get('Age') || '0', 10) || 0;
      if (!isNaN(d) && age <= 5) skewMs = (t0 + t1) / 2 - d;   // 往復の中間の時刻と比べる
    }
    return { ok: !!res.ok, skewMs: skewMs };
  } catch (e) {
    return { ok: false, skewMs: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 毎日4:00の再読み込み（更新の取り込み用） ----
// 再読み込みが失敗すると、端末がエラーページのまま止まる。そこで、先に疎通を確かめ、取れたときだけ再読み込みする。
// 取れなかったとき（オフラインを含む）は見送り、1時間後にもう一度試す（翌日まで待たない）
function nextReloadAt(from) {
  var d = new Date(from);
  d.setHours(RELOAD_HOUR, 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
var reloadAt = nextReloadAt(Date.now()), reloadBusy = false;
var lastTickAt = Date.now(), quietUntil = 0;
async function tryReload() {
  if (navigator.onLine === false) return;
  var r = await probe();
  if (r.ok) location.reload();
}
function maybeReload(ms) {
  if (ms < reloadAt || ms < quietUntil || reloadBusy) return;
  reloadBusy = true;
  reloadAt = ms + RETRY_MS;               // 先に次の予定（1時間後）を置く。再読み込みが進めばページごと入れ替わり、見送ればこのまま
  tryReload().then(function () { reloadBusy = false; }, function () { reloadBusy = false; });
}

// ---- 時計のずれの警告（起動の10秒後と、その後1時間ごと。QRの表示は止めない） ----
var skewAt = bootAt + SKEW_FIRST_MS, skewBusy = false;
async function checkSkew() {
  var r = await probe();
  if (r.skewMs === null) return;          // 測れなかったときは、表示を変えない
  var bad = Math.abs(r.skewMs) >= SKEW_WARN_MS;
  $('skew').textContent = bad
    ? 'iPadの時計が約' + Math.round(Math.abs(r.skewMs) / 1000) + '秒ずれています。設定 → 一般 → 日付と時刻 →『自動設定』をオンにしてください'
    : '';
  $('skew').classList.toggle('on', bad);
}
function maybeCheckSkew(ms) {
  if (ms < skewAt || ms < quietUntil || skewBusy) return;
  skewAt = ms + SKEW_EVERY_MS;
  if (navigator.onLine === false) return;
  skewBusy = true;
  checkSkew().then(function () { skewBusy = false; }, function () { skewBusy = false; });
}

// ---- 焼き付き対策: 1分ごとに画面全体を ±6px の範囲でずらす ----
function shiftScreen() {
  var dx = Math.round(Math.random() * 12) - 6, dy = Math.round(Math.random() * 12) - 6;
  shiftEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
}
var lastMinute = Math.floor(Date.now() / 60000);

// ---- 1秒ごとの更新（秒の境目の少し後に合わせる） ----
function tick() {
  var ms = Date.now();
  // 眠り・凍結から戻った直後（前回から5秒以上空いた）は、回線が戻りきっていない恐れがあるので、通信を伴う処理を1分待つ
  if (ms - lastTickAt > 5000) quietUntil = ms + 60000;
  lastTickAt = ms;
  guard('clock', function () { updateClock(ms); });
  guard('bar', function () { updateBar(ms); });
  guard('online', updateOnline);
  guard('qr', function () { if (qrReady && windowOf(ms) !== drawnW) refreshQR(); });   // 二段構えの②
  guard('stale', function () { hideStaleQR(ms); });
  guard('layout', function () { if (layoutChanged()) redrawQR(); });
  var mi = Math.floor(ms / 60000);
  if (mi !== lastMinute) {
    lastMinute = mi;
    guard('shift', shiftScreen);
    guard('wake', requestWakeLock);
  }
  guard('skew', function () { maybeCheckSkew(ms); });
  guard('reload', function () { maybeReload(ms); });
}
function loop() {
  setTimeout(loop, 1000 - (Date.now() % 1000) + 100);   // 先に予約してから処理する（処理が失敗しても止まらない）
  tick();
}

// ---- 起動 ----
function boot() {
  $('noteCut').textContent = SCAN_CUTOFF + 'より前＝出勤／' + SCAN_CUTOFF + '以降＝退勤';
  $('homeNote').hidden = STANDALONE;       // Safari のタブで開いているときだけ、ホーム画面への追加を促す

  if (!(window.crypto && crypto.subtle && typeof crypto.subtle.importKey === 'function')) {
    return showMessage('⚠️', 'この端末ではQRを作れません',
      'ブラウザの暗号機能（crypto.subtle）が使えません。', 'https:// のページとして開いているか、iPadOSとSafariが新しいかを確認してください。', true);
  }
  if (typeof qrcode !== 'function') {
    return showMessage('⚠️', 'QRを作る部品を読み込めませんでした',
      'qrcode.js が見つかりません。ページを再読み込みしてください。', '直らないときは管理者に知らせてください。', true);
  }
  if (!ROUTER_URL) {
    return showMessage('⚠️', 'QRの行き先を決められません',
      'このページのURLから、中継ページ（go/）のURLを作れませんでした。', 'https:// のページとして開いているか確認し、直らないときは管理者に知らせてください。', true);
  }
  if (kiosk.bad) {
    return showMessage('⚠️', 'セットアップ用URLの鍵の形式が正しくありません',
      '管理者のPCで勤怠システムのセットアップ画面（?p=kiosksetup）を開き、表示されたQRをこのiPadのカメラでもう一度読み取ってください。', '', true);
  }
  if (!KIOSK_KEY) {
    return showMessage('🔑', 'この端末はまだセットアップされていません',
      '管理者の方は、PCで勤怠システムのセットアップ画面（?p=kiosksetup）を開き、表示されたQRをこのiPadのカメラで読み取ってください。',
      'そのURLのまま「ホーム画面に追加」しておくと、端末の保存データが消えても、アイコンから開くたびに設定が戻ります。', false);
  }
  qrReady = true;
  refreshQR();
}

guard('boot', boot);
loop();
guard('wake', requestWakeLock);

// 保存データに頼らない部分・復帰時の取りこぼしを拾う
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') { guard('wake', requestWakeLock); guard('tick', tick); }
});
window.addEventListener('pageshow', function () { guard('tick', tick); });
window.addEventListener('online', function () { guard('online', updateOnline); });
window.addEventListener('offline', function () { guard('online', updateOnline); });
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
// すでに開いているページへ、別のセットアップ用URL（フラグメントだけ違う）を貼られた場合は、読み込み直して鍵を取り込む
window.addEventListener('hashchange', function () { location.reload(); });
