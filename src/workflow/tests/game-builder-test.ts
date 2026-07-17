// Game Maker のビルダー・検証パイプラインの LLM 不要テスト。
// 手書きのレベルデザインが「構築できて・スキーマを通り・遊べる」こと、
// 壊れたデザインがきちんと弾かれることを確認する。

import { renderAsciiMap } from "../../game-maker/ascii-map";
import { buildActionManifest } from "../../game-maker/build-manifest";
import { lintActionManifest } from "../../game-maker/lint";
import {
	ActionManifestSchema,
	type GameConcept,
	LevelDesignSchema,
	normalizeLevelDesign,
} from "../../game-maker/schema";

let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const concept: GameConcept = {
	title: "テストの冒険",
	subtitle: "ビルダー検証用",
	endingMessage: "クリアおめでとう！",
	playerEmoji: "🦝",
	worldCols: 40,
	mood: "overworld",
};

// ── 正常系: 遊べる40列のステージ ────────────────────────────────────────────
// 地面2行、小さな穴（幅2）、階段、浮きブロック、ゴール旗。
const goodMap = [
	"........................................",
	"........................................",
	"........................................",
	"........................................",
	"........................................",
	"..........ooo...........................",
	".........#?#.............#..............",
	".........................#..............",
	"....o...................##..............",
	"...###..................##..............",
	"........................................",
	"........................................",
	"..S...........C......................G..",
	"========..==============================",
	"========..==============================",
];

const goodLevel = LevelDesignSchema.parse({
	asciiMap: goodMap,
	entities: [
		{ type: "toad", col: 5, row: 12, message: "ようこそ！右へ進もう！" },
		{ type: "goomba", col: 20, row: 12 },
		{ type: "koopa", col: 30, row: 12 },
		{ type: "platformH", col: 9, row: 11 },
		{ type: "princess", col: 39, row: 12, message: "ありがとう！" },
	],
});

console.log("[1] 正常系");
const good = buildActionManifest(concept, goodLevel);
check("ビルドエラーなし", good.errors.length === 0, good.errors.join("; "));
check("マニフェスト生成", good.manifest !== null);
if (good.manifest) {
	const schema = ActionManifestSchema.safeParse(good.manifest);
	check(
		"Zodスキーマ通過",
		schema.success,
		schema.success ? undefined : schema.error.issues.map((i) => i.message).join("; "),
	);
	const lint = lintActionManifest(good.manifest);
	check("リント通過（ゴール到達可能）", lint.errors.length === 0, lint.errors.join("; "));
	check("scroll.worldCols=40", good.manifest.scroll?.worldCols === 40);
	check(
		"開始位置px計算",
		good.manifest.player.start.x === 2 * 32 && good.manifest.player.start.y === 11 * 32,
		`got (${good.manifest.player.start.x}, ${good.manifest.player.start.y})`,
	);
	check("NPC2体+敵2体+リフト1", good.manifest.objects.length === 5);
	console.log(renderAsciiMap(good.manifest.map));
}

// ── 異常系1: ゴールなし ─────────────────────────────────────────────────────
console.log("[2] 異常系: ゴールなし");
const noGoal = buildActionManifest(concept, {
	asciiMap: goodMap.map((r) => r.replace("G", ".")),
	entities: [],
});
check(
	"ゴール欠落を検出",
	noGoal.errors.some((e) => e.includes("ゴール")),
	noGoal.errors.join("; "),
);

// ── 異常系2: 到達不能（越えられない穴） ─────────────────────────────────────
console.log("[3] 異常系: 幅8マスの穴（到達不能）");
const wideGapMap = goodMap.map((row, r) =>
	r >= 13 ? `${row.slice(0, 16)}........${row.slice(24)}` : row,
);
const wideGap = buildActionManifest(concept, { asciiMap: wideGapMap, entities: [] });
check("ビルド自体は成功", wideGap.manifest !== null, wideGap.errors.join("; "));
if (wideGap.manifest) {
	const lint = lintActionManifest(wideGap.manifest);
	check(
		"到達不能を検出",
		lint.errors.some((e) => e.includes("到達")),
		`errors: ${lint.errors.join("; ")}`,
	);
}

