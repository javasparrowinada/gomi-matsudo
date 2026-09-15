#!/usr/bin/env node
/*
 * index.html の検証スクリプト（ブラウザ不要・node だけで動く）
 *
 *   node test.js
 *
 * index.html の <script> をそのまま node の vm で読み込み、
 * 画面の「調べる」ボタンと同じ経路（render(入力.trim())）で判定させて、
 * 画面に出る結果（確定1件／選択肢／不明）を横取りして照合する。
 * index.html 自体は一切書き換えない。
 *
 *  (A) 全品目の自己参照 … PAGES の全品目を、品目名から括弧書きを除いた文字列で検索し、
 *                         画面に出る候補に自分自身の行が含まれるか。期待 1048/1048
 *  (B) 区分の正誤       … cases.json の「入力語」で検索し、画面の先頭に出る結果の主区分
 *                         （分別区分の "/" より前）が「期待する主区分」と一致するか。
 *                         主区分が期待値で始まっていれば一致とみなす
 *                         （例：期待「※不燃ごみ」＝実際「※不燃ごみ・資源ごみの日に回収」）
 *                         "判定":"候補に含む" を付けた行は、先頭でなくても画面の候補のどれかが
 *                         期待する主区分なら一致（素材や大きさを利用者が選ぶ語のため）
 *  (C) 壊れた入力       … 空文字・全角スペース・1文字・意味不明な文字列が「不明」になり、
 *                         候補が大量に並ばないこと（10件以上で失敗）
 *  (D) 画面表示         … 全品目を実際の描画関数で出し、1ページで完結しているか
 *                         （出す曜日の帯・早見表が指定する貼り紙の文字・指定がない旨・
 *                           候補一覧にタップして切り替えるボタンが残っていないこと・
 *                           「AとB」が両方とも同じページに出ること）
 *
 * 1件でも失敗があれば終了コード 1。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = __dirname;
const EXPECTED_ITEMS = 1048;

/* ---------- index.html の読み込み ---------- */
const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("index.html に <script> が見つかりません"); process.exit(1); }

function stubEl() {
  return {
    textContent: "", innerHTML: "", value: "", onclick: null, onchange: null,
    addEventListener() {}, click() {}, querySelectorAll() { return []; }
  };
}
const els = {};
const context = {
  console,
  document: { getElementById: id => (els[id] = els[id] || stubEl()) },
  // API は使えない前提（GitHub Pages 上でも鍵なしで呼ぶため失敗する）→ offlineGuess 側を検証する
  fetch: () => Promise.reject(new Error("offline")),
  URL: { createObjectURL: () => "" },
  setTimeout, clearTimeout
};
vm.createContext(context);
vm.runInContext(
  m[1] + `
;globalThis.__app = { PAGES, DATA, SYNONYMS, PREFIX_DROP, ESCALATORS, SCHED,
  variants, norm, baseName, searchExact, searchPartial, synonymHits, localGuess, noteCases, PARTS, PART_WORDS };`,
  context, { filename: "index.html<script>" }
);
const app = context.__app;

/* ---------- 画面描画の横取り ---------- */
let captured = null;
let pending = null;
const orig = {
  guess: context.guess,
  sortMetalFirst: context.sortMetalFirst,
  renderVerdict: context.renderVerdict,
  renderChoices: context.renderChoices,
  renderGuessChoices: context.renderGuessChoices,
  renderUnknown: context.renderUnknown,
  renderMulti: context.renderMulti,
  renderParts: context.renderParts,
  renderCategory: context.renderCategory
};
function installSpies() {
context.renderVerdict = (r) => { captured = { type: "verdict", rows: [r] }; };
context.renderChoices = (word, hits) => {
  captured = { type: "choices", rows: orig.sortMetalFirst(hits, x => x.item) };
};
context.renderGuessChoices = (word, rows) => {
  captured = { type: "guess", rows: orig.sortMetalFirst(rows, x => x.r.item).map(x => x.r) };
};
context.renderUnknown = () => { captured = { type: "unknown", rows: [] }; };
context.renderMulti = () => { captured = { type: "multi", rows: [] }; };
context.renderParts = (word, parts) => { captured = { type: "parts", rows: parts.flatMap(p => p.rowsFound) }; };
context.renderCategory = (word, cats) => { captured = { type: "category", rows: cats.map(c => ({ item: c, cat: c, note: "" })) }; };
context.guess = (word) => { pending = orig.guess(word); return pending; };
}
function removeSpies() {
  for (const k of ["renderVerdict", "renderChoices", "renderGuessChoices", "renderUnknown", "renderMulti", "renderParts", "renderCategory", "guess"]) context[k] = orig[k];
}
installSpies();

