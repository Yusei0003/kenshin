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
const blanks = await ev(() => surveyRows().filter(r => r.cat === 'blank').map(r => r.emp.empNo));
ok(blanks.length >= 1, '予約していない（入力欄が空欄の）人は未受診状況調査に載る', blanks);
const unl0 = await ev(() => surveyRows().filter(r => r.cat === 'unlisted').map(r => r.key));
ok(unl0.length === 0, '  全員がファイルに載っていれば「ファイルに未掲載」は出ない（婦人検診では男性を数えない）', unl0);
const unl = await ev(() => {
  const m = state.nyuSrc.i.map; const k = Object.keys(m).find(x => String(x) === '1101'); const keep = m[k];
  delete m[k]; rebuildNyuryoku(); computeTargets();
  const r = surveyRows().filter(x => x.cat === 'unlisted').map(x => x.key);
  m[k] = keep; rebuildNyuryoku(); computeTargets();
  return r;
});
ok(unl.join() === 'i:1101', '  予約状況ファイルに載っていない人も「ファイルに未掲載」として載る', unl);

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
await page.click('#btnSvSent'); await wait(400);
const cnt = await ev(() => surveyCount(surveyRows()));
ok(cnt.todo === 0 && cnt.answered === 1 && cnt.exempt === 2 && cnt.sent === cnt.all - 3, '「まとめて送付済み」は調査免除の人を除いて記録', cnt);
await page.reload(); await wait(900);
const kept = await ev(() => ({ c: !!state.cancelled.i['1203'], r: state.survey['i:1203'], x: state.svExempt['1502'] }));
ok(kept.c && kept.r.st === 'answered' && kept.x.text === '長期療養中', '開き直してもキャンセル・調査・免除の記録が残る', kept);
await tab('p9');
await page.click(`button[data-uncancel="${k1203}"]`); await wait(400);
ok(await ev(() => activeTargets('i').length) === nI, '６のタブからキャンセルを取り消すと印刷対象に戻る');

section('判定と要精密検査確認調査');
await tab('p4');
await ev(() => { tgKid = 'i'; renderTargets(); });
const jIds = await ev(() => activeTargets('i').slice(0, 3).map(t => t.emp.empNo));
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[0]}"]`, 'seimitsu'); await wait(300);
await page.selectOption(`select.tjud[data-k="i"][data-n="${jIds[1]}"]`, 'kensa'); await wait(300);
ok(await ev(() => Object.keys(JUDGE).map(k => JUDGE[k]).join()) === '要検査,要精密検査', '判定のプルダウンは「要検査」「要精密検査」');
await tab('p10');
const smr = await ev(() => seimitsuRows().map(r => r.key));
ok(smr.join() === 'i:' + jIds[0], '要精密検査の人だけが「７. 要精密検査確認調査」に載る（要検査の人は載らない）', smr);
ok(/^未送付 1$/.test(await ev(() => document.querySelector('nav .tab[data-page="p10"] .tabmark').textContent)), 'タブに「未送付 1」が出る');
await page.click('#btnSmSent'); await wait(300);
await page.selectOption(`select[data-smst="i:${jIds[0]}"]`, 'reported'); await wait(300);
const smc = await ev((n) => ({ c: seimitsuCount(seimitsuRows()), r: state.seimitsu['i:' + n] }), jIds[0]);
ok(smc.c.reported === 1 && smc.r.sentAt && smc.r.repAt, '送付済み→報告ありを日付つきで記録', smc);
await page.reload(); await wait(900);
ok(await ev((n) => state.judge.i[n] === 'seimitsu' && seimitsuCount(seimitsuRows()).reported === 1, jIds[0]), '開き直しても判定と報告の記録が残る');

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

section('生活習慣病健診');
await ev(() => { state.employees.find(e => e.empNo == '1004').empType = 'パート時間額'; state.employees.find(e => e.empNo == '1503').empType = 'パート日額'; computeTargets(); });
await tab('p4');
await page.click('#tgKenshinTabs button[data-tgk="seikatsu"]'); await wait(300);
const sk = await ev(() => ({ all: state.targets.seikatsu.length, act: activeTargets('seikatsu').length,
  ex: state.targets.seikatsu.filter(t => !t.print).map(t => t.emp.empNo).sort().join() }));
ok(sk.all === 24 && sk.act === 22 && sk.ex === '1004,1503', '名簿の全員が対象、パート時間額・パート日額は対象外', sk);
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
await tab('p5');
await page.click('#btnYearXlsx'); await wait(500);
const ys = await ev(async () => { const sh = await readXlsxFile(new File([window.__blob.b], 'a.xlsx')); const s = sh[3], h = s.rows[0];
  const row = (no) => Object.fromEntries(h.map((k, i) => [k, s.rows.find(r => String(r[2]) === no)[i]]));
  return { n: s.rows.length - 1, a: row('1004')['受診状況'], b: row('1101')['受診状況'], c: row('1002')['報告内容'] }; });
ok(ys.n === 24 && ys.a === '対象外（パート時間額）' && /^未受診/.test(ys.b) && /検査結果：経過観察/.test(ys.c), '  年度のまとめの「生活習慣病健診」シートに受診状況・報告内容', ys);

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
