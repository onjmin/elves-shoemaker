// unj-reze の rpg エンジンで作る「ウォーキングシミュレーター」（ゆめにっき系）向けカタログ。
// 戦闘・敵は無し。複数の夢世界（シーン）を扉でつなぎ、散策・不思議なNPC・
// 会話イベント・収集アイテム（エフェクト）だけで構成する。
// タイル画像・歩行アニメは rpgen-search の実績あるアセットID（dq.ts 出典）を使う。

import { soundUrl, spriteUrl, walkRef } from "../rpgen";

export const RPG_COLS = 30;
export const RPG_ROWS = 24;
export const TILE_SIZE = 32;

// ── タイル定義（ASCII 1文字 ⇔ タイルID、dq.ts と同じ記法） ─────────────────
export interface RpgTileEntry {
	id: number;
	char: string;
	name: string;
	color: string;
	passable: boolean;
	special?: string;
	/** rpgen-search の sprite id（16px単体画像。クロップ不要） */
	spriteId?: string;
	hint: string;
}

export const RPG_TILES: RpgTileEntry[] = [
	{
		id: 0,
		char: ".",
		name: "草原",
		color: "#3a9a4a",
		passable: true,
		spriteId: "seHP8GT",
		hint: "歩ける地面",
	},
	{
		id: 1,
		char: "M",
		name: "山",
		color: "#6b5a3a",
		passable: false,
		spriteId: "7COldwt",
		hint: "通れない壁（外周に）",
	},
	{
		id: 2,
		char: "~",
		name: "水",
		color: "#2a5acb",
		passable: false,
		spriteId: "4vGDOZE",
		hint: "通れない水",
	},
	{
		id: 3,
		char: "C",
		name: "城壁",
		color: "#b0b0c0",
		passable: false,
		spriteId: "h9WtBWs",
		hint: "遺跡・建物の壁",
	},
	{
		id: 4,
		char: "F",
		name: "森",
		color: "#1f5a2a",
		passable: false,
		spriteId: "IoHgv20",
		hint: "通れない森",
	},
	{
		id: 5,
		char: "s",
		name: "石床",
		color: "#5a5a6a",
		passable: true,
		spriteId: "sTJ89N",
		hint: "屋内・遺跡の歩ける床",
	},
	{
		id: 6,
		char: "W",
		name: "壁",
		color: "#3a3a4a",
		passable: false,
		spriteId: "vcyXmCw",
		hint: "建物・洞窟の壁",
	},
	{
		id: 7,
		char: "D",
		name: "扉",
		color: "#c0802a",
		passable: true,
		spriteId: "p6oDkn7",
		hint: "通れる扉",
	},
	{
		id: 8,
		char: "B",
		name: "橋",
		color: "#a5793f",
		passable: true,
		spriteId: "sTJ89N",
		hint: "水にかける橋",
	},
	{
		id: 9,
		char: "r",
		name: "じゅうたん",
		color: "#7a1f2b",
		passable: true,
		hint: "赤いじゅうたん",
	},
	{
		id: 10,
		char: "G",
		name: "めざめの場所",
		color: "#ffd700",
		passable: true,
		special: "goal",
		hint: "踏むと夢から覚める（エンディング）。最深部ワールドに1つだけ",
	},
	{
		id: 11,
		char: "d",
		name: "くらい床",
		color: "#26243a",
		passable: true,
		hint: "夜・洞窟の歩ける床",
	},
	{
		id: 12,
		char: "o",
		name: "はなばたけ",
		color: "#7a4f8a",
		passable: true,
		hint: "花・装飾の歩ける地面",
	},
];

export const RPG_START_CHAR = "S";
export const RPG_CHAR_TO_TILE: ReadonlyMap<string, RpgTileEntry> = new Map(
	RPG_TILES.map((t) => [t.char, t]),
);
/** 右埋めに使ってよい地形文字 */
export const RPG_SAFE_PAD = new Set([".", "M", "~", "C", "F", "s", "W", "B", "r", "d", "o"]);

