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
  variants, norm, baseName, searchExact, searchPartial, synonymHits, localGuess };`,
  context, { filename: "index.html<script>" }
);
const app = context.__app;

/* ---------- 画面描画の横取り ---------- */
let captured = null;
let pending = null;
const orig = {
  guess: context.guess,
  sortMetalFirst: context.sortMetalFirst
};
context.renderVerdict = (r) => { captured = { type: "verdict", rows: [r] }; };
context.renderChoices = (word, hits) => {
  captured = { type: "choices", rows: orig.sortMetalFirst(hits, x => x.item) };
};
context.renderGuessChoices = (word, rows) => {
  captured = { type: "guess", rows: orig.sortMetalFirst(rows, x => x.r.item).map(x => x.r) };
};
context.renderUnknown = () => { captured = { type: "unknown", rows: [] }; };
context.guess = (word) => { pending = orig.guess(word); return pending; };

async function run(input) {
  captured = null; pending = null;
  const outEl = els["out"];
  outEl.innerHTML = "";
  context.render(String(input).trim()); // 「調べる」ボタンと同じ
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

  console.log(failed ? `\n失敗 ${failed} 項目` : "\nすべて合格");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
