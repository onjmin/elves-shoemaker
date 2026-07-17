// unj-reze の action エンジン（マリオ系）向けアセットカタログ。
// LLM には「名前」だけを選ばせ、実際の参照文字列（spriteRef / imageUrl / BGM ref）は
// ここで確定させる。URL を LLM に生成させると必ずハルシネーションするため、
// カタログ外のアセットは一切使わない方針。
//
// 出典: unj-reze/components/game-presets/mario.ts（SMC-released-sprites via jsDelivr）
// ライセンス: 非商用無料、作者クレジット必須（Cube, Fesh, Nitrox, NotAToon, Noveni,
// Red Bun, Smuglutena, TheCrushedJoycon, Tristaph）

export const TILE_SIZE = 32;
export const ROWS = 15;
export const MIN_WORLD_COLS = 20;
export const MAX_WORLD_COLS = 300;

const SMC_CDN = "https://cdn.jsdelivr.net/gh/Level-Share-Square/SMC-released-sprites@main";
const smcTile = (path: string, sx: number, sy: number, sw = 16, sh = 16) =>
	`${SMC_CDN}/${path}#${sx},${sy},${sw},${sh}`;

const RETRO = "SMW/Objects/Retro%20Skins/Retro_SMB1_Blocks.png";

// ── タイル定義（ASCII 1文字 ⇔ タイルID） ──────────────────────────────────
// タイルIDは mario プリセットと同じ番号を使う（few-shot と検証の整合のため）。
// imageUrl は #sx,sy,sw,sh クロップ付きの直URL。imageRef は敢えて付けない：
// GameMaker.loadManifest は imageRef があるとクロップなしURLで上書きするため、
// RPGEN インポートと同じ「imageUrl 直持ち」方式が安全。
export interface TileEntry {
	id: number;
	char: string;
	name: string;
	color: string;
	passable: boolean;
	special?: string;
	imageUrl?: string;
	imageOverflowTop?: boolean;
	imageScale2x?: boolean;
	/** LLM 向けの一言説明（プロンプトの凡例に載せる） */
	hint: string;
}

export const ACTION_TILES: TileEntry[] = [
	{ id: 0, char: ".", name: "空", color: "#5c94fc", passable: true, hint: "何もない空間" },
	{
		id: 1,
		char: "#",
		name: "ブロック",
		color: "#8B4513",
		passable: false,
		imageUrl: smcTile(RETRO, 144, 16),
		hint: "レンガブロック（足場や壁）",
	},
	{
		id: 2,
		char: "?",
		name: "ハテナ",
		color: "#FFD700",
		passable: false,
		special: "item",
		imageUrl: smcTile(RETRO, 144, 0),
		hint: "叩くとコインが出るブロック",
	},
	{
		id: 3,
		char: "G",
		name: "ゴール旗",
		color: "#32CD32",
		passable: true,
		special: "goal",
		imageUrl: smcTile("SMW/Objects/Goals%20%26%20Checkpoints/Flag_Pole.png", 240, 2, 16, 42),
		imageOverflowTop: true,
		hint: "触れるとクリア。ステージ終盤に1つ",
	},
	{
		id: 4,
		char: "|",
		name: "土管",
		color: "#2aa02a",
		passable: false,
		imageUrl: smcTile("SMW/General%20tiles/Large_Pipes.png", 216, 30, 46, 18),
		imageScale2x: true,
		hint: "土管の胴体（Tの下に縦に積む）",
	},
	{
		id: 5,
		char: "=",
		name: "岩床",
		color: "#555566",
		passable: false,
		imageUrl: smcTile("SMW/Tilesets/Castle.png", 48, 64),
		hint: "地面・床のメイン素材",
	},
	{
		id: 7,
		char: "C",
		name: "チェックポイント",
		color: "#ff8800",
		passable: true,
		special: "checkpoint",
		hint: "踏むと復活地点になる（中間に1つ）",
	},
	{
		id: 9,
		char: "~",
		name: "水",
		color: "#3a78f0",
		passable: true,
		special: "water",
		hint: "泳げる水",
	},
	{
		id: 10,
		char: "L",
		name: "溶岩",
		color: "#ff4400",
		passable: true,
		special: "lava",
		hint: "触れるとダメージ（穴の底などに）",
	},
	{
		id: 11,
		char: "x",
		name: "壊せるブロック",
		color: "#c08840",
		passable: false,
		special: "destructible",
		imageUrl: smcTile(RETRO, 144, 16),
		hint: "下から叩くと壊れるレンガ",
	},
	{
		id: 13,
		char: "T",
		name: "土管トップ",
		color: "#2aa02a",
		passable: false,
		imageUrl: smcTile("SMW/General%20tiles/Large_Pipes.png", 213, 0, 50, 24),
		imageScale2x: true,
		imageOverflowTop: true,
		hint: "土管の傘（|の上に置く）",
	},
	{
		id: 15,
		char: "-",
		name: "すり抜け床",
		color: "#ffb366",
		passable: true,
		special: "oneway",
		hint: "下から通れて上に乗れる床",
	},
	{
		id: 16,
		char: "o",
		name: "コイン",
		color: "#ffd700",
		passable: true,
		special: "coin",
		hint: "取れるコイン",
	},
];

