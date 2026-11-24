// 受検票作成システム（kenshin.html）の動作確認スクリプト
//
//   node tests/check.mjs
//
// Playwright（Chromium）で kenshin.html を開き、サンプル名簿・予約状況を読み込んで
// 「誰に何が印刷されるか」と、間違い防止の仕組みが働くかを確かめます。
// 使うデータは sample/ と tests/fixtures/ の架空のデータだけです。実在の名簿は使わないでください。
// 最後に「失敗 0 件」と出れば合格です（失敗があると終了コード 1）。

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(path.join(ROOT, 'kenshin.html')).href;
const SAMPLE = path.join(ROOT, 'sample');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'kenshin-check-'));

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
let nativeDialogs = 0;
page.on('dialog', d => { if (d.type() !== 'beforeunload') nativeDialogs++; d.accept(); });
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
let p2, unloadWarn = 0;
const shown2 = (id) => p2.evaluate((id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; }, id);
// アプリの中の確認画面（ブラウザの confirm の代わり）で「OK」側を押します
const yes = async () => { await page.click('#askYes'); await wait(350); };
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
ok(await ev(() => state.rawHeader[state.mapping.empType]) === '身分', '雇用区分は名簿の「身分」の列（E列）を使う', await ev(() => state.rawHeader[state.mapping.empType]));
ok(await ev(() => state.fiscalYear) === 2026, '対象年度は PC の日付から 2026年度');
ok(await ev(() => isoOf(state.baseDate)) === '2027-03-31', '年齢の基準日は年度末（2027-03-31）');
await tab('p7');
await loadNyu('i', path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'));
await loadNyu('fujin', path.join(SAMPLE, '予約状況_婦人検診_サンプル.xlsx'));
const counts = await ev(() => ['i', 'nyu', 'shikyu'].map(k => activeTargets(k).length));
ok(counts.join() === '20,7,11', '印刷対象 胃がん20・乳がん7・子宮頸がん11', counts);
const blanks = await ev(() => surveyRows().filter(r => r.cat === 'blank').map(r => r.emp.empNo));
ok(blanks.length >= 1, '予約していない（入力欄が空欄の）人は未受診状況調査に載る', blanks);
const unl0 = await ev(() => surveyRows().filter(r => r.cat === 'unlisted').map(r => r.key));
ok(unl0.length === 0, '  がん検診では「ファイルに未掲載」の区分は出ない', unl0);
const unl = await ev(() => {
  const m = state.nyuSrc.i.map; const k = Object.keys(m).find(x => String(x) === '1101'); const keep = m[k];
  delete m[k]; rebuildNyuryoku(); computeTargets();
  const r = surveyRows().filter(x => x.cat === 'unlisted').map(x => x.key);
  m[k] = keep; rebuildNyuryoku(); computeTargets();
  return r;
});
ok(unl.length === 0, '  がん検診では、予約状況ファイルに載っていない人は未受診状況調査に載らない', unl);

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
ok(marks[0] === '✓ 24名' && marks[1] === '2/3' && /^要確認 \d+$|^✓$/.test(marks[2] || ''), '名簿・予約状況・対象者一覧に印が付く', marks);

section('ホーム（検診ごとの進み具合）');
await page.reload(); await wait(900);
ok(await ev(() => document.querySelector('section.page.active').id) === 'p0', 'アプリを開くとホームが出る');
const hr = await ev(() => mgmtKenshin().map(k => { const r = homeRow(k.id); return k.id + ':' + r.cells.nyu.st + ':' + (r.next || ''); }));
ok(hr.includes('i:done:pdf') || hr.some(x => /^i:done:/.test(x)), '検診ごとの行に、予約状況の取込済み・次の作業が出る', hr);
ok(await ev(() => homeRow('seikatsu').cells.pdf.st) === 'na', '  生活習慣病健診の受検票PDFは「―」（受検票なし）');
ok(/次にやること/.test(await page.textContent('.hnext')), '  いちばん上に「次にやること」が出る');
await page.click('td.hs[data-hgo="i"][data-hstep="pdf"]'); await wait(400);
ok(await ev(() => document.querySelector('section.page.active').id === 'p5' && document.getElementById('printKenshin').value === 'i'), '  マスを押すとその作業の画面へ移る（胃がんの受検票PDF→印刷・出力）');
await tab('p0');
await page.click('button[data-hjud="nyu"]'); await wait(300);
ok(await ev(() => !!state.judgeDone.nyu && homeRow('nyu').cells.jud.st === 'done'), '  「入力を終えた」で判定が済みになる');
await page.click('button[data-hjud="nyu"]'); await wait(300);

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

section('直前キャンセルと未受診状況調査');
await tab('p4');
const nI = await ev(() => activeTargets('i').length);
await page.check('#targetTable input.tcan[data-n="1203"]'); await wait(300);
ok(await ev(() => activeTargets('i').length) === nI - 1, 'キャンセルにすると印刷対象から外れる');
ok(await ev(() => targetStatus('i', state.targets.i.find(t => t.emp.empNo == '1203')).key) === 'cancel', '  状態は「キャンセル」');
await tab('p9');
const sv = await ev(() => surveyRows().map(r => r.emp.empNo + ':' + r.cat));
ok(sv.includes('1203:cancel') && sv.includes('1003:decline') && sv.includes('1502:decline'), '調査の対象：キャンセルした人と「受診しない」人', sv);
ok(!sv.some(x => /^(1101|1103|1201|1302):/.test(x)), '  派遣元・他の受診機関で受診する人は載らない', sv);
ok(/^未送付 \d+$/.test(await ev(() => document.querySelector('nav .tab[data-page="p9"] .tabmark').textContent)), 'タブに「未送付 N」が出る');
await page.check('#svTable input[data-svx="leave"][data-no="1003"]'); await wait(300);
ok(await ev(() => surveyRows().find(r => r.emp.empNo == '1003').st) === 'exempt', '「産休・育休」にチェックすると調査免除');
await page.check('#svTable input[data-svx="other"][data-no="1502"]'); await wait(300);
await page.fill('#svTable input[data-svx="text"][data-no="1502"]', '長期療養中');
await page.dispatchEvent('#svTable input[data-svx="text"][data-no="1502"]', 'change');
ok(await ev(() => svExemptLabel(surveyRows().find(r => r.emp.empNo == '1502').ex)) === 'その他：長期療養中', '「その他」にチェックして内容を記入すると調査免除');
const elKey = await ev(() => surveyRows().find(r => r.cat === 'decline' && !r.ex).key);
await page.check(`#svTable input[data-svx="elsewhere"][data-svk="${elKey}"]`); await wait(300);
const el = await ev((k) => { const r = surveyRows().find(x => x.key === k); return { st: r.st, lab: svExemptLabel(r.ex) }; }, elKey);
ok(el.st === 'exempt' && el.lab === '他受診機関で受診', '「他受診機関で受診」にチェックするとその行が調査免除', el);
await page.uncheck(`#svTable input[data-svx="elsewhere"][data-svk="${elKey}"]`); await wait(300);
ok(await ev((k) => surveyRows().find(x => x.key === k).st, elKey) === 'todo', '  チェックを外すと元に戻る');
const k1203 = 'i:1203';
await page.selectOption(`select[data-svst="${k1203}"]`, 'answered'); await wait(300);
await page.click('#btnSvSent'); await wait(300); await yes();
const cnt = await ev(() => surveyCount(surveyRows()));
ok(cnt.todo === 0 && cnt.answered === 1 && cnt.exempt === 2 && cnt.sent === cnt.all - 3, '「まとめて送付済み」は調査免除の人を除いて記録', cnt);
await page.reload(); await wait(900);
const kept = await ev(() => ({ c: !!state.cancelled.i['1203'], r: state.survey['i:1203'], x: state.svExempt['1502'] }));
ok(kept.c && kept.r.st === 'answered' && kept.x.text === '長期療養中', '開き直してもキャンセル・調査・免除の記録が残る', kept);
await tab('p9');
await page.click(`button[data-uncancel="${k1203}"]`); await wait(300); await yes();
ok(await ev(() => activeTargets('i').length) === nI, '６のタブからキャンセルを取り消すと印刷対象に戻る');

section('判定と要精密検査確認調査');
await tab('p4');
await ev(() => { tgKid = 'i'; renderTargets(); });
const jIds = await ev(() => activeTargets('i').slice(0, 3).map(t => t.emp.empNo));
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[0]}"]`, 'seimitsu'); await wait(300);
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[1]}"]`, 'kensa'); await wait(300);
const jopt = await ev((n) => { const sel = document.querySelector(`select.tjud[data-k="i"][data-n="${n}"]`); return { opts: [...sel.options].map(o => o.textContent).join(), cur: sel.options[sel.selectedIndex].textContent }; }, jIds[2]);
ok(jopt.opts === '異常なし,要経過観察,要検査,要精密検査,要内視鏡' && jopt.cur === '異常なし', '胃がん検診の判定は「異常なし（初期値）」「要経過観察」「要検査」「要精密検査」「要内視鏡」', jopt);
ok(await ev(() => judgeKeys('nyu').map(k => JUDGE[k]).join()) === '要経過観察,要検査,要精密検査', '  要内視鏡は胃がん検診だけ（乳がん検診などには出ない）');
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[2]}"]`, 'naishikyo'); await wait(300);
const nsk = await ev((n) => { const r = seimitsuRows().find(x => x.key === 'i:' + n); return r ? document.querySelector('#smTable') && JUDGE[state.judge.i[n]] : null; }, jIds[2]);
ok(nsk === '要内視鏡', '  要内視鏡の人は要精密検査と同じく「７. 要精密検査確認調査」に載る', nsk);
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[2]}"]`, 'kansatsu'); await wait(300);
ok(await ev((n) => state.judge.i[n] === 'kansatsu' && !seimitsuRows().some(r => r.key === 'i:' + n), jIds[2]), '  要経過観察を選べる（要精密検査確認調査には載らない）');
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[2]}"]`, ''); await wait(300);
ok(await ev((n) => !(n in state.judge.i), jIds[2]), '  異常なしに戻すと記録は消える（初期値のまま）');
await tab('p10');
const smr = await ev(() => seimitsuRows().map(r => r.key));
ok(smr.join() === 'i:' + jIds[0], '要精密検査の人だけが「７. 要精密検査確認調査」に載る（要検査の人は載らない）', smr);
ok(/^未送付 1$/.test(await ev(() => document.querySelector('nav .tab[data-page="p10"] .tabmark').textContent)), 'タブに「未送付 1」が出る');
await page.click('#btnSmSent'); await wait(300); await yes();
await page.selectOption(`select[data-smst="i:${jIds[0]}"]`, 'reported'); await wait(300);
const smc = await ev((n) => ({ c: seimitsuCount(seimitsuRows()), r: state.seimitsu['i:' + n] }), jIds[0]);
ok(smc.c.reported === 1 && smc.r.sentAt && smc.r.repAt, '送付済み→報告ありを日付つきで記録', smc);
await page.reload(); await wait(900);
ok(await ev((n) => state.judge.i[n] === 'seimitsu' && seimitsuCount(seimitsuRows()).reported === 1, jIds[0]), '開き直しても判定と報告の記録が残る');