async function run(input) {
  captured = null; pending = null;
  const outEl = els["out"];
  outEl.innerHTML = "";
  const ret = context.render(String(input).trim()); // 「調べる」ボタンと同じ
  if (ret && typeof ret.then === "function") await ret;
  if (pending) await pending;
  if (!captured && /2つ以上あります/.test(outEl.innerHTML)) {
    const n = (outEl.innerHTML.match(/class="opt"/g) || []).length;
    captured = { type: "multi", rows: new Array(n).fill(null) };
  }
  return captured || { type: "none", rows: [] };
}
const mainCat = r => r.cat.split("/")[0].trim();

/* ---------- 実行 ---------- */
(async () => {
  let failed = 0;

  /* (A) */
  const total = app.DATA.length;
  const failA = [];
  for (const r of app.DATA) {
    const q = r.item.replace(/[(（][^)）]*[)）]/g, "").trim();
    let res = await run(q);
    // 「帽子(…)、サンバイザー」のように品目名が2つの物を並べていて、画面が「1つずつ調べて」と
    // 分けて出す場合は仕様どおり。その品目だけは括弧から後ろを切った名前（アプリの baseName）で引き直す
    if (res.type === "multi") res = await run(app.baseName(r.item).trim());
    if (!res.rows.includes(r)) failA.push({ item: r.item, query: q, type: res.type, got: res.rows.slice(0, 3).map(x => x && x.item) });
  }
  const passA = total - failA.length;
  const okA = failA.length === 0 && total === EXPECTED_ITEMS;
  console.log(`(A) 全品目の自己参照: ${passA}/${total}` + (total !== EXPECTED_ITEMS ? `  ※品目数が ${EXPECTED_ITEMS} ではありません` : "") + (okA ? "  OK" : "  NG"));
  failA.slice(0, 30).forEach(f => console.log(`    NG 「${f.query}」→ ${f.type} ${JSON.stringify(f.got)}（期待：${f.item}）`));
  if (failA.length > 30) console.log(`    …ほか ${failA.length - 30} 件`);
  if (!okA) failed++;

  /* (B) */
  const cases = JSON.parse(fs.readFileSync(path.join(DIR, "cases.json"), "utf8"));
  const failB = [];
  for (const c of cases) {
    const input = c["入力語"], expected = c["期待する主区分"];
    const res = await run(input);
    const match = r => { const g = mainCat(r); return g === expected || g.startsWith(expected); };
    const anyRow = c["判定"] === "候補に含む";
    const first = anyRow ? (res.rows.find(match) || res.rows[0]) : res.rows[0];
    const got = first ? mainCat(first) : `（${res.type}）`;
    const ok = !!first && match(first);
    if (!ok) failB.push({ input, expected, got, item: first && first.item, type: res.type });
  }
  const okB = failB.length === 0;
  console.log(`(B) 区分の正誤: ${cases.length - failB.length}/${cases.length}` + (okB ? "  OK" : "  NG"));
  failB.forEach(f => console.log(`    NG 「${f.input}」→ ${f.got}${f.item ? `（早見表：${f.item}／${f.type}）` : ""}（期待：${f.expected}）`));
  if (!okB) failed++;

  /* (C) */
  const broken = ["", "　", "あ", "い", "あああああ", "asdfgh"];
  const failC = [];
  for (const input of broken) {
    const res = await run(input);
    const tooMany = res.rows.length >= 10;
    if (res.type !== "unknown" || tooMany) {
      failC.push({ input, type: res.type, n: res.rows.length, got: res.rows.slice(0, 5).map(x => x && x.item) });
    }
  }
  const okC = failC.length === 0;
  console.log(`(C) 壊れた入力: ${broken.length - failC.length}/${broken.length}` + (okC ? "  OK" : "  NG"));
  failC.forEach(f => console.log(`    NG ${JSON.stringify(f.input)} → ${f.type}（候補 ${f.n} 件）${JSON.stringify(f.got)}`));
  if (!okC) failed++;

  /* (D) */
  const failD = [];
  const outEl = els["out"];
  const escText = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const checkRow = (r, h, where) => {
    const main = mainCat(r);
    const s = app.SCHED[main] || app.SCHED[main.replace(/。$/, "")];
    const note = r.note || "";
    const told = [...note.matchAll(/「([^」]{1,20})」\s*と(明記|貼り紙)/g)].map(m => m[1]);
    if (/新聞紙等で(包み|くるみ)/.test(note) && !told.includes("危険")) told.push("危険");
    if (s && s.days && !/class="week"/.test(h)) failD.push(`${where}「${r.item}」出す曜日の帯がない`);
    // 150×30mm の貼り紙：集積所に出せる区分が1つでもあれば、区分・品目・回収曜日の枠がある
    const anyDays = r.cat.split("/").some(c => { const x = app.SCHED[c.trim()] || app.SCHED[c.trim().replace(/。$/, "")]; return x && x.days; });
    if (anyDays && !/class="label"/.test(h)) failD.push(`${where}「${r.item}」貼り紙の枠がない`);
    if (anyDays && !/曜日回収/.test(h)) failD.push(`${where}「${r.item}」貼り紙に回収曜日がない`);
    if (anyDays) for (const t of told) if (!new RegExp(`class="lc (lx|lk|ln)"[^>]*>${escText(t)}<`).test(h)) failD.push(`${where}「${r.item}」貼り紙の枠に市が指定する文字「${t}」がない`);
    if (/class="paper/.test(h)) failD.push(`${where}「${r.item}」貼り紙の説明枠が残っている（不要と指示あり）`);
    if (!told.length && /class="lc lx"/.test(h)) failD.push(`${where}「${r.item}」指定がないのに貼り紙の枠に白抜きの文字を出している`);
    // 条件で区分が分かれる品目：先頭の区分だけを大きく出して、別の区分の貼り紙を並べる食い違いを防ぐ
    const cats = r.cat.split("/").map(x => x.trim());
    const cs = app.noteCases(note);
    if (cats.length > 1 && cs.length) {
      if (!h.includes("条件で分かれます")) failD.push(`${where}「${r.item}」条件で分かれるのに1つの区分だけを出している`);
      for (const c of cats) {
        const n = c.replace(/^※/, "").replace(/。$/, "");
        if (app.SCHED[c] && !h.includes(escText(n))) failD.push(`${where}「${r.item}」区分「${n}」が場合分けに出ていない`);
      }
      if (cs.some(c => c.battery) && !(h.includes("電池が入っていない場合") && h.includes("電池が入っている場合"))) failD.push(`${where}「${r.item}」電池の有無で分けていない`);
      if (h.includes("電池がない場合の記載はありません")) failD.push(`${where}「${r.item}」電池がない場合の出し方が取り出せていない`);
    }
  };
  removeSpies();
  let nVerdict = 0, nGroup = 0;
  for (const r of app.DATA) {
    try { outEl.innerHTML = ""; orig.renderVerdict(r); checkRow(r, outEl.innerHTML, "確定"); nVerdict++; }
    catch (e) { failD.push(`確定「${r.item}」描画で例外：${e.message}`); }
  }
  const groups = {};
  for (const r of app.DATA) (groups[app.baseName(r.item)] = groups[app.baseName(r.item)] || []).push(r);
  for (const [base, rows] of Object.entries(groups)) {
    if (rows.length < 2) continue;
    try {
      outEl.innerHTML = ""; orig.renderChoices(base, rows); nGroup++;
      const h = outEl.innerHTML;
      if (/class="opt"/.test(h)) failD.push(`候補「${base}」タップ用のボタンが残っている`);
      const n = (h.match(/class="cand"/g) || []).length;
      if (n !== rows.length) failD.push(`候補「${base}」${rows.length}件のうち ${n} 件しか出ていない`);
      for (const r of rows) {
        const part = h.split('<div class="cand">').find(x => x.includes(`早見表：${escText(r.item)}`)) || "";
        checkRow(r, part, "候補");
      }
    } catch (e) { failD.push(`候補「${base}」描画で例外：${e.message}`); }
  }
  for (const w of ["アイロンと乾電池", "段ボールや雑誌"]) {
    try {
      outEl.innerHTML = "";
      await context.render(w);
      const h = outEl.innerHTML;
      const n = (h.match(/class="multi-h"/g) || []).length;
      if (n !== 2 || /class="opt"/.test(h) || (h.match(/class="dow"/g) || []).length < 2) failD.push(`複数「${w}」が1ページに両方出ていない`);
    } catch (e) { failD.push(`複数「${w}」描画で例外：${e.message}`); }
  }
  // 部材から推定：根拠にする早見表の行が実在するか、見立てた部材がすべて表示されるか
  for (const p of app.PARTS) for (const n of p.rows) if (!app.DATA.find(r => r.item === n)) failD.push(`部材「${p.name}」の根拠の行「${n}」が早見表にない`);
  for (const [k, ids] of Object.entries(app.PART_WORDS)) for (const id of ids) if (!app.PARTS.find(p => p.id === id)) failD.push(`部材の見立て「${k}」の部材「${id}」が定義にない`);
  for (const w of ["燃えないゴミ", "資源ごみ"]) {
    try {
      outEl.innerHTML = ""; await context.render(w); const h = outEl.innerHTML;
      if (!/class="week"/.test(h) || !/class="label"/.test(h) || !/品目（\d+種類）/.test(h)) failD.push(`区分名「${w}」の案内が出ていない`);
    } catch (e) { failD.push(`区分名「${w}」描画で例外：${e.message}`); }
  }
  for (const w of ["引っ越しごみ", "遺品"]) {
    try {
      outEl.innerHTML = ""; await context.render(w); const h = outEl.innerHTML;
      const n = (h.match(/class="case"/g) || []).length;
      if (!h.includes("実物で確かめる順番") || n < 13) failD.push(`名前だけの「${w}」に確かめる順番が出ていない（${n}項目）`);
    } catch (e) { failD.push(`名前だけの「${w}」描画で例外：${e.message}`); }
  }
  // 貼り紙の品目名に、入力した言葉そのものを入れない（早見表の品目名か決まった呼び方だけ）
  for (const w of ["車で使う充電台", "スマホの充電台", "木の小物入れ", "ステンレスのラック"]) {
    try {
      outEl.innerHTML = ""; await context.render(w); const h = outEl.innerHTML;
      const names = [...h.matchAll(/class="lc ln"[^>]*>([^<]*)</g)].map(m => m[1]);
      if (names.some(n => n.includes(w))) failD.push(`貼り紙「${w}」の品目名に入力した言葉が入っている：${[...new Set(names)].join("／")}`);
    } catch (e) { failD.push(`貼り紙「${w}」描画で例外：${e.message}`); }
  }
  for (const w of ["スマホの充電台", "補聴器", "ワイパー", "ピーラー", "家電"]) {
    try {
      outEl.innerHTML = "";
      await context.render(w);
      const h = outEl.innerHTML;
      const n = (h.match(/<div class="ch">[①-⑨]/g) || []).length;
      if (!h.includes("部材から考えました") || !n || !/class="week"/.test(h) || h.includes("実物で確かめる順番")) failD.push(`部材「${w}」が部材からの推定として出ていない`);
    } catch (e) { failD.push(`部材「${w}」描画で例外：${e.message}`); }
  }
  installSpies();
  const okD = failD.length === 0;
  console.log(`(D) 画面表示: 確定 ${nVerdict} 品目・候補 ${nGroup} グループ・複数入力 2 件・部材推定 5 件・区分名 2 件・確かめる順番 2 件` + (okD ? "  OK" : `  NG（${failD.length} 件）`));
  failD.slice(0, 30).forEach(f => console.log(`    NG ${f}`));
  if (!okD) failed++;

  console.log(failed ? `\n失敗 ${failed} 項目` : "\nすべて合格");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
