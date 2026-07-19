// action エンジン向けの内部プロンプト。ローカルLLM（16GB vRAM級）を前提に、
// 出力は常に「小さなJSONだけ」を要求する。凡例・エンティティ一覧は catalog.ts から
// 自動生成し、プロンプトとバリデータの乖離を防ぐ。

import { ACTION_ENTITIES, ACTION_TILES, ROWS } from "./catalog";
import type { GameConcept } from "./schema";

const tileLegend = ACTION_TILES.map((t) => `  '${t.char}' = ${t.name}: ${t.hint}`).join("\n");

const entityLegend = Object.entries(ACTION_ENTITIES)
	.map(([type, p]) => `  "${type}" (${p.emoji} ${p.name}): ${p.hint}`)
	.join("\n");

/** ステージ1: ゲームコンセプトを決めさせる */
export function conceptPrompt(theme: string): string {
	return `あなたは2Dアクションゲーム（マリオ風横スクロール）のデザイナーです。
次のテーマで新しいゲームのコンセプトを1つ考えてください。

テーマ: ${theme}

以下のキーを持つJSONだけを出力してください。説明文やコードブロックは不要です。

{
  "title": "ゲームタイトル（20文字以内）",
  "subtitle": "タイトル画面の副題（30文字以内）",
  "endingMessage": "クリア時に表示するメッセージ（60文字以内、改行は\\n）",
  "playerEmoji": "主人公の絵文字1つ",
  "worldCols": ステージの横幅（40〜100の整数。60前後を推奨）,
  "mood": "overworld" | "underground" | "castle" のいずれか（BGMの雰囲気）
}`;
}

/** ステージ2: ASCIIマップとエンティティ配置を作らせる */
export function levelPrompt(concept: GameConcept): string {
	return `あなたは2Dアクションゲーム（マリオ風横スクロール）のレベルデザイナーです。
ゲーム「${concept.title}」（${concept.subtitle}）のステージを設計してください。

## マップの書き方
- 1文字が1マス。必ず ${ROWS} 行、各行 ${concept.worldCols} 文字ちょうどにする。
- 使える文字（凡例）:
${tileLegend}
  'S' = プレイヤー開始位置（1つだけ。下に地面がある空マスに置く）

## 設計ルール
- 下2行は基本 '=' の地面にする。穴を掘る場合は幅2〜3マス（4マス超は飛び越えられない）。
- 'S' は左端付近、'G'（ゴール旗）は右端付近の地面の上に置く。
- 段差は高さ2マスまで（3マス以上の壁は登れないので、階段状にする）。
- '?' や '#' の浮きブロックは地面から3〜4マス上に置く（頭上ヒットできる高さ）。
- 'o'（コイン）をジャンプで取りたくなる場所に散らす。
- 中間地点に 'C'（チェックポイント）を1つ置く。

## エンティティ（敵・NPC・リフト）
使えるタイプ（type は必ずこの英語IDから選ぶ。一覧にないタイプを発明しないこと。
テーマに合う敵がいなくても、近いものをこの中から選ぶ）:
${entityLegend}

- 敵は地面の上（rowは地面の1つ上）に置く。開始位置の近く3マス以内には置かない。
- "toad" を開始位置の近くに1体置き、message に操作のヒントを入れる。
- "princess" をゴールの先に1体置き、message にお礼のセリフを入れる。
- 穴の上を渡らせたい場合は "platformH" を穴の上に置く。

## 出力形式
以下のJSONだけを出力してください。説明文やコードブロックは不要です。
- asciiMap は「${ROWS}個の文字列」の配列。1つの文字列が1行で、文字列の中に改行を入れない。
- 'S'（開始位置）と 'G'（ゴール旗）を必ず含める。どちらも地面（'='）のすぐ上の行に置く。
- entities の col は 0〜${concept.worldCols - 1} 、row は 0〜${ROWS - 1} の範囲。

{
  "asciiMap": ["1行目の文字列", "2行目の文字列", ... 全${ROWS}行],
  "entities": [
    { "type": "goomba", "col": 10, "row": 12 },
    { "type": "toad", "col": 4, "row": 12, "message": "セリフ" }
  ]
}`;
}

/** 検証エラーを渡して修正させる。
 *  ローカルLLMには会話履歴が無い（毎回1プロンプト完結）ため、
 *  元の課題（凡例・ルール一式）を必ず再掲する。エラーと前回出力だけを渡すと
 *  モデルがルールを忘れて回を追うごとに劣化する。
 *  指示文は英語にしている（ローカルLLMは英語の指示追従の方が総じて安定するため）。 */
export function repairPrompt(
	originalPrompt: string,
	previousJson: string,
	errors: string[],
): string {
	return `${originalPrompt}

──────────────────────────────
IMPORTANT: your previous output had the following problems.

## Your previous output
${previousJson}

## Problems detected
${errors.map((e) => `- ${e}`).join("\n")}

Following the rules above, output a complete, corrected JSON that fixes every problem.
Output JSON only — no explanation, no code fences, no text before or after it.`;
}