section('受診日で絞り込む');
await tab('p4');
await ev(() => { tgKid = 'i'; document.getElementById('listOrder').value = 'date'; renderTargets(); });
const dkeys = await ev(() => [...document.querySelectorAll('#tgDateRow input[data-tgdate]')].map(i => i.dataset.tgdate));
ok(dkeys.includes('7日（水）') && dkeys.includes('8日（木）') && dkeys.includes('9日（金）'), '受診日ごとのチェックが出る', dkeys);
const nAll = await ev(() => document.querySelectorAll('#targetTable tbody tr').length);
await page.check('#tgDateRow input[data-tgdate="7日（水）"]'); await wait(300);
await page.check('#tgDateRow input[data-tgdate="8日（木）"]'); await wait(300);
const dr = await ev(() => ({ ord: document.getElementById('listOrder').value,
  rows: [...document.querySelectorAll('#targetTable tbody tr')].map(tr => [tr.cells[2].textContent, tr.cells[10].textContent]) }));
const nos = dr.rows.map(r => +r[0]);
ok(dr.rows.length > 0 && dr.rows.every(r => /^(7日|8日)/.test(r[1])) && dr.ord === 'empNo' && nos.every((v, i) => i === 0 || nos[i - 1] < v),
   'チェックした日（7日・8日）の人だけを職員番号順で表示', dr);
await page.click('#tgDateRow button[data-tgdateclear]'); await wait(300);
ok(await ev(() => document.querySelectorAll('#targetTable tbody tr').length) === nAll, '  「すべての日を表示」で元に戻る');