// ── エンティティ ─────────────────────────────────────────────────────────
// npc    = 話しかけると言葉を返す住人。message（一言）か dialogue（会話イベント）を持つ
// warp   = 踏むと同一ワールド内の別地点へ飛ぶ（夢の非ユークリッド感の演出）
// door   = 触れると別ワールド（シーン）へ移動する扉
// effect = 拾える収集アイテム（ゆめにっきの「エフェクト」）。NPCが反応することがある
export type RpgEntityType = "npc" | "warp" | "door" | "effect";
export const RPG_ENTITY_TYPES: RpgEntityType[] = ["npc", "warp", "door", "effect"];

/** LLMが出しがちな別名 → 正式タイプ（小文字で引く） */
export const RPG_ENTITY_ALIASES: Record<string, RpgEntityType> = {
	villager: "npc",
	person: "npc",
	ghost: "npc",
	spirit: "npc",
	character: "npc",
	portal: "warp",
	teleport: "warp",
	teleporter: "warp",
	hole: "warp",
	exit: "door",
	gate: "door",
	entrance: "door",
	stairs: "door",
	item: "effect",
	pickup: "effect",
	collectible: "effect",
	treasure: "effect",
};

export const DOOR_DEFAULT_EMOJI = "🚪";
export const WARP_DEFAULT_EMOJI = "🌀";

/** NPC絵文字 → 歩行アニメid（dq.ts の実績id。無い絵文字はそのまま絵文字表示） */
export const NPC_SPRITE_BY_EMOJI: Record<string, string> = {
	"🧙": "xP8oPz",
	"🧙‍♂️": "xP8oPz",
	"👴": "M05nRh",
	"👵": "M05nRh",
	"👩": "okIlh5",
};

/** 主人公の歩行アニメ（dq.ts の勇者） */
export const HERO_SPRITE_REF = walkRef("0yyTSP");

// ── BGM / SFX ─────────────────────────────────────────────────────────────
// BGM は自己完結の MML ループ。ゆめにっき風に不穏で静かなループを moods 別に用意。
// ワールド（シーン）ごとに mood を選ばせ、シーンBGMとして流す。
export const RPG_MOODS = ["dream", "night", "ruins", "forest", "snow", "neon"] as const;
export type RpgMood = (typeof RPG_MOODS)[number];

export const RPG_BGM: Record<RpgMood, string> = {
	// 夢の草原：ゆったり浮遊感
	dream: "mml:t70o4l2ce-ge- l1f l2d-fa-f l1e-",
	// 夜の街：単音がぽつぽつ落ちる
	night: "mml:t60o3l4arereler l2d1",
	// 遺跡・廃墟：低く重い
	ruins: "mml:t55o3l2c<b-a-g l1a-",
	// 森：うすあかるいが噛み合わない
	forest: "mml:t66o4l2egc l1a l2fad l1g",
	// 雪原：高く澄んで途切れがち
	snow: "mml:t58o5l4crb-rgr l1a-",
	// ネオン街：はやく単調な明滅
	neon: "mml:t84o4l8crcre-rcr l4grfr l2e-",
};

/** mood ごとの日本語ヒント（コンセプトプロンプトの選択肢説明に使う） */
export const RPG_MOOD_HINTS: Record<RpgMood, string> = {
	dream: "浮遊感のある夢の草原",
	night: "静まりかえった夜",
	ruins: "低く重い遺跡・廃墟",
	forest: "うすぐらい森",
	snow: "澄んで冷たい雪原",
	neon: "明滅するネオン街",
};

export const RPG_SFX: Record<string, string> = {
	clear: "clear",
	warp: `direct:${soundUrl("vfCmoe")}`,
};

/** タイル画像URL（rpgen-search sprite 直リンク） */
export const rpgTileImageUrl = (id: string) => spriteUrl(id);
