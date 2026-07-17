# Game Maker: ゆめにっき系ウォーキングシミュレーター設計

`src/workflow/agents/game-maker-rpg.ts` が生成する「散策ゲーム」の設計。
初期実装は 30×24 の単一マップ＋一言NPCのみで、遊び場も物語も薄かった。
本設計では unj-reze の rpg エンジンが持つ **マルチシーン**（`scenes[]` + `warpSceneId`）と
**イベントページ**（`pages` / `EventCommand`）を使い、ゆめにっきの構造
——扉の間（ネクサス）から雰囲気の違う夢世界へ潜り、住人と言葉を交わし、
最深部で目覚める——を再現する。

方針は action 版と同じ: **LLM は小さな決定だけ、組み立てと検証は決定的な TypeScript**。
ローカルLLM前提のため、LLM の出力は「コンセプト1回＋ワールドごとに1回」の小さなJSONに分割する。

## 1. パイプライン

```
[1] コンセプト生成（1回）
      title / endingMessage / worlds（3〜6個・最初が拠点）/ effects（0〜3個）/ endingWorldId
[2] ワールド生成（ワールド数ぶん繰り返し・各自に修正ループ MAX_REPAIR=4）
      asciiMap（30×24）+ entities（npc / warp / door / effect）
      → buildRpgWorld() が検証・コンパイル。エラーは repairPrompt で差し戻し
[3] リンク・組み立て（決定的）
      assembleRpgManifest() が扉の出現座標を解決し scenes[] マニフェスト化
      → RpgManifestSchema → lintRpgManifest()（シーングラフ＋シーン内BFS）
[4] logs/ へ保存。UNJ_REZE_SUBMIT=1 のとき POST /api/games
```

総マップ面積は 30×24 × ワールド数（3〜6）で、単一マップ時代の3〜6倍。
1回のLLM出力サイズは従来と同じに保たれる。

## 2. 世界の構造ルール（構造で接続を保証する）

- `worlds[0]` が **拠点（ネクサス）**。`'S'`（開始位置）はここだけ。
- 拠点は **他の全ワールドへの扉**を必ず持つ（builder がエラーで強制）。
- 拠点以外は **拠点へ戻る扉**を必ず持つ。他ワールドへの近道の扉は任意（夢のループ感）。
- `'G'`（めざめの場所）は `endingWorldId` のワールドにちょうど1つ。踏むとエンディング。
- この3点により、シーングラフは検証を待たず構造的に連結になる。

扉（`door`）の `toCol/toRow` は省略可。省略時は assemble が
「行き先ワールドにある、こちらへ戻る扉」の隣（到達集合内）へ降ろすため、
扉どうしが自動で対になる。明示座標が孤島を指す場合も安全な位置へ補正する。

## 3. 会話イベントDSL → EventPage

NPC は2種類:

1. **つぶやきNPC** … `message` に一言。頭上メッセージでふらふら歩く（従来通り）。
2. **会話イベントNPC** … `dialogue` を持ち、builder が `pages` へ決定的にコンパイル:

```jsonc
{ "type": "npc", "col": 5, "row": 8, "emoji": "👧",
  "dialogue": {
    "onceLines": ["……はじめて みる かお。"],       // 初対面のみ（セルフスイッチA）
    "lines": ["まだ いたの？"],                      // ふだんの会話
    "choice": { "prompt": "かえりみちを きく？",     // 1段の選択肢
      "options": [
        { "label": "きく", "lines": ["とびらは うしろに ある。"] },
        { "label": "だまる", "lines": ["……そう。"] } ] },
    "ifEffect": { "effectId": "lantern",             // エフェクト所持時の特別反応
      "lines": ["その あかり…… どこで ひろったの。"] }
  } }
```

ページ順は「エフェクト反応 → はじめて → ふだん」（エンジンは先頭一致で選ぶ）。
DSL は入れ子を1段に制限してあり、ローカルLLMでも壊れにくい。

## 4. 収集エフェクト

ゆめにっきの「エフェクト」に相当する小道具。コンセプトで宣言（`worldId` で配置先を固定）し、
ワールド生成時に `{ "type": "effect", "effectId": ... }` として置く（置き忘れはエラー）。
builder は「一度だけ拾える」イベント（`giveItem` + セルフスイッチA）と、
マニフェストの `items[]`（category: key・捨てられない）を生成する。
NPC の `ifEffect` が `hasItem` 条件ページとして反応する。

## 5. 検証

**ワールド単位**（buildRpgWorld、修正ループ内）:
- ASCII正規化（行数・列数・空白）／未知文字・S重複はエラー
- S/G の配置ルール（§2）・扉の網羅性
- BFS（4方向＋同一ワールド内warp）: 起点は拠点=S、他=拠点へ戻る扉
  - 扉・G・エフェクトが到達不能 → エラー／NPC孤島 → 警告
  - warp の飛び先から扉にもGにも戻れない袋小路 → エラー（詰み防止）
- 歩ける範囲 < 60 マス → 警告

**全体**（lintRpgManifest、組み立て後）:
- シーングラフ: 扉を辺として拠点から全シーン到達可能か
- シーン内BFS: 各シーンの入口（扉の出現座標）から G・扉・NPC の到達性
- G の個数・到達性、エフェクトの置き忘れ、総歩行可能マス < 250 → 警告

## 6. エンジン側の対応機能（unj-reze 実測）

- `GameManifestDraft.scenes[]`: シーンごとの map / objects / bgm（文字列ref。`mml:` 可）
- `ObjectDef.warpSceneId` + `warpEntryCol/Row`: フェード付きシーン間ワープ。
  入場地点付近のワープは発動抑止されるため、扉のそばに降りても即逆戻りしない
- `ObjectDef.pages`: `EventPage`（conditions: selfSwitch / itemId）+
  `EventCommand`（message / choice / giveItem / setSelfSwitch / overheadMessage）
- `items[]` / タイル `special: 'goal'` / `titleScreen` / `ending`

## 7. ファイル構成

```
src/game-maker/rpg/
  catalog.ts   # タイル凡例（+くらい床/はなばたけ）・mood別MML BGM・エンティティ別名表
  schema.ts    # コンセプト（worlds/effects）・会話DSL・ワールドレベル・マニフェストの Zod
  prompts.ts   # コンセプト用＋ワールド用（拠点/最深部/エフェクト割当で内容が変わる）
  builder.ts   # buildRpgWorld（検証・EventPageコンパイル）/ assembleRpgManifest（扉リンク）
  lint.ts      # マルチシーンのセマンティックリント
src/workflow/agents/game-maker-rpg.ts   # オーケストレーション
src/workflow/tests/game-rpg-test.ts     # LLM不要のパイプラインテスト（pnpm test:game-rpg）
```
