# Game Maker: RPG エンジン対応設計

unj-reze の `rpg` エンジン（ドラクエ風・見下ろし2D＋ターン制戦闘）向けゲームを
自動生成するための設計。action エンジン実装（`src/game-maker/`）と同じ思想
——**LLM は小さな決定だけ、組み立てと検証は決定的な TypeScript**——を踏襲する。

参照実装: `unj-reze/components/game-presets/dq.ts`（DQ1縮約版・5シーン構成）

## 1. v1 スコープ

**やる**
- マルチシーン構成（城・フィールド・町・洞窟の 2〜4 シーン、warp で接続）
- ターン制戦闘（`battle.style: 'classic'`）: プレイヤーステータス・呪文・レベルテーブル
- シンボルエンカウント敵＋シーン別ランダムエンカウント
- 会話 NPC（頭上メッセージ）・宝箱（`chest` 定型イベント）・ゴールボス
- rpgen-search による素材解決（タイル画像・歩行アニメ・SE）

**やらない（v2以降）**
- 自由な `EventCommand` 列（スイッチ分岐・カットシーン）→ 定型パターンのみ
- ショップ（`shopItems`）・宿屋 → v1.5 候補（定型イベントとして安全に足せる）
- undertale/deltarune スタイル戦闘

## 2. 中間表現（LLM の出力）

action と同様に段階分割する。1ステージ1JSONで、各段階の出力を Zod 検証する。

### Stage 1: コンセプト
```jsonc
{
  "title": "...", "endingMessage": "...",
  "heroName": "ゆうしゃ",
  "story": "王さまに使命を受け、洞窟のボスを討つ",  // 以降の段階に文脈として渡す
  "scenes": [                                        // 2〜4件。最初が開始シーン
    { "id": "castle", "name": "はじまりの城", "kind": "castle", "cols": 30, "rows": 24 },
    { "id": "field",  "name": "フィールド",   "kind": "field",  "cols": 30, "rows": 24 },
    { "id": "cave",   "name": "final",        "kind": "cave",   "cols": 24, "rows": 20 }
  ],
  "bossSceneId": "cave"
}
```

### Stage 2: シーンごとのマップ（シーン数ぶん繰り返し）
ASCII 凡例は dq.ts の記法をそのまま採用（LLM に馴染むよう1文字=1タイル）:

| 文字 | タイル | passable |
|---|---|---|
| `.` | 草原 | ○ |
| `M` | 山 | × |
| `~` | 水 | × |
| `C` | 城壁 | × |
| `F` | 森 | × |
| `s` | 石床 | ○ |
| `W` | 壁 | × |
| `D` | 扉 | ○ |
| `B` | 橋 | ○ |
| `S` | 開始位置（開始シーンのみ・草原扱い） | — |

エンティティは種類を絞った定型で受ける:
```jsonc
{
  "asciiMap": ["MMMM...", ...],
  "entities": [
    { "type": "npc",   "col": 4, "row": 11, "emoji": "👴", "message": "..." },
    { "type": "foe",   "col": 12, "row": 14, "name": "スライム", "emoji": "🟦", "tier": 1 },
    { "type": "chest", "col": 25, "row": 10, "loot": "gold" },      // gold | herb | key
    { "type": "warp",  "col": 14, "row": 22, "to": "field", "toCol": 6, "toRow": 19 },
    { "type": "boss",  "col": 15, "row": 5,  "name": "竜王", "emoji": "🐲" }  // bossScene のみ
  ],
  "randomEncounters": [ { "name": "スライム", "emoji": "🟦", "tier": 1 } ],
  "mood": "castle"   // BGM/SEの雰囲気（catalog のキー）
}
```

### Stage 3: 戦闘バランス（LLM は「難易度カーブ」だけ）
数値バランスを LLM に直接書かせると必ず壊れるため、**tier（1〜5）だけを選ばせ、
実数値はビルダーの数式で決める**:

```
敵ステータス(tier) : hp = 20×1.5^tier, atk = 8×1.4^tier, def = 2×1.6^tier,
                     exp/gold は hp/atk から自動算出（dq.ts の実測値でフィッティング）
levelTable         : L2..L8 固定テンプレ（DQ1 準拠の成長曲線）
プレイヤー初期値    : maxHp 30 / maxMp 10 / atk 12 / def 8 / gold 150
呪文               : ホイミ(heal 20, MP3) / ギラ(power 18, MP4) 相当を名前だけ差し替え
boss               : tier5 固定 + moves 1つ
```