section('受診日の変更（1人ずつ・まとめて）');
await tab('p4');
// ブラウザで「このページで追加のダイアログを作成しない」にチェックした状態（confirm が黙ってキャンセルを返す）でも変更できること
await ev(() => { window.confirm = () => false; window.alert = () => { }; });
await ev(() => { tgKid = 'i'; document.getElementById('filterState').value = ''; renderTargets(); });
await page.click('#targetTable button[data-dateedit="1203"]'); await wait(300);
await page.fill('#ddDate', '2026-10-14'); await page.fill('#ddTime', '8:00〜8:15'); await page.click('#ddSave'); await wait(400);
const de = await ev(() => { const a = state.targets.i.find(t => t.emp.empNo == '1203').assign; return { lab: assignDateLabel(a), time: a.time, from: a.changed && a.changed.from }; });
ok(de.lab === '10月14日（水）' && de.time === '8:00〜8:15' && /^7日（水）/.test(de.from), '① 1人ずつ受診日・受付時間を変えられ、元の受診日を表示', de);
await page.click('#tgDateRow button[data-datemove]'); await wait(300);
await page.selectOption('#dmFrom', '8日（木）'); await page.fill('#dmTo', '2026-10-15'); await page.click('#dmSave'); await wait(300);
await page.click('#askNo'); await wait(300);
ok(await ev(() => !state.targets.i.some(t => t.assign && t.assign.moved) && getComputedStyle(document.getElementById('dateDlg')).display !== 'none'),
   '  確認画面で「やめる」を押すと変更しない（入力画面は開いたまま）');
await page.selectOption('#dmFrom', '8日（木）'); await page.fill('#dmTo', '2026-10-15'); await page.click('#dmSave'); await wait(300); await yes();
const dm = await ev(() => { const r = state.targets.i.filter(t => t.assign && t.assign.moved); return { n: r.length, labs: [...new Set(r.map(t => assignDateLabel(t.assign)))].join() }; });
ok(dm.n > 0 && dm.labs === '10月15日（木）', '② ある日（8日）をまとめて別の日（10/15）に移せる', dm);
await page.selectOption('#filterState', 'changed'); await wait(300);
const dch = await ev(() => document.querySelectorAll('#targetTable tbody tr').length);
ok(dch === dm.n + 1, '  状態「受診日を変更した人」で、変更した人だけを表示', dch);
await page.selectOption('#filterState', ''); await wait(200);
await page.reload(); await wait(1000);
ok(await ev(() => { const a = state.targets.i.find(t => t.emp.empNo == '1203').assign; return assignDateLabel(a) === '10月14日（水）' && state.targets.i.some(t => t.assign && t.assign.moved); }), '  開き直しても受診日の変更が残る');
await tab('p4');
await ev(() => { tgKid = 'i'; renderTargets(); });
await page.click('#targetTable button[data-dateundo="1203"]'); await wait(300); await yes();
await page.click('#tgDateRow button[data-datemove]'); await wait(300);
await page.click('#dateDlgBody [data-dmundo="8日（木）"]'); await wait(300);
await page.click('#dmCancel'); await wait(200);
ok(await ev(() => !state.targets.i.some(t => t.assign && (t.assign.changed || t.assign.moved))), '  元に戻すと予約状況の受診日に戻る');

section('フォームの回答・報告の取込');
const csvFile = (p) => ({ name: 'x.csv', mimeType: 'text/csv', buffer: readFileSync(p) });
await tab('p9');
await page.setInputFiles('#svAnsFile', csvFile(path.join(FIX, 'kaitou_mijushin.csv'))); await wait(800);
const svImp = await ev(() => document.querySelector('#svImport .row:nth-of-type(2)').textContent + ' ' + (document.querySelector('#svImport .miss') || {}).textContent);
ok(/2件が一覧の人と一致/.test(svImp) && /1件は一致しません/.test(svImp) && /9999/.test(svImp), '回答CSV：2件一致・1件不一致（職員番号が全角でも一致）', svImp.slice(0, 120));
await page.click('#svImport button[data-ansgo]'); await wait(500);
const svAns = await ev(() => ({ a: state.survey['i:1003'], b: state.survey['i:1502'] }));
ok(svAns.a.st === 'answered' && svAns.a.ansAt === '2026-11-02' && svAns.a.answers['受診しなかった理由（自由記入）'] === '仕事の都合で日程が合わなかった'
   && !('ID' in svAns.a.answers) && !('完了時刻' in svAns.a.answers), '  回答あり・回答日（完了時刻）・回答内容を記録（ID・時刻の列は入れない）', svAns.a);
ok(await ev(() => !!document.querySelector('#svTable details.ans')), '  一覧で「回答を見る」から回答内容を確認できる');
await tab('p10');
await page.setInputFiles('#smAnsFile', csvFile(path.join(FIX, 'houkoku_seimitsu.csv'))); await wait(800);
const smImp = await ev(() => document.querySelector('#smImport .row:nth-of-type(2)').textContent + ' ' + (document.querySelector('#smImport .miss') || {}).textContent);
ok(/1件が一覧の人と一致/.test(smImp) && /乳がん検診」の行がこの一覧にありません/.test(smImp), '報告CSV：検診の列で突き合わせる（要精密検査でない検診の報告は一致させない）', smImp.slice(0, 160));
await page.click('#smImport button[data-ansgo]'); await wait(500);
const smAns = await ev(() => state.seimitsu['i:1001']);
ok(smAns.st === 'reported' && smAns.repAt === '2026-11-20' && smAns.answers['結果'] === '異常なし', '  報告あり・報告日・報告内容を記録', smAns);

section('申請フォームの書き出し（Shift_JIS・見出し2行・姓と名が別の列）');
await tab('p9');
await page.setInputFiles('#svAnsFile', csvFile(path.join(FIX, 'kaitou_mijushin_shinsei.csv'))); await wait(800);
const sp = await ev(() => { const p = ansPending.sv; return { h: p.header, no: p.header[p.colNo], n1: p.header[p.colName], n2: p.header[p.colName2], t: p.header[p.colTime], k: p.header[p.colKen], rows: p.rows.length }; });
ok(sp.no === '職員番号' && sp.n1 === '姓' && sp.n2 === '名' && sp.t === '回答日時' && /対象の検診/.test(sp.k) && sp.rows === 4, '見出し2行を読み、職員番号・姓・名・回答日時・検診の列を推定', sp);
const spTxt = await ev(() => document.getElementById('svImport').textContent);
const spm = await ev(() => { const m = matchAnswers('sv'); return { hits: m.hits.length, miss: m.miss.map(x => x.who + '：' + x.why) }; });
ok(spm.hits === 2 && spm.miss.length === 2 && spm.miss.some(x => /9999/.test(x)) && spm.miss.some(x => /^1004/.test(x)), '  一致2件。名簿にない人と、未受診にしていない人の生活習慣病健診の回答は一致させない', spm);
await page.click('#svImport button[data-ansgo]'); await wait(500);
const sa = await ev(() => state.survey['i:1502']);
ok(sa.st === 'answered' && sa.ansAt === '2026-11-06' && sa.answers['受診状況を選択してください。'] === '未受診' && /\n来年度/.test(sa.answers['理由'])
   && !Object.keys(sa.answers).some(k => /回答番号|受付番号|申請|処理状況|質問文なし|^姓$|^名$/.test(k)), '  回答日・回答内容（改行を含む）を記録し、管理用の列・所属は入れない', sa);
