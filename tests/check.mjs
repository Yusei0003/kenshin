// 受検票作成システム（kenshin.html）の動作確認スクリプト
//
//   node tests/check.mjs
//
// Playwright（Chromium）で kenshin.html を開き、サンプル名簿・予約状況を読み込んで
// 「誰に何が印刷されるか」と、間違い防止の仕組みが働くかを確かめます。
// 使うデータは sample/ と tests/fixtures/ の架空のデータだけです。実在の名簿は使わないでください。
// 最後に「失敗 0 件」と出れば合格です（失敗があると終了コード 1）。

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(path.join(ROOT, 'kenshin.html')).href;
const SAMPLE = path.join(ROOT, 'sample');
const FIX = path.join(ROOT, 'tests', 'fixtures');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch (e) {
  try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')); }
  catch (e2) { console.error('Playwright が見つかりません。npm i -D playwright を実行するか、PLAYWRIGHT_MODULE に index.mjs の場所を指定してください。'); process.exit(2); }
}

// 日本語のファイル名は setInputFiles に渡せないことがあるので、中身を渡します
const MT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xlsx = (p) => ({ name: 'x.xlsx', mimeType: MT, buffer: readFileSync(p) });

let fail = 0, pass = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail !== undefined ? '　→ ' + JSON.stringify(detail) : '')); }
};
const section = (t) => console.log('\n■ ' + t);

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [], external = [];
page.on('pageerror', e => errs.push(e.message));
page.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
page.on('dialog', d => d.accept());
// ダウンロードしたファイル名を記録します（ヘッドレスでは保存名が取れないため）
await page.addInitScript(() => {
  window.__dl = [];
  const o = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push(this.download); return o.call(this); };
});
const pdfs = [];
page.on('download', async d => { const p = await d.path(); pdfs.push(p); });

