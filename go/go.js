// ============================================================
//  ナハトX勤怠 ― QRの中継ページ（スマホ用）
//  iPad の表示ページのQRは、このページのURL（?w=<時刻窓>&s=<署名>）を指す。スマホの標準カメラはQRの中身を Safari などで開くので、
//  ここで、開いた環境を見て、Chrome で GAS の受付（?p=scan）を開かせる。受付そのもの（署名と時刻の検証・本人確認・記録）は GAS 側が行う。
//  ・行き先は、必ず GAS_EXEC + '?p=scan&w=' + w + '&s=' + s だけ（ほかのURLには移動しない＝オープンリダイレクトにしない）。
//    w と s は形式を確かめ、合わなければ移動せず、QRの読み取り直しを案内する
//  ・w と s は画面にもログにも出さない。画面の文字は textContent で入れる
//  ・どの環境でも行き止まりにしない（Chrome が入っていない・取り消した・応答がないときは、そのままの環境で受付を開く）
// ============================================================
'use strict';

// 受付ページ（GASのウェブアプリ）。公開URLで秘密ではない。iPad の表示ページ（app.js）は、このURLを持たない
var GAS_EXEC = 'https://script.google.com/a/macros/nahato.co.jp/s/AKfycby9JORQVA2E4_-ME2N73agDVhMAi1poWEg9Ju62Kl6o-KtVIZ_4jzkRzcMbr5pVjeFS_g/exec';

// iOS の Safari は googlechromes:// へ移ると「“Chrome”で開きますか？」と確認する。確認の間も visibilityState は 'visible' のままなので、
// 短いと、利用者が「開く」を押す前に Safari のまま受付を開いてしまう（確認も消えうる）。10秒あれば押す時間は足りる
var FALLBACK_MS = 10000;                  // iOS: Chrome を開こうとしてから、画面が見えたままならそのまま開くまでの時間
var W_RE = /^\d{1,12}$/;                  // 時刻窓
var S_RE = /^[A-Za-z0-9_-]{22}$/;         // 署名（base64url の先頭22文字）

function $(id) { return document.getElementById(id); }

// クエリ文字列から値を取り出す（復号はしない。形式に合わない文字があれば、あとの検証で弾く）
function param(name) {
  var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
  return m ? m[1] : null;
}

// 開いた環境。iPadOS の Safari は PC と同じ名乗りをするが、QRを読むのはスマホなので、PC と同じ扱いでよい
function platformOf(ua) {
  if (/CriOS/.test(ua)) return 'ios-chrome';              // iOS の Chrome
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';          // iOS の Safari など
  if (/Android/.test(ua)) return 'android';
  return 'other';                                         // PC など
}

var w = param('w'), s = param('s');
var valid = w !== null && s !== null && W_RE.test(w) && S_RE.test(s);
var dest = valid ? GAS_EXEC + '?p=scan&w=' + w + '&s=' + s : null;   // 移動先は、ここで作るこの1つだけ
var platform = platformOf((navigator && navigator.userAgent) || '');
var bare = dest ? dest.replace(/^https:\/\//, '') : null;

var fallbackTimer = null;
function cancelFallback() {
  if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
}

// Chrome で開く（同じ処理を、自動と「Chromeで開く」ボタンの両方で使う）
function openInChrome() {
  cancelFallback();
  try {
    if (platform === 'android') {
      // Chrome が無いときは、browser_fallback_url（受付ページ）を既定のブラウザで開く
      location.href = 'intent://' + bare + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(dest) + ';end';
    } else if (platform === 'ios') {
      // Chrome が入っていない・「キャンセル」を押したときは、何も起きずに画面が残る。そのときだけ、このまま開く。
      // Chrome に切り替わると、この画面は hidden になる（または pagehide が来る）ので取り消す＝あとから Safari 側でも開いて二重に記録されるのを防ぐ
      fallbackTimer = setTimeout(function () {
        fallbackTimer = null;
        if (document.visibilityState === 'visible') location.replace(dest);
      }, FALLBACK_MS);
      location.href = 'googlechromes://' + bare;
    } else {
      location.replace(dest);   // iOS の Chrome（CriOS）・PC など: すでにそのまま開けばよい
    }
  } catch (e) {
    cancelFallback();
    location.replace(dest);     // 想定外の失敗でも、行き止まりにしない
  }
}

function openHere() {
  cancelFallback();
  location.replace(dest);
}

if (!valid) {
  $('status').textContent = 'QRを読み取り直してください';
  $('actions').hidden = true;
} else {
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') cancelFallback(); });
  window.addEventListener('pagehide', cancelFallback);
  $('btnChrome').addEventListener('click', openInChrome);
  $('btnHere').addEventListener('click', openHere);
  openInChrome();
}