await tab('p10');
await page.setInputFiles('#smAnsFile', csvFile(path.join(FIX, 'houkoku_seimitsu_shinsei.csv'))); await wait(800);
const smTxt = await ev(() => document.getElementById('smImport').textContent);
ok(/1件が一覧の人と一致/.test(smTxt) && /1件は一致しません/.test(smTxt), '報告：一致1件（要精密検査でない人の生活習慣病健診の報告は一致させない）', smTxt.replace(/\s+/g, ' ').slice(0, 200));
await page.click('#smImport button[data-ansgo]'); await wait(500);
const sb = await ev(() => state.seimitsu['i:1001']);
ok(sb.st === 'reported' && sb.repAt === '2026-11-20' && sb.answers['検査結果'] === '異常なし\n1年後に再検査', '  報告日・報告内容を記録', sb);

section('年度のまとめ（Excel・検診ごとのシート）');
await tab('p5');
await ev(() => { window.__blob = null; const o = window.downloadBlob; window.downloadBlob = function (b, n) { window.__blob = { b, n }; }; });
await page.click('#btnYearXlsx'); await wait(500);
const yx = await ev(async () => {
  const x = window.__blob; if (!x) return null;
  const sheets = await readXlsxFile(new File([x.b], 'a.xlsx'));
  const s0 = sheets[0], h = s0.rows[0];
  const row = (no) => { const r = s0.rows.find(r => String(r[2]) === no); return r ? Object.fromEntries(h.map((k, i) => [k, r[i]])) : null; };
  return { n: x.n, names: sheets.map(s => s.name), lens: sheets.map(s => s.rows.length - 1), r1003: row('1003'), r1001: row('1001'), r1101: row('1101') };
});
ok(yx && yx.names.join() === '胃がん検診,乳がん検診,子宮頸がん検診,生活習慣病健診', 'Excel に検診ごとの4シート（生活習慣病健診を含む）', yx && yx.names);
ok(yx && yx.n === '検診まとめ_2026年度.xlsx' && yx.lens[0] === 24, '  胃がん検診のシートに予約状況の24名', yx && [yx.n, yx.lens]);
ok(yx && yx.r1003['受診状況'] === '受診しない' && yx.r1003['回答日'] === '2026-11-05' && /受診済/.test(yx.r1003['回答内容']), '  受診しない人：未受診状況調査の回答まで1行で見える', yx && yx.r1003);
ok(yx && yx.r1001['判定'] === '要精密検査' && yx.r1001['要精密検査確認調査'] === '報告あり' && /異常なし/.test(yx.r1001['報告内容']), '  要精密検査の人：判定と報告内容まで1行で見える', yx && yx.r1001);
ok(yx && yx.r1101['受診状況'] === '派遣元・他の受診機関で受診' && !yx.r1101['未受診状況調査'], '  派遣元で受診する人は調査なしで載る', yx && yx.r1101);

section('未受診・要精密検査一覧（Excel・2シート）');
await tab('p9');
ok(/未受診・要精密検査一覧/.test(await ev(() => document.querySelector('#p9 .panel h2').textContent)), '６のタブの最上段に「未受診・要精密検査一覧（Excel）」');
// 未送付の人を作る（送付済みの人を未送付に戻し、もう1人をキャンセルにする）。確かめたら元に戻します
const lxUndo = await ev(() => {
  const r = surveyRows().find(r => r.st === 'sent'); const before = JSON.stringify(state.survey[r.key]);
  setSurveyState(r.key, 'todo');
  const t = state.targets.i.find(t => t.print && !isCancelled('i', t.emp.empNo) && !state.excluded.i.has(t.emp.empNo) && !state.judge.i[t.emp.empNo]);
  state.cancelled.i[t.emp.empNo] = '2026-10-06';
  return { key: r.key, before, no: t.emp.empNo };
});
await ev(() => { window.__blob = null; });
await page.click('#btnListXlsx'); await wait(500);
const lx = await ev(async () => {
  const x = window.__blob; if (!x) return null;
  const buf = await x.b.arrayBuffer();
  const sheets = await readXlsxFile(new File([buf], 'a.xlsx'));
  const z = zipOpen(buf);
  const xml = new TextDecoder().decode(await zipRead(z, z.entries.find(e => e.name === 'xl/worksheets/sheet1.xml')));
  const s1 = sheets[0], st = s1.rows[0].indexOf('状況');
  const states = s1.rows.slice(1).map(r => r[st]);
  // 行ごとに黄色（s="2"）かどうか
  const yel = s1.rows.slice(1).map((r, i) => new RegExp('<row r="' + (i + 2) + '">(<c [^>]*s="2"[^>]*>)').test(xml));
  return { n: x.n, names: sheets.map(s => s.name), states, yel, sm: sheets[1].rows.length - 1, smN: seimitsuRows().length, svN: surveyRows().length };
});
ok(lx && lx.n === '未受診・要精密検査一覧.xlsx' && lx.names.join() === '未受診一覧,要精密検査一覧', '  ファイル名「未受診・要精密検査一覧.xlsx」に「未受診一覧」「要精密検査一覧」の2シート', lx && [lx.n, lx.names]);
const firstOther = lx ? lx.states.findIndex(v => v !== '未送付') : -1;
ok(lx && lx.states.length === lx.svN && lx.states.includes('未送付') && firstOther > 0 && lx.states.slice(firstOther).every(v => v !== '未送付'),
   '  未受診一覧は全員が入り、「未送付」の人が上に来る', lx && lx.states);
ok(lx && lx.yel.every((y, i) => y === (lx.states[i] === '未送付')), '  「未送付」の行だけ黄色のマーカー', lx && lx.yel);
ok(lx && lx.sm === lx.smN && lx.sm > 0, '  要精密検査一覧に要精密検査確認調査の全員', lx && [lx.sm, lx.smN]);
// 検診ごと：胃がん検診だけ
await page.selectOption('#listKenshin', 'i'); await wait(200);
await ev(() => { window.__blob = null; });
await page.click('#btnListXlsx'); await wait(500);
const lxi = await ev(async () => {
  const x = window.__blob; const sheets = await readXlsxFile(new File([await x.b.arrayBuffer()], 'a.xlsx'));
  return { n: x.n, k1: [...new Set(sheets[0].rows.slice(1).map(r => r[1]))], k2: [...new Set(sheets[1].rows.slice(1).map(r => r[1]))],
           n1: sheets[0].rows.length - 1, e1: surveyRows().filter(r => r.src.id === 'i').length };
});
ok(lxi.n === '未受診・要精密検査一覧_胃がん検診.xlsx' && lxi.n1 === lxi.e1 && lxi.k1.every(k => /胃がん/.test(k)) && lxi.k2.every(k => k === '胃がん検診'),
   '  検診を選ぶと、その検診だけを出力（ファイル名に検診名）', lxi);
