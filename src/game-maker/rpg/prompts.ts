// ウォーキングシミュレーター向けの内部プロンプト。
// 凡例・ルールは catalog.ts から自動生成し、プロンプトとバリデータの乖離を防ぐ。
// ローカルLLM前提のため出力は常に「小さなJSONだけ」：コンセプト1回＋ワールドごとに1回。
// 修正プロンプトは ../prompts.ts の repairPrompt（課題全文を再掲する方式）を共用する。

import { RPG_COLS, RPG_MOOD_HINTS, RPG_MOODS, RPG_ROWS, RPG_TILES } from "./catalog";
import type { RpgConcept, RpgWorldDef } from "./schema";

const tileLegend = RPG_TILES.map((t) => `  '${t.char}' = ${t.name}: ${t.hint}`).join("\n");
const moodList = RPG_MOODS.map((m) => `"${m}"（${RPG_MOOD_HINTS[m]}）`).join(" | ");

/** ステージ1: コンセプト（夢世界の一覧＋収集エフェクト） */
export function rpgConceptPrompt(theme: string): string {
	return `あなたは「ウォーキングシミュレーター」（ゆめにっき系）のデザイナーです。
戦闘や敵は一切なく、いくつもの不思議な夢世界を扉でわたり歩くゲームです。
次のテーマで新しい夢のコンセプトを1つ考えてください。

テーマ: ${theme}

## 世界の構成
- worlds は3〜5個。最初の1つが「拠点」（ゆめにっきのネクサス）で、他の全世界への扉が並ぶ静かな場所。
- 残りは雰囲気のちがう夢世界。theme には「何が見える場所か」を具体的な情景で1行書く
  （例:「さかさまの鳥居が水面から生えている赤い湿原」）。
- endingWorldId には「めざめの場所」を置く最も奥のワールドを1つ選ぶ（拠点以外）。
- effects は世界に落ちている収集アイテム（0〜3個）。拾うとNPCの反応が変わる小道具
  （例: ランタン、ちいさなカギ、しおれた花）。worldId でどの世界に置くか決める。

以下のキーを持つJSONだけを出力してください。説明文やコードブロックは不要です。

{
  "title": "ゲームタイトル（20文字以内、不思議な雰囲気）",
  "subtitle": "タイトル画面の副題（30文字以内）",
  "endingMessage": "夢から覚めたときに表示する文（100文字以内、余韻のある文。改行は\\n）",
  "playerEmoji": "主人公の絵文字1つ",
  "worlds": [
    { "id": "nexus", "name": "拠点の名前", "mood": "dream", "theme": "情景を1行" },
    { "id": "英小文字のID", "name": "世界の名前（10文字前後）", "mood": "night", "theme": "情景を1行" }
  ],
  "effects": [
    { "id": "英小文字のID", "name": "アイテム名", "emoji": "絵文字1つ", "worldId": "置く世界のid" }
  ],
  "endingWorldId": "めざめの場所を置く世界のid"
}

mood は ${moodList} から選ぶ。`;
}