/** ASCII マップで使える特殊文字（タイル以外） */
export const START_CHAR = "S"; // プレイヤー開始位置（空マス扱い）

export const CHAR_TO_TILE: ReadonlyMap<string, TileEntry> = new Map(
	ACTION_TILES.map((t) => [t.char, t]),
);

// ── エンティティ（敵・NPC・仕掛け）プリセット ───────────────────────────────
// spriteRef の smc_json 参照は GameMaker がロード時に URL 解決するので ref だけでよい。
export type EntityType =
	| "goomba"
	| "koopa"
	| "boo"
	| "bobomb"
	| "drybones"
	| "toad"
	| "princess"
	| "platformH"
	| "platformV";

export interface EntityPreset {
	emoji: string;
	name: string;
	behavior: "still" | "patrolH" | "patrolV" | "chase" | "walker";
	speed: number;
	hp: number;
	hazard: boolean;
	stompable?: boolean;
	shell?: boolean;
	objType?: "npc" | "platform";
	spriteRef?: string;
	w?: number;
	h?: number;
	/** LLM 向けの一言説明 */
	hint: string;
}

export const ACTION_ENTITIES: Record<EntityType, EntityPreset> = {
	goomba: {
		emoji: "🐛",
		name: "クリボー",
		behavior: "patrolH",
		speed: 1,
		hp: 1,
		hazard: true,
		stompable: true,
		spriteRef: "walk:smc_json:Goomba",
		hint: "基本の敵。踏むと倒せる",
	},
	koopa: {
		emoji: "🐢",
		name: "ノコノコ",
		behavior: "walker",
		speed: 1.2,
		hp: 2,
		hazard: true,
		stompable: true,
		shell: true,
		spriteRef: "walk:smc_json:KoopaTroopa",
		hint: "踏むと甲羅になり、蹴ると滑走する",
	},
	boo: {
		emoji: "👻",
		name: "テレサ",
		behavior: "chase",
		speed: 0.8,
		hp: 1,
		hazard: true,
		spriteRef: "walk:smc_json:Boo",
		hint: "プレイヤーを追尾する。踏めない",
	},
	bobomb: {
		emoji: "💥",
		name: "ボム兵",
		behavior: "patrolH",
		speed: 1,
		hp: 1,
		hazard: true,
		stompable: true,
		spriteRef: "walk:smc_json:Bobomb",
		hint: "歩く爆弾。踏むと倒せる",
	},
	drybones: {
		emoji: "💀",
		name: "ホネクッパ",
		behavior: "patrolH",
		speed: 1,
		hp: 3,
		hazard: true,
		stompable: true,
		spriteRef: "walk:smc_json:DryBones",
		hint: "硬い敵（HP3）。終盤向け",
	},
	toad: {
		emoji: "🍄",
		name: "キノピオ",
		behavior: "still",
		speed: 0,
		hp: 1,
		hazard: false,
		objType: "npc",
		spriteRef: "walk:smc_json:NPC:1NPC0",
		w: 32,
		h: 64,
		hint: "話しかけられるNPC。message必須（操作説明やヒント）",
	},
	princess: {
		emoji: "👸",
		name: "ピーチ姫",
		behavior: "still",
		speed: 0,
		hp: 1,
		hazard: false,
		objType: "npc",
		spriteRef: "walk:smc_json:NPC:1NPC1",
		w: 32,
		h: 64,
		hint: "ゴールの先に置くNPC。message必須（お礼のセリフ）",
	},
	platformH: {
		emoji: "🛹",
		name: "movingPlatform",
		behavior: "patrolH",
		speed: 1,
		hp: 1,
		hazard: false,
		objType: "platform",
		hint: "左右に動くリフト（穴の上に）",
	},
	platformV: {
		emoji: "🛹",
		name: "movingPlatform",
		behavior: "patrolV",
		speed: 1.2,
		hp: 1,
		hazard: false,
		objType: "platform",
		hint: "上下に動くリフト（縦移動に）",
	},
};

export const ENTITY_TYPES = Object.keys(ACTION_ENTITIES) as EntityType[];

// ── BGM / SFX ─────────────────────────────────────────────────────────────
// 外部URLを推測しない。mml: 参照はエンジン内蔵のMMLプレイヤーで再生されるため
// 完全に自己完結する。BGM は雰囲気別の短いループを用意しておく。
export const ACTION_BGM: Record<string, string> = {
	// 明るい地上面
	overworld: "mml:t150o5l8ceg>c<geceg>c<gecfa>c<afcfa>c<afc",
	// 暗い洞窟・地下面
	underground: "mml:t120o4l8cr<a-rgrcr c r<a-rgrfr",
	// 城・緊張感
	castle: "mml:t140o4l8c<g>ce-c<g>ce- c<a->cfc<a->cf",
	none: "none",
};

export const ACTION_SFX: Record<string, string> = {
	jump: "mml:t240o5l32ceg",
	clear: "mml:t180o5l16cegb>c2",
	damage: "mml:t240o4l16ge-c",
	coin: "mml:t180o6l16b>e8", // mario プリセットと同じ定番コイン音
};

/** プレイヤーの見た目（SMC のプレイヤースプライト） */
export const PLAYER_SPRITE_REF = "walk:smc_json:PlayerSprite:1Idle0_3";