// 課ごと：ZIPの中に課ごとのExcel
await page.selectOption('#listKenshin', ''); await wait(200);
// フォルダを選べるブラウザ：選んだフォルダの中に「…_課ごと」フォルダを作って保存（同じ名前があれば _2）
const lxf = await ev(async () => {
  const mk = name => { const kids = {}; return { name, kind: 'directory', kids,
    getDirectoryHandle: async (n, o) => { if (!kids[n]) { if (!(o && o.create)) throw new DOMException('x', 'NotFoundError'); kids[n] = mk(n); } return kids[n]; },
    getFileHandle: async (n) => ({ createWritable: async () => ({ write: async d => { kids[n] = d.length; }, close: async () => {} }) }) }; };
  const root = mk('保存先'); window.__savedPicker = window.showDirectoryPicker;
  window.showDirectoryPicker = async () => root; window.__blob = null;
  document.getElementById('btnListDept').click(); await new Promise(r => setTimeout(r, 800));
  document.getElementById('btnListDept').click(); await new Promise(r => setTimeout(r, 800));
  const want = {}; surveyRows().concat(seimitsuRows()).forEach(r => { want[r.emp.deptName] = 1; });
  return { dirs: Object.keys(root.kids), files: Object.keys(root.kids['未受診・要精密検査一覧_課ごと'].kids).sort(),
           want: Object.keys(want).map(d => '未受診・要精密検査一覧_' + d + '.xlsx').sort(), blob: !!window.__blob,
           label: document.getElementById('btnListDept').textContent };
});
ok(lxf.dirs.join() === '未受診・要精密検査一覧_課ごと,未受診・要精密検査一覧_課ごと_2' && lxf.files.join() === lxf.want.join() && !lxf.blob
   && /フォルダ/.test(lxf.label),
   '  「課ごとに出力」：選んだフォルダに課ごとのExcelを直接保存（ZIPにしない・2回目は別フォルダ）', lxf);
// フォルダを選べないブラウザ：ZIPにまとめる
await ev(() => { window.showDirectoryPicker = undefined; window.__blob = null; });
await page.click('#btnListDept'); await wait(800);
const lxd = await ev(async () => {
  const x = window.__blob, buf = await x.b.arrayBuffer(), z = zipOpen(buf), out = [];
  for (const e of z.entries) {
    const bytes = await zipRead(z, e);
    const sheets = await readXlsxFile(new File([bytes], 'a.xlsx'));
    const di = sheets[0].rows[0].indexOf('所属名'), dj = sheets[1].rows[0].indexOf('所属名');
    out.push({ name: e.name, depts: [...new Set(sheets[0].rows.slice(1).map(r => r[di]).concat(sheets[1].rows.slice(1).map(r => r[dj])))],
               n: sheets[0].rows.length - 1 + sheets[1].rows.length - 1 });
  }
  const want = {}; surveyRows().concat(seimitsuRows()).forEach(r => { want[r.emp.deptName] = (want[r.emp.deptName] || 0) + 1; });
  return { n: x.n, files: out, want };
});
ok(lxd.n === '未受診・要精密検査一覧_課ごと.zip' && lxd.files.length === Object.keys(lxd.want).length
   && lxd.files.every(f => f.depts.length === 1 && f.name === '未受診・要精密検査一覧_' + f.depts[0] + '.xlsx' && f.n === lxd.want[f.depts[0]]),
   '  フォルダを選べないブラウザでは、課ごとのExcel（その課の人だけ）をZIPにまとめる', lxd);
await ev((u) => { state.survey[u.key] = JSON.parse(u.before); delete state.cancelled.i[u.no]; saveData(); }, lxUndo);

// 課ごとのまとめ方
const gq = await ev(() => ({
  a: deptGroupOf('福祉部広田診療所'), b: deptGroupOf('商工交流部商工観光課'), c: deptGroupOf('商工交流部交流推進課'),
  d: deptGroupOf('高田小学校'), e: deptGroupOf('市長'), f: deptGroupOf('総務部総務課'), g: deptGroupOf('建設部住宅政策室'),
  h: deptGroupOf('B&G海洋センター')
}));
ok(gq.a === '保健課' && gq.b === '商工観光課' && gq.c === '商工観光課' && gq.d === '学校教育課' && gq.e === '企画政策課'
   && gq.f === '総務部総務課' && gq.g === '建設部住宅政策室' && gq.h === '商工観光課',
   'まとめ方の初期値：施設や室はまとめ先の課へ（まとめ先の課そのもの・まとめない所属は名簿のまま）', gq);
await page.click('#grpBox summary'); await wait(200);
await page.fill('#deptGroup', '建設部建設課 → 総務部総務課'); await page.dispatchEvent('#deptGroup', 'change'); await wait(300);
await ev(() => { window.__blob = null; });
await page.click('#btnListDept'); await wait(800);
const lxg = await ev(async () => {
  const x = window.__blob, buf = await x.b.arrayBuffer(), z = zipOpen(buf), out = {};
  for (const e of z.entries) {
    const sheets = await readXlsxFile(new File([await zipRead(z, e)], 'a.xlsx'));
    const di = sheets[0].rows[0].indexOf('所属名'), dj = sheets[1].rows[0].indexOf('所属名');
    out[e.name] = [...new Set(sheets[0].rows.slice(1).map(r => r[di]).concat(sheets[1].rows.slice(1).map(r => r[dj])))].sort();
  }
  const sel = document.querySelector('#grpPrev select[data-grpdept="建設部建設課"]');
  return { out, prev: sel ? sel.value : null };
});
ok(lxg.out['未受診・要精密検査一覧_総務部総務課.xlsx'] && lxg.out['未受診・要精密検査一覧_総務部総務課.xlsx'].join() === '建設部建設課,総務部総務課'
   && !lxg.out['未受診・要精密検査一覧_建設部建設課.xlsx'] && lxg.prev === '総務部総務課',
   '  まとめ方を書き換えると、まとめ先のファイルに入る（所属名の列は名簿のまま）', lxg);
// 名簿の所属の一覧から選び直す
await page.selectOption('#grpPrev select[data-grpdept="市民部市民課"]', '総務部総務課'); await wait(300);
const gs = await ev(() => ({ g: deptGroupOf('市民部市民課'), rule: state.deptGroup.some(r => r.from === '市民部市民課' && r.to === '総務部総務課'),
  rows: document.querySelectorAll('#grpPrev tbody tr').length, depts: new Set(state.employees.map(e => e.deptName)).size,
  txt: document.getElementById('deptGroup').value }));
ok(gs.g === '総務部総務課' && gs.rule && gs.rows === gs.depts && /市民部市民課 → 総務部総務課/.test(gs.txt),
   '  名簿の所属が一覧で出て、所属ごとにファイルを選び直せる（上の欄にも加わる）', gs);