/** ステージ2: ワールドごとのマップとエンティティ */
export function rpgWorldPrompt(concept: RpgConcept, world: RpgWorldDef): string {
	const isNexus = concept.worlds[0].id === world.id;
	const isEnding = concept.endingWorldId === world.id;
	const nexusId = concept.worlds[0].id;
	const otherWorlds = concept.worlds.filter((w) => w.id !== world.id);
	const worldList = otherWorlds.map((w) => `  '${w.id}' = ${w.name}（${w.theme}）`).join("\n");
	const assignedEffects = concept.effects.filter((e) => e.worldId === world.id);
	const knownEffects = concept.effects
		.map((e) => `  '${e.id}' = ${e.emoji}${e.name}（${e.worldId} に落ちている）`)
		.join("\n");

	const doorRule = isNexus
		? `- ここは拠点（ネクサス）。他の全ワールドへの扉を必ず1つずつ置く:
${otherWorlds.map((w) => `    { "type": "door", "toWorld": "${w.id}", ... }`).join("\n")}
- 'S'（プレイヤー開始位置）を必ず1つ置く。`
		: `- 拠点へ戻る扉 { "type": "door", "toWorld": "${nexusId}", ... } を必ず1つ置く。
- 他のワールドへの近道の扉を足してもよい（0〜1個。夢がループする感じになる）。toWorld に使えるID:
${worldList}
- 'S' は置かない（拠点専用）。`;

	const goalRule = isEnding
		? `- ここが最深部。'G'（めざめの場所）を最も奥まった場所にちょうど1つ置く。踏むと夢から覚めてエンディング。`
		: `- 'G' は置かない（ワールド '${concept.endingWorldId}' 専用）。`;

	const effectRule =
		assignedEffects.length > 0
			? `- このワールドには次の収集エフェクトを必ず配置する（見つけにくい場所に）:
${assignedEffects.map((e) => `    { "type": "effect", "effectId": "${e.id}", "col": ..., "row": ..., "message": "拾ったときの短い文" }`).join("\n")}`
			: `- このワールドに配置するエフェクトはない（type: "effect" は使わない）。`;

	return `あなたは「ウォーキングシミュレーター」（ゆめにっき系）のマップデザイナーです。
ゲーム「${concept.title}」の夢世界のひとつ「${world.name}」を設計してください。
情景: ${world.theme}
戦闘はありません。プレイヤーはただ歩き、風景を眺め、不思議な住人と言葉を交わします。

## マップの書き方
- 1文字が1マス。必ず ${RPG_ROWS} 行、各行 ${RPG_COLS} 文字ちょうどにする。
- 使える文字（凡例）:
${tileLegend}
  'S' = プレイヤー開始位置（拠点のみ・歩けるマスに置く）

## 設計ルール
- 外周は 'M' か 'W' か '~' で囲む（マップの外に出られないように）。
- 曲がりくねった道・行き止まり・小部屋・広場を混ぜて「歩きたくなる」地形にする。
- 水辺('~')や森('F')で風景を作り、'B'（橋）・'D'（扉タイル）・'o'（花）・'d'（暗い床）でアクセントをつける。
- 歩けるマスが100マス以上になるようにする。
${goalRule}

## エンティティ
${doorRule}
${effectRule}
- "npc": 不思議な住人。3〜6体。次の2種類を混ぜる:
  1. つぶやきNPC … "message" に短く謎めいた一言。ふらふら歩き回る。
  2. 会話イベントNPC（1〜3体） … "dialogue" を持ち、その場に立って会話する。
- "warp": 踏むと同じワールド内の別地点へ飛ぶ渦。0〜2個。遠く離れた場所同士をつなぐと夢らしくなる。

## dialogue（会話イベント）の書き方
- lines: ふだんの会話（1〜4行。1行は60文字以内）
- onceLines: はじめて会ったときだけの会話（任意）
- choice: 選択肢を1回だけ出せる（任意）。prompt が問いで、options が2〜3個
- ifEffect: プレイヤーが特定のエフェクトを持っているときの特別な反応（任意）
既知のエフェクト:
${knownEffects || "  （なし）"}
例:
  { "type": "npc", "col": 5, "row": 8, "emoji": "👧",
    "dialogue": {
      "onceLines": ["……はじめて みる かお。", "ここは ながい ゆめの とちゅう。"],
      "lines": ["まだ いたの？"],
      "choice": { "prompt": "かえりみちを きく？", "options": [
        { "label": "きく", "lines": ["とびらは いつも うしろに ある。"] },
        { "label": "だまる", "lines": ["……そう。"] } ] }
    } }

## 出力形式
以下のJSONだけを出力してください。説明文やコードブロックは不要です。
- asciiMap は「${RPG_ROWS}個の文字列」の配列。1つの文字列が1行で、文字列の中に改行を入れない。
- entities の col は 0〜${RPG_COLS - 1}、row は 0〜${RPG_ROWS - 1} の範囲。
- door の toCol/toRow は省略してよい（自動で相手側の扉のそばに出る）。
- entities は多くても15個程度にとどめる。同じセリフやほぼ同じ内容のNPCを繰り返し出力しないこと。
- JSONを1つ出力したら、そこで終わりにする。それ以降に別のJSONや説明・繰り返しを続けないこと。

{
  "asciiMap": ["1行目の文字列", "2行目の文字列", ... 全${RPG_ROWS}行],
  "entities": [
    { "type": "door", "col": 14, "row": 2, "emoji": "🚪", "toWorld": "ワールドid" },
    { "type": "npc", "col": 5, "row": 8, "emoji": "👻", "message": "セリフ" },
    { "type": "warp", "col": 12, "row": 20, "toCol": 25, "toRow": 3 }
  ]
}`;
}