## 3. 決定的ビルダー（rpg/builder.ts）

- `foe` / `npc` / `warp` / `chest` ファクトリは dq.ts のもの（`newObject` ラッパ）を移植
- 宝箱は `shared.ts` の `chest()` と同じ2ページ構成（セルフスイッチA + playSound + giveItem）
  を定型生成。`loot: "key"` はボス扉の鍵にする…のは v2。v1 は gold / herb のみ
- items は固定セット（やくそう・かぎ等、dq.ts から流用）
- マニフェストは `scenes[]` 形式で出力（`map`/`objects` トップレベルには scenes[0] を複製）
- `battle` は Stage 3 の数式で生成。`battle.boss` に bossScene のボスを配置

## 4. 素材解決（rpgen-search 連携）

実装済みの `rpgen.search` ツール / `src/game-maker/rpgen.ts` を使う。

- **タイル**: `sprites` を「草」「石垣」等で検索 → `url:https://…/sprites/<id>.png`
- **NPC/敵**: `spriteAnims` を名前（例「スライム」「王様」）で検索 → `walk:auto:u:…`
- **SE**: `sounds` を「決定」「爆発」等で検索 → `direct:…mp3`

パイプラインでは各エンティティについて:
1. LLM が出した名前で `spriteAnims` を検索し、**先頭ヒットの id を採用**
2. ヒット0件なら **キュレーション済みフォールバック**（dq.ts の実績 id 表:
   スライム=k3vKh6, ドラキー=R42ett, がいこつ=pyPkIs, 老人=M05nRh, 魔法使い=xP8oPz,
   村娘=okIlh5 等）から絵文字カテゴリで選ぶ
3. それも無ければ絵文字のまま（spriteRef なしでも動く）

検索APIの注意（実測済み）:
- `meta` は `{hasNext,page,limit}` のみ（総件数なし）
- `q` は名前の部分一致。ヒットしない語も多いので0件は正常系として扱う
- 認証は `.env` の `RPGEN_SEARCH_TOKEN`（Origin=localhost で許可される）。
  未設定時は unj-reze のプロキシ `/api/rpgen/*` にフォールバック

## 5. 検証（rpg/lint.ts）

action の到達可能性BFSに代わり、rpg では **4方向歩行BFS** と **シーングラフ検証**:

1. **シーン内**: 開始位置（または warp 入口）から 4方向BFS。
   各 warp・boss・chest・NPC が到達可能マス（隣接含む）にあること
2. **シーン間**: warp を辺としたグラフで、開始シーンから bossScene へ到達可能なこと。
   warp の `to` が実在シーンID・`toCol/toRow` が通行可能マスであること
3. **戦闘整合**: bossScene にボスが1体だけ・boss は `isBoss: true`・
   randomEncounters の tier がシーン進行順で単調増加（警告）
4. **経済**: 宝箱ゴールド合計＋雑魚ゴールドで最低限の回復薬が買えるか（警告のみ）
5. **構造**: エンティティのマップ内チェック、NPC message 必須、warp 対の相互性（警告）

## 6. ファイル構成（予定）

```
src/game-maker/
  rpgen.ts            # 実装済み: rpgen-search クライアント
  catalog.ts          # action用（将来 action/ へ移動してもよい）
  rpg/
    catalog.ts        # タイル凡例・フォールバック素材id表・BGM/SE
    schema.ts         # Stage1-3 の Zod + RpgManifest（scenes/battle 込み）
    builder.ts        # 中間表現 → GameManifestDraft
    lint.ts           # 歩行BFS + シーングラフ検証
    prompts.ts        # 3段階のプロンプト
src/workflow/agents/game-maker.ts
                      # GAME_ENGINE=rpg|action で分岐（デフォルト action）
```

## 7. 未決事項

- タイトル/戦闘/ボスBGM: rpgen-search の `sounds` は SE 中心。BGM は
  MML内蔵曲（action と同様）か、YouTube URL のキュレーション表かを選ぶ
  → v1 は MML 推奨（自己完結・権利面も安全）
- シーンサイズ上限: dq.ts は 30×24。LLM の ASCII 精度を見て 24×20 に絞る可能性あり
- `randomEncounters` の miniScript（弾幕）は rpg では不要（classic 戦闘のため省略）