await page.click('#grpPrev button[data-grpundo="市民部市民課"]'); await wait(300);
ok(await ev(() => deptGroupOf('市民部市民課') === '市民部市民課' && !state.deptGroup.some(r => r.from === '市民部市民課')), '  「外す」でその所属だけの決まりを外す');
await page.click('#btnGrpReset'); await wait(200); await yes();
ok(await ev(() => state.deptGroup.length === defaultDeptGroup().length), '  「初期値に戻す」で初期値に戻る');
await page.setInputFiles('#grpFile', xlsx(path.join(FIX, 'matome_kaitou.xlsx'))); await wait(800);
const gi = await ev(() => ({ list: state.deptGroup.map(r => r.from + '>' + r.to), x: deptGroupOf('建設部建設課'), y: deptGroupOf('財政課') }));
ok(gi.list.includes('財政課>総務課') && gi.list.includes('広田診療所>保健課') && gi.list.includes('建設部建設課>建設部') && gi.list.includes('住宅政策室>建設部')
   && gi.list.includes('市長>企画政策課') && gi.x === '建設部' && gi.y === '総務課',
   '  回答様式（Excel）を読み込むと、まとめ先と「部ごと」の○が反映される（市長・副市長の決まりは残る）', gi);
await ev(() => { state.deptGroup = defaultDeptGroup(); saveSettings(); });

section('生活習慣病健診');
await ev(() => { const E = (n) => state.employees.find(e => e.empNo == n);
  E('1004').empType = '会計年度任用職員（パート・時間額）'; E('1503').empType = 'パート（日額）'; E('1101').empType = '会計年度任用職員（フルタイム・日額）'; computeTargets(); });
await tab('p4');
await page.click('#tgKenshinTabs button[data-tgk="seikatsu"]'); await wait(300);
const sk = await ev(() => ({ all: state.targets.seikatsu.length, act: activeTargets('seikatsu').length,
  ex: state.targets.seikatsu.filter(t => !t.print).map(t => t.emp.empNo).sort().join() }));
ok(sk.all === 24 && sk.act === 22 && sk.ex === '1004,1503', '名簿の全員が対象、身分に「パート」と「時間額／日額」を含む人は対象外（かっこ入りでも判定、フルタイム・日額は対象）', sk);
ok(await page.isVisible('#seikatsuOpt'), '  対象外にする雇用区分を画面で変えられる');
await page.check('#targetTable input.tcan[data-k="seikatsu"][data-n="1101"]'); await wait(300);
await page.selectOption('select.tjud[data-k="seikatsu"][data-n="1002"]', 'seimitsu'); await wait(300);
ok(await ev(() => targetStatus('seikatsu', state.targets.seikatsu.find(t => t.emp.empNo == '1101')).label.startsWith('未受診')), '「未受診」にチェックできる');
ok(await ev(() => surveyRows().some(r => r.key === 'seikatsu:1101' && r.cat === 'absent')), '  未受診の人は「６. 未受診状況調査」に載る');
ok(await ev(() => seimitsuRows().some(r => r.key === 'seikatsu:1002')), '  要精密検査の人は「７. 要精密検査確認調査」に載る');
await tab('p9');
await page.setInputFiles('#svAnsFile', csvFile(path.join(FIX, 'kaitou_mijushin_shinsei.csv'))); await wait(800);
ok(await ev(() => matchAnswers('sv').hits.some(h => h.rows.some(r => r.key === 'seikatsu:1004'))) === false, '  対象外（パート）の人の生活習慣病健診の回答は一致させない');
await page.click('#svImport button[data-anscancel]'); await wait(200);
await tab('p10');
await page.setInputFiles('#smAnsFile', csvFile(path.join(FIX, 'houkoku_seimitsu_shinsei.csv'))); await wait(800);
await page.click('#smImport button[data-ansgo]'); await wait(500);
ok(await ev(() => state.seimitsu['seikatsu:1002'] && state.seimitsu['seikatsu:1002'].answers['検査結果'] === '経過観察'), '  生活習慣病健診の報告CSVも取り込める');
ok(!(await page.isVisible('#smImport')), '  全部一致したときは、取り込んだあと列の指定の枠を閉じる');
await tab('p5');
await page.click('#btnYearXlsx'); await wait(500);
const ys = await ev(async () => { const sh = await readXlsxFile(new File([window.__blob.b], 'a.xlsx')); const s = sh[3], h = s.rows[0];
  const row = (no) => Object.fromEntries(h.map((k, i) => [k, s.rows.find(r => String(r[2]) === no)[i]]));
  return { n: s.rows.length - 1, a: row('1004')['受診状況'], b: row('1101')['受診状況'], c: row('1002')['報告内容'] }; });