const wait = (ms) => page.waitForTimeout(ms);
const tab = async (id) => { await page.click(`nav button[data-page="${id}"]`); await wait(300); };
const ev = (fn, arg) => page.evaluate(fn, arg);
const shown = (id) => ev((id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; }, id);
const paste = (sel, data) => ev(([sel, data]) => {
  const el = document.querySelector(sel); const dt = new DataTransfer();
  for (const k in data) dt.setData(k, data[k]);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [sel, data]);
const result = (kid, empNo) => ev(([kid, n]) => {
  const t = (state.targets[kid] || []).find(x => String(x.emp.empNo) === n);
  if (!t) return { out: true };
  return { print: t.print, skip: t.skipReason || '', check: !!t.needCheck, why: t.checkWhy || '' };
}, [kid, empNo]);

async function fresh(date) {
  await page.clock.setFixedTime(date);
  await page.goto(APP); await wait(300);
  await ev(() => { try { localStorage.clear(); } catch (e) { } });
  await page.reload(); await wait(500);
}
async function loadRoster(p) {
  await page.setInputFiles('#fileInput', xlsx(p)); await wait(1300);
  if (await page.isVisible('#btnApplyMap') && !(await ev(() => /確認を省いて/.test(document.getElementById('mapMsg').textContent)))) {
    await page.click('#btnApplyMap'); await wait(700);
  }
}
async function loadNyu(sid, p) {
  await page.setInputFiles('#nyfile_' + sid, xlsx(p)); await wait(1000);
  const btn = `#ny_${sid} button[data-nyimport="${sid}"]`;
  if (await page.$(btn)) { await page.click(btn); await wait(500); }
}

/* ------------------------------------------------------------------ */
section('名簿と予約状況の読込（サンプル）');
await fresh(new Date(2026, 9, 7, 10, 0));
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
ok(await ev(() => state.employees.length) === 24, '名簿 24名を読み込む', await ev(() => state.employees.length));
ok(await ev(() => state.fiscalYear) === 2026, '対象年度は PC の日付から 2026年度');
ok(await ev(() => isoOf(state.baseDate)) === '2027-03-31', '年齢の基準日は年度末（2027-03-31）');
await tab('p7');
await loadNyu('i', path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'));
await loadNyu('fujin', path.join(SAMPLE, '予約状況_婦人検診_サンプル.xlsx'));
const counts = await ev(() => ['i', 'nyu', 'shikyu'].map(k => activeTargets(k).length));
ok(counts.join() === '20,7,11', '印刷対象 胃がん20・乳がん7・子宮頸がん11', counts);

section('年齢（年度末現在・法律どおりの数え方）');
const ages = await ev(() => {
  const A = (y, m, d) => ageAt(new Date(y, m - 1, d), state.baseDate);
  let diff = 0;
  ['i', 'nyu', 'shikyu'].forEach(k => activeTargets(k).forEach(t => { if (t.emp.age !== personCtx(t, k)['年齢']) diff++; }));
  return { a: [A(1992, 4, 1), A(1992, 4, 2), A(2000, 2, 29)], diff };
});
ok(ages.a.join() === '35,34,27', '1992/4/1生=35歳・4/2生=34歳・2000/2/29生=27歳', ages.a);
ok(ages.diff === 0, '画面の年齢と受検票の年齢が一致', ages.diff);

section('タブの進み具合');
const marks = await ev(() => Array.from(document.querySelectorAll('nav .tab .tabmark')).map(m => m.textContent));
ok(marks[0] === '✓ 24名' && marks[1] === '✓ 2/2' && /^要確認 \d+$|^✓$/.test(marks[2] || ''), '名簿・予約状況・対象者一覧に印が付く', marks);

section('前回と同じ列の並びなら確認を省く');
await tab('p1');
await page.setInputFiles('#fileInput', xlsx(path.join(SAMPLE, '職員名簿_サンプル.xlsx'))); await wait(1300);
ok(await ev(() => /確認を省いて/.test(document.getElementById('mapMsg').textContent)), '名簿：自動で読み込む');
await tab('p7');
await page.setInputFiles('#nyfile_i', xlsx(path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'))); await wait(1000);
ok(!(await page.$('#ny_i button[data-nyimport="i"]')), '予約状況：自動で取り込む');

section('Excel を使わない貼り付け');
const tsv = await ev(() => {
  const f = v => v instanceof Date ? v.getFullYear() + '/' + (v.getMonth() + 1) + '/' + v.getDate() : String(v == null ? '' : v);
  return [state.rawHeader].concat(state.rawRows.map(r => r.map(f))).map(r => r.join('\t')).join('\r\n');
});
await ev(() => { state.employees = []; });
await tab('p1');
await paste('#rosterPaste', { 'text/plain': tsv }); await wait(900);
ok(await ev(() => state.employees.length) === 24, '名簿をタブ区切りで貼り付け → 24名');
const html = '<table>' + tsv.split('\r\n').map(r => '<tr>' + r.split('\t').map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
await ev(() => { state.rosterSig = 'x'; state.employees = []; });
await paste('#rosterPaste', { 'text/html': html, 'text/plain': 'x' }); await wait(900);
ok(await page.isVisible('#mapPanel') && await ev(() => state.rawRows.length) === 24, '名簿を表（HTML）で貼り付け → 列の確認へ進む');
await page.click('#btnApplyMap'); await wait(700);
ok(await ev(() => state.employees.length) === 24, '  確定して 24名');

section('名簿の取込エラーは Excel の行番号で示す');
await fresh(new Date(2026, 9, 7, 10, 0));
await loadRoster(path.join(FIX, 'meibo_title_blank.xlsx'));
const le = await ev(() => state.loadErrors.map(e => e.line + '行目'));
ok(le.length === 1 && le[0] === '8行目', '生年月日「不明」の人は 8行目と表示', le);

section('予約状況の入力欄の読み取り');
await fresh(new Date(2026, 9, 7, 10, 0));
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await tab('p7');
await loadNyu('i', path.join(FIX, 'yoyaku_i_irregular.xlsx'));
await loadNyu('fujin', path.join(FIX, 'yoyaku_fujin_mismatch.xlsx'));
const cases = [
  ['1001', '要相談', r => r.print && r.check],
  ['1004', '未定', r => r.print && r.check],
  ['1002', 'キャンセル', r => r.print === false],
  ['1003', '受診しません', r => r.print === false],
  ['1101', '派遣元（盛岡市）で受診', r => r.print === false],
  ['1201', '他の受診機関で受診', r => r.print === false],
  ['1202', '7:00〜7:15 キャンセル待ち', r => r.print && r.check],
  ['1102', '日付セル（10月6日）', r => r.print && r.check && /受付時間/.test(r.why)],
  ['1104', '時刻セル（7:00）', r => r.print && !r.check],
];
for (const [n, label, fn] of cases) {
  const r = await result('i', n);
  ok(fn(r), `胃がん ${n}「${label}」→ ${r.print ? '印刷' + (r.check ? '（要確認）' : '') : '印刷しない'}`, r);
}
const r1001 = await result('nyu', '1001');
ok(r1001.print && /男性/.test(r1001.why), '男性に婦人検診の予約 → 要確認', r1001);
for (const n of ['1302', '1202', '1503']) {
  const r = await result('nyu', n);
  ok(r.print && /35歳以上/.test(r.why), `乳がん ${n}：「35歳以上」なのに35歳未満 → 要確認`, r);
}
await page.reload(); await wait(900);
const after = [await result('i', '1102'), await result('i', '1104')];
ok(after[0].check && !after[1].check, '開き直しても日付・時刻セルの読み取りが変わらない', after);

section('年度の取り違え防止');
await page.clock.setFixedTime(new Date(2027, 3, 10, 10, 0));
await page.reload(); await wait(1000);
ok(await shown('fyGuard'), '翌年度に開くと確認画面が出る');
await ev(() => { document.getElementById('fyGuard').style.display = 'none'; });
await page.setInputFiles('#fileInput', xlsx(path.join(SAMPLE, '職員名簿_サンプル.xlsx'))); await wait(600);
ok(await shown('fyGuard'), '前年度のデータを残したまま名簿を選ぶと止める');
await ev(() => { document.getElementById('fyGuard').style.display = 'none'; });

section('様式レイアウトの誤操作防止');
await fresh(new Date(2026, 9, 7, 10, 0));
await tab('p8'); await wait(600);
const close = () => ev(() => { const g = document.getElementById('lyGuard'); if (g) g.style.display = 'none'; });
for (const [name, sel] of [['用紙', '#lyPaper'], ['ずれ補正', '#lyOffX'], ['項目の追加', '#lyAddText'], ['初期値に戻す', '#btnResetLayout']]) {
  await close(); await page.click(sel, { force: true }); await wait(250);
  ok(await shown('lyGuard'), `「${name}」を触ると確認画面が出る`);
}
await close();
for (const [name, sel] of [['表示倍率', '#lyScale'], ['位置合わせPDF', '#btnTestPrint']]) {
  await close(); await page.click(sel, { force: true }); await wait(300);
  ok(!(await shown('lyGuard')), `「${name}」は確認なしで使える`);
}
await close();

section('受検票PDF（全検診をまとめて作成）');
await fresh(new Date(2026, 9, 7, 10, 0));
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await tab('p7');
await loadNyu('i', path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'));
await loadNyu('fujin', path.join(SAMPLE, '予約状況_婦人検診_サンプル.xlsx'));
await tab('p5');
await ev(() => { window.__dl = []; });
pdfs.length = 0;
await page.click('#btnPdfAll');
await page.waitForFunction(() => !pdfBusy && /保存しました/.test(document.getElementById('pdfProgress').textContent), null, { timeout: 180000 });
await wait(1500);
const names = await ev(() => window.__dl);
ok(names.length === 3 && names.every(n => /_受検票_2026年度【Acrobatで開き実際のサイズで印刷】\.pdf$/.test(n)), '検診ごとに3つのPDFを保存（ファイル名に注意書き）', names);
const pages = pdfs.map(p => {
  const s = readFileSync(p, 'latin1');
  const m = s.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  return { n: (s.match(/\/Type\s*\/Page\b/g) || []).length, w: m ? Math.round(+m[1] / 72 * 25.4) : 0, h: m ? Math.round(+m[2] / 72 * 25.4) : 0 };
});
ok(pages.map(p => p.n).join() === '20,7,11', 'ページ数 20・7・11（確認用ページは入らない）', pages);
ok(pages.every(p => p.w === 364 && p.h === 257), '用紙は B4 横（364×257mm）', pages);
await ev(() => { window.__dl = []; });
await page.click('#btnCalibPdf'); await wait(2500);
ok((await ev(() => window.__dl))[0]?.startsWith('印刷設定の確認用紙_B4横'), '手順6の「確認用の様式」を保存できる', await ev(() => window.__dl));

section('全体');
ok(external.length === 0, '外部への通信なし', external.slice(0, 3));
ok(errs.length === 0, 'JavaScript のエラーなし', errs.slice(0, 3));

await browser.close();
console.log(`\n合格 ${pass} 件／失敗 ${fail} 件`);
process.exit(fail ? 1 : 0);
