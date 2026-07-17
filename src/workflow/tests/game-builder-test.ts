// Game Maker のビルダー・検証パイプラインの LLM 不要テスト。
// 手書きのレベルデザインが「構築できて・スキーマを通り・遊べる」こと、
// 壊れたデザインがきちんと弾かれることを確認する。

import { renderAsciiMap } from "../../game-maker/ascii-map";
import { buildActionManifest } from "../../game-maker/build-manifest";
import { lintActionManifest } from "../../game-maker/lint";
import { ActionManifestSchema, type GameConcept, LevelDesignSchema } from "../../game-maker/schema";

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

if (failed > 0) {
	console.error(`\n${failed} 件のチェックが失敗しました`);
	process.exit(1);
}
console.log("\nすべてのチェックが成功しました 🎉");