ok(ys.n === 24 && ys.a === '対象外（会計年度任用職員（パート・時間額））' && /^未受診/.test(ys.b) && /検査結果：経過観察/.test(ys.c), '  年度のまとめの「生活習慣病健診」シートに受診状況・報告内容', ys);
await tab('p7');
await page.setInputFiles('#nyfile_seikatsu', xlsx(path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'))); await wait(1000);
if (await page.$('#ny_seikatsu button[data-nyimport="seikatsu"]')) { await page.click('#ny_seikatsu button[data-nyimport="seikatsu"]'); await wait(500); }
ok(await ev(() => /予約あり/.test(document.getElementById('ny_seikatsu').innerText) && !/受検票を印刷/.test(document.getElementById('ny_seikatsu').innerText)), '  生活習慣病健診の枠は「受検票を印刷」ではなく「予約あり」と表示');
const sres = await ev(() => ({ n: state.targets.seikatsu.length, act: activeTargets('seikatsu').length,
  sv: surveyRows().filter(r => r.src.id === 'seikatsu').map(r => r.emp.empNo + ':' + r.cat) }));
ok(sres.n === 24 && sres.sv.length >= 1 && sres.sv.every(x => /:(decline|blank|unlisted|absent)$/.test(x)), '生活習慣病健診の予約状況を取り込むと、受診しない・予約なしの人が未受診状況調査に載る', sres);
ok(!sres.sv.some(x => /^(1004|1503):/.test(x)), '  パート（時間額・日額）の人は未受診状況調査に載らない', sres.sv);
const sunl = await ev(() => {
  const m = state.nyuSrc.seikatsu.map; const k = Object.keys(m).find(x => String(x) === '1001'); const keep = m[k];
  delete m[k]; rebuildNyuryoku(); computeTargets();
  const r = surveyRows().filter(x => x.cat === 'unlisted').map(x => x.key);
  m[k] = keep; rebuildNyuryoku(); computeTargets();
  return r;
});
ok(sunl.join() === 'seikatsu:1001', '  生活習慣病健診は、予約状況ファイルに載っていない人も「ファイルに未掲載」として載る', sunl);
const pf = await ev(() => ['10月6日(男)　8:30', '11月12日（女）　9：00～9：15'].map(v => { const r = parseNyuryoku(v, 'seikatsu'); return [r.kind, isoOf(r.date), r.sexMark, r.timeText, r.warn || ''].join('|'); }));
ok(pf[0] === 'time|2026-10-06|男|8:30|' && pf[1] === 'time|2026-11-12|女|9：00～9：15|', '生活習慣病健診の「○月○日(性別)　時間」を読み取る（日付・性別・受付時間）', pf);

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
const close = () => ev(() => { const g = document.getElementById('lyGuard'); if (g) g.style.display = 'none'; document.getElementById('askDlg').style.display = 'none'; });
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
ok(await ev(() => ['i', 'nyu', 'shikyu'].every(k => state.pdfMade[k] && state.pdfMade[k].n === activeTargets(k).length) && homeRow('i').cells.pdf.st === 'done'), '  PDFを作ると、ホームの受検票PDFが「作成済み」になる');
ok(pages.every(p => p.w === 364 && p.h === 257), '用紙は B4 横（364×257mm）', pages);
await ev(() => { window.__dl = []; });
await page.click('#btnCalibPdf'); await wait(2500);
ok((await ev(() => window.__dl))[0]?.startsWith('印刷設定の確認用紙_B4横'), '手順6の「確認用の様式」を保存できる', await ev(() => window.__dl));

section('継続免除（来年度以降も調査を免除）');
await fresh(new Date(2026, 9, 23, 10, 0));
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await tab('p7');
await loadNyu('i', path.join(FIX, 'yoyaku_i_irregular.xlsx'));
await tab('p9');
await page.check('#svTable input[data-svx="other"][data-no="1502"]'); await wait(300);
await page.fill('#svTable input[data-svx="text"][data-no="1502"]', '長期療養中（架空）');
await page.dispatchEvent('#svTable input[data-svx="text"][data-no="1502"]', 'change');
await page.check('#svTable input[data-svx="carry"][data-no="1502"]'); await wait(300);
await page.check('#svTable input[data-svx="other"][data-no="1003"]'); await wait(300);
const c1 = await ev(() => ({ ...state.svCarry['1502'], other: !!state.svCarry['1003'] }));
ok(c1 && c1.since === 2026 && c1.text === '長期療養中（架空）' && !c1.other, '「来年度以降も免除（継続）」にチェックした人だけを継続免除に記録', c1);
await tab('p1'); await page.click('#btnClearData'); await wait(300); await yes(); await wait(200);
ok(await ev(() => !!state.svCarry['1502'] && state.employees.length === 0), '「保存データを消去」しても継続免除は残る');
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await page.clock.setFixedTime(new Date(2027, 3, 15, 10, 0));
await page.reload(); await wait(1000);
ok(/1名は引き継ぎます/.test(await page.textContent('#fyGuardBody')), '年度切替の確認画面で、引き継ぐ継続免除の人数と名前を知らせる');
await page.click('#fyNew'); await wait(800);
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await tab('p7');
await loadNyu('i', path.join(FIX, 'yoyaku_i_irregular.xlsx'));
await tab('p9');
const c2 = await ev(() => surveyRows().filter(r => ['1502', '1003'].includes(String(r.emp.empNo))).map(r => r.emp.empNo + ':' + r.st));
ok(c2.includes('1502:exempt') && c2.includes('1003:todo'), '翌年度、継続免除の人は最初から調査免除（今年度だけの免除は引き継がない）', c2);
ok(/1名が今年度まだ見直されていません/.test(await page.textContent('#carryHint')), '  継続免除の一覧で、今年度の見直しが済んでいない人を知らせる');
await page.click('#carryTable button[data-carryok="1502"]'); await wait(300);
ok(await ev(() => state.svCarry['1502'].checked === 2027), '  「今年度も継続」で見直し済みになる');
ok(await ev(() => yearSheets()[0].rows.find(r => String(r[2]) === '1502')[yearSheets()[0].rows[0].indexOf('継続免除')]) === '2026年度から継続', '  年度のまとめに「継続免除」の列');
await page.click('#carryTable button[data-carryoff="1502"]'); await wait(300); await yes();
ok(await ev(() => !state.svCarry['1502'] && surveyRows().find(r => r.emp.empNo == '1502').st === 'exempt'), '  「継続をやめる」と一覧から外れ、今年度の免除は残る');

section('バックアップ（別名で保存・復元・パスワード）');
await fresh(new Date(2026, 9, 7, 10, 0));
await loadRoster(path.join(SAMPLE, '職員名簿_サンプル.xlsx'));
await tab('p7');
await loadNyu('i', path.join(SAMPLE, '予約状況_胃がん検診_サンプル.xlsx'));
await ev(() => { (state.dateEdit.i = state.dateEdit.i || {})['1203'] = { date: '2026-10-14', time: '8:00〜8:15', at: '2026-10-07' }; (state.cancelled.i = state.cancelled.i || {})['1001'] = '2026-10-06'; state.layouts.i.offX = 1.5; saveSettings(); computeTargets(); saveData(); });
const bkDownload = async (pw) => {
  await page.click('#bkSave'); await wait(300);
  if (pw) { await page.fill('#bkPw', pw); await page.fill('#bkPw2', pw); }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bkDo')]);
  const text = readFileSync(await dl.path(), 'utf-8'); await wait(300);
  return { name: await ev(() => window.__dl[window.__dl.length - 1]), text };
};
const bk1 = await bkDownload('');
const bj = JSON.parse(bk1.text);
ok(/^健診_バックアップ_2026年度_\d{8}_\d{4}\.json$/.test(bk1.name) && bj['種類'] === '職員検診のバックアップ' && bj.data.data.employees.length === 24
   && bj.data.data.dateEdit.i['1203'] && bj.data.data.cancelled.i['1001'] && bj.data.settings.layouts.i.offX === 1.5,
   '「別名で保存（バックアップ）」で名簿・予約状況・変更の記録・設定を1つのファイルに保存', { name: bk1.name, kind: bj['種類'] });
await page.click('#bkSave'); await wait(300);
await page.fill('#bkPw', 'abc'); await page.fill('#bkPw2', 'abd'); await page.click('#bkDo'); await wait(300);
ok(/一致しません/.test(await page.textContent('#bkMsg')), '  パスワードと確認が違うと保存しない');
await page.click('#bkCancel'); await wait(200);
const bk2 = await bkDownload('kenshin-test');
const bj2 = JSON.parse(bk2.text);
const nm = await ev(() => state.employees[0].name);
ok(bj2['暗号化'] === 'あり' && bj2.encrypted && !bj2.data && !bk2.text.includes(nm), '  パスワードを付けると暗号化して保存（氏名などがそのまま見えない）');
writeFileSync(path.join(TMP, 'bk_plain.json'), bk1.text);
writeFileSync(path.join(TMP, 'bk_enc.json'), bk2.text);
await tab('p1'); await page.click('#btnClearData'); await wait(300); await yes(); await wait(200);
ok(await ev(() => state.employees.length) === 0, '  （保存データを消去）');
await page.setInputFiles('#bkLoad', { name: 'bk.json', mimeType: 'application/json', buffer: Buffer.from(bk1.text) }); await wait(1500);
ok(await ev(() => state.employees.length === 24 && !!state.nyuryoku.i && assignDateLabel(state.targets.i.find(t => t.emp.empNo == '1203').assign) === '10月14日（水）'
     && isCancelled('i', '1001') && state.layouts.i.offX === 1.5),
   '「バックアップから復元」で、名簿・予約状況・受診日の変更・キャンセル・様式レイアウトが元に戻る');
await ev(() => { state.cancelled.i = {}; saveData(); });
await page.setInputFiles('#bkLoad', { name: 'bk.json', mimeType: 'application/json', buffer: Buffer.from(bk2.text) }); await wait(400);
ok(/置き換えます/.test(await page.textContent('#askBody')), '  データがあるときは、置き換えてよいか確認する');
await yes();
ok(await shown('bkDlg') && /パスワード付き/.test(await page.textContent('#bkLoadInfo')), '  パスワード付きのファイルはパスワードを聞く');
await page.fill('#bkPwLoad', 'wrong'); await page.click('#bkDo'); await wait(1500);
ok(/パスワードが違う/.test(await page.textContent('#bkMsg')) && await ev(() => !isCancelled('i', '1001')), '  パスワードが違うと開かない（データはそのまま）');
await page.fill('#bkPwLoad', 'kenshin-test'); await page.click('#bkDo'); await wait(2500);
ok(await ev(() => state.employees.length === 24 && isCancelled('i', '1001')), '  正しいパスワードで復元できる');
await page.setInputFiles('#bkLoad', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') }); await wait(400);
ok(await ev(() => state.employees.length === 24) && /バックアップのファイルではありません/.test(await page.textContent('#toast')), '  違うファイルを選んでも、今のデータは消えない');

section('作業ファイル（「バックアップ」フォルダの 健診_作業.js）');
// アプリと「バックアップ」フォルダを一時フォルダに置いて試します（リポジトリには作業ファイルを作りません）
const WD = path.join(TMP, 'app'); mkdirSync(path.join(WD, 'バックアップ'), { recursive: true });
copyFileSync(path.join(ROOT, 'kenshin.html'), path.join(WD, 'kenshin.html'));
const WORK = path.join(WD, 'バックアップ', '健診_作業.js');
const wrap = (t) => '// 職員検診の作業ファイルです。\nwindow.KENSHIN_WORK = ' + t + ';\n';
writeFileSync(WORK, wrap(bk1.text));
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
p2 = await ctx2.newPage();
p2.on('pageerror', e => errs.push(e.message));
p2.on('dialog', d => { if (d.type() === 'beforeunload') unloadWarn++; else nativeDialogs++; d.accept(); });
const ev2 = (fn, arg) => p2.evaluate(fn, arg);
const W2 = (ms) => p2.waitForTimeout(ms);
await p2.goto(pathToFileURL(path.join(WD, 'kenshin.html')).href); await ev2(() => localStorage.clear()); await p2.reload(); await W2(1200);
ok(await ev2(() => state.employees.length === 24 && isCancelled('i', '1001')) && /作業ファイル：バックアップ\\健診_作業\.js/.test(await p2.textContent('#bkNote')),
   '開くだけで「バックアップ」フォルダの作業ファイルを読み込む', await p2.textContent('#bkNote'));
// 上書き保存（Ctrl+S）：Edge のファイル保存の画面の代わりに、書き込んだ内容を受け取る仮のファイルを渡します
await ev2(() => {
  window.__wfText = '';
  const h = { name: '健診_作業.js', queryPermission: async () => 'granted', createWritable: async () => ({ write: async (t) => { window.__wfText = t; }, close: async () => { } }) };
  window.showSaveFilePicker = async () => h;
});
await ev2(() => { state.cancelled.i['1002'] = '2026-10-07'; saveData(); });
ok(/上書き保存していない変更があります/.test(await p2.textContent('#bkNote')), '  変更すると「上書き保存していない変更があります」と出る');
await p2.keyboard.press('Control+s'); await W2(800);
const wt = await ev2(() => window.__wfText);
ok(/^\/\/ 職員検診の作業ファイル/.test(wt) && /window\.KENSHIN_WORK = /.test(wt) && JSON.parse(wt.slice(wt.indexOf('{'), wt.lastIndexOf('}') + 1)).data.data.cancelled.i['1002']
   && !/変更があります/.test(await p2.textContent('#bkNote')), '  Ctrl+S で作業ファイルに上書き保存（次に開いたとき自動で読める形）');
// このパソコンのほうが新しいとき（作業ファイルは古いまま）
await W2(1100);
await ev2(() => { state.cancelled.i['1003'] = '2026-10-07'; saveData(); });
await p2.reload(); await W2(1200);
ok(unloadWarn === 1, '  上書き保存していない変更があるまま閉じようとすると、確認が出る', unloadWarn);
ok(await shown2('wfBanner') && /このパソコンのデータ.*のほうが新しく/.test(await p2.textContent('#wfBanner')) && await ev2(() => isCancelled('i', '1003')),
   '  このパソコンのデータのほうが新しいときは、上書きせずにどちらで続けるか聞く');
await p2.click('#wfBFile'); await W2(1500);
ok(await ev2(() => !isCancelled('i', '1003') && isCancelled('i', '1001')), '  「作業ファイルを読み込む」で作業ファイルの内容になる');
// パスワード付きの作業ファイル
writeFileSync(WORK, wrap(bk2.text));
await ev2(() => localStorage.clear()); await p2.reload(); await W2(800);
ok(await shown2('bkDlg') && await ev2(() => state.employees.length === 0), '  パスワード付きの作業ファイルは、開く前にパスワードを聞く');
await p2.fill('#bkPwLoad', 'kenshin-test'); await p2.click('#bkDo'); await W2(2000);
ok(await ev2(() => state.employees.length === 24) && /パスワード付き/.test(await p2.textContent('#bkNote')), '  パスワードを入れると読み込んで始まる');
await ctx2.close();

section('全体');
ok(external.length === 0, '外部への通信なし', external.slice(0, 3));
ok(nativeDialogs === 0, 'ブラウザの確認ダイアログ（confirm）を使わない（アプリ内の確認画面だけ）', nativeDialogs);
ok(errs.length === 0, 'JavaScript のエラーなし', errs.slice(0, 3));

await browser.close();
console.log(`\n合格 ${pass} 件／失敗 ${fail} 件`);
process.exit(fail ? 1 : 0);