// ── 異常系3: NPC のセリフ欠落 ───────────────────────────────────────────────
console.log("[4] 異常系: message なしのNPC");
const noMsg = buildActionManifest(concept, {
	asciiMap: goodMap,
	entities: [{ type: "toad", col: 5, row: 12 }],
});
check(
	"message必須を検出",
	noMsg.errors.some((e) => e.includes("message")),
	noMsg.errors.join("; "),
);

// ── 異常系4: 行の長さ不揃いは警告つきで吸収 ─────────────────────────────────
console.log("[5] 正規化: 短い行の右埋め");
const ragged = buildActionManifest(concept, {
	asciiMap: goodMap.map((r, i) => (i === 13 ? r.slice(0, 30) : r)),
	entities: [],
});
check("吸収してビルド成功", ragged.manifest !== null, ragged.errors.join("; "));
check(
	"警告が出る",
	ragged.warnings.some((w) => w.includes("右埋め")),
	ragged.warnings.join("; "),
);

// ── 正規化: エンティティ別名の吸収と未知タイプの破棄 ────────────────────────
console.log("[6] 正規化: エンティティタイプの別名・未知タイプ");
const aliased = normalizeLevelDesign({
	asciiMap: goodMap,
	entities: [
		{ type: "Dragon", col: 30, row: 12 }, // 別名（大文字混じり）→ drybones
		{ type: "enemy", col: 20, row: 12 }, // 別名 → goomba
		{ type: "coin", col: 10, row: 12 }, // 未知 → 破棄
		{ type: "goomba", col: 15, row: 12 }, // 正式タイプはそのまま
	],
});
const aliasedParsed = LevelDesignSchema.safeParse(aliased.data);
check("正規化後にZod通過", aliasedParsed.success);
if (aliasedParsed.success) {
	const types = aliasedParsed.data.entities.map((e) => e.type);
	check(
		"dragon→drybones, enemy→goomba, coin破棄",
		types.length === 3 && types[0] === "drybones" && types[1] === "goomba" && types[2] === "goomba",
		`got: ${types.join(",")}`,
	);
	check("警告が3件出る", aliased.warnings.length === 3, aliased.warnings.join("; "));
}

// ── 自動補正: 浮いたS・マップ外エンティティ・幅不足 ─────────────────────────
console.log("[7] 自動補正: 浮いたS・マップ外エンティティ・幅不足の行");
const driftMap = [
	...goodMap.slice(0, 12),
	// S を穴（cols 8-9）の真上に置く（下に地面が無い）
	"........S.....C......................G..",
	...goodMap.slice(13).map((r) => r.slice(0, 30)), // 地面の行を30文字に切り詰め（幅不足）
];
const drift = buildActionManifest(concept, {
	asciiMap: driftMap,
	entities: [
		{ type: "princess", col: 55, row: 12, message: "ありがとう！" }, // col 55 > 39 → クランプ
	],
});
check("補正してビルド成功", drift.manifest !== null, drift.errors.join("; "));
if (drift.manifest) {
	check(
		"S を隣の立てるマスへ移動 (col 7)",
		drift.manifest.player.start.x === 7 * 32,
		`start.x=${drift.manifest.player.start.x}`,
	);
	check(
		"princess を col 39 へクランプ",
		drift.manifest.objects[0]?.col === 39,
		`col=${drift.manifest.objects[0]?.col}`,
	);
	check(
		"移動の警告が2件以上",
		drift.warnings.filter((w) => w.includes("移動")).length >= 2,
		drift.warnings.join("; "),
	);
}

// ── 自動補正: 地面が1つも無いマップ ─────────────────────────────────────────
console.log("[8] 自動補正: 地面ゼロのマップに床を敷く");
const groundless = buildActionManifest(concept, {
	asciiMap: [
		...Array.from({ length: 12 }, () => ".".repeat(40)),
		"..S..................................G..",
		".".repeat(40),
		".".repeat(40),
	],
	entities: [],
});
check("地面を敷いてビルド成功", groundless.manifest !== null, groundless.errors.join("; "));
if (groundless.manifest) {
	check(
		"地面生成の警告が出る",
		groundless.warnings.some((w) => w.includes("地面")),
		groundless.warnings.join("; "),
	);
	const lint = lintActionManifest(groundless.manifest);
	check("補正後はリント通過（ゴール到達可能）", lint.errors.length === 0, lint.errors.join("; "));
}

if (failed > 0) {
	console.error(`\n${failed} 件のチェックが失敗しました`);
	process.exit(1);
}
console.log("\nすべてのチェックが成功しました 🎉");
