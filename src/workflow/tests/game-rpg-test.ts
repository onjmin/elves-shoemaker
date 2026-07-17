// ウォーキングシミュレーター（rpg エンジン）ビルダー・検証パイプラインの LLM 不要テスト。

import { buildRpgManifest, renderRpgAsciiMap } from "../../game-maker/rpg/builder";
import { lintRpgManifest } from "../../game-maker/rpg/lint";
import {
	normalizeRpgLevel,
	type RpgConcept,
	RpgLevelSchema,
	RpgManifestSchema,
} from "../../game-maker/rpg/schema";

let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const concept: RpgConcept = {
	title: "しずかなゆめ",
	subtitle: "テスト用の夢",
	endingMessage: "めがさめた。まくらが ぬれていた。",
	playerEmoji: "🚶",
	mood: "dream",
};

// ── 正常系: 30×24 の散策マップ ──────────────────────────────────────────────
// 外周M囲い・水辺と橋・小部屋（扉つき）・奥に G。全行30文字。
const goodMap = [
	"MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
	"M............................M",
	"M..FFFF......................M",
	"M..FFFF...~~~~~..............M",
	"M.........~~~~~..............M",
	"M....S....~~B~~........WWWW..M",
	"M.........~~B~~........WsDW..M",
	"M.........~~~~~........WssW..M",
	"M......................WWsW..M",
	"M............................M",
	"M............................M",
	"M...WWWWWW...................M",
	"M...WssssW...................M",
	"M...WssssD...................M",
	"M...WWWWWW...................M",
	"M............................M",
	"M.................FFFF.......M",
	"M.................FFFF.......M",
	"M............................M",
	"M............................M",
	"M...........................GM",
	"M............................M",
	"M............................M",
	"MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
];

console.log("[1] 正常系");
const goodLevel = RpgLevelSchema.parse({
	asciiMap: goodMap,
	entities: [
		{ type: "npc", col: 8, row: 10, emoji: "👻", message: "ここは だれかの ゆめの なか" },
		{ type: "npc", col: 20, row: 15, emoji: "🐈", message: "……にゃあ" },
		{ type: "warp", col: 3, row: 18, toCol: 26, toRow: 2 },
	],
});
const good = buildRpgManifest(concept, goodLevel);
check("ビルドエラーなし", good.errors.length === 0, good.errors.join("; "));
check("マニフェスト生成", good.manifest !== null);
if (good.manifest) {
	const schema = RpgManifestSchema.safeParse(good.manifest);
	check(
		"Zodスキーマ通過",
		schema.success,
		schema.success ? undefined : schema.error.issues.map((i) => i.message).join("; "),
	);
	if (schema.success) {
		const lint = lintRpgManifest(schema.data);
		check("リント通過（G到達可能）", lint.errors.length === 0, lint.errors.join("; "));
		check("battleが無い（散策専用）", !("battle" in schema.data));
		console.log(renderRpgAsciiMap(schema.data.map));
	}
}

// ── 異常系1: S なし ─────────────────────────────────────────────────────────
console.log("[2] 異常系: S なし");
const noStart = buildRpgManifest(concept, {
	asciiMap: goodMap.map((r) => r.replace("S", ".")),
	entities: [],
});
check(
	"S欠落を検出",
	noStart.errors.some((e) => e.includes("開始位置")),
	noStart.errors.join("; "),
);

// ── 異常系2: G が壁に囲まれて到達不能 ───────────────────────────────────────
// G(col28,row20) を W で完全に囲む。
const isolatedRows = (base: string[]): string[] =>
	base.map((r, i) => {
		if (i === 19) return "M..........................WWM";
		if (i === 20) return "M..........................WGM";
		if (i === 21) return "M..........................WWM";
		return r;
	});

console.log("[3] 異常系: G が孤立（到達不能）");
const isolated = buildRpgManifest(concept, { asciiMap: isolatedRows(goodMap), entities: [] });
check("ビルド自体は成功", isolated.manifest !== null, isolated.errors.join("; "));
if (isolated.manifest) {
	const parsed = RpgManifestSchema.parse(isolated.manifest);
	const lint = lintRpgManifest(parsed);
	check(
		"到達不能を検出",
		lint.errors.some((e) => e.includes("到達")),
		`errors: ${lint.errors.join("; ")}`,
	);
}

// ── 自動補正: 壁の中の NPC・マップ外の warp 先 ──────────────────────────────
console.log("[4] 自動補正: 壁の中の座標・マップ外の座標");
const drifted = buildRpgManifest(concept, {
	asciiMap: goodMap,
	entities: [
		{ type: "npc", col: 0, row: 0, emoji: "👤", message: "かべのなかにいる" }, // 壁 → 移動
		{ type: "warp", col: 8, row: 10, toCol: 99, toRow: 99 }, // 先がマップ外 → クランプ+補正
	],
});
check("補正してビルド成功", drifted.manifest !== null, drifted.errors.join("; "));
check(
	"移動の警告が出る",
	drifted.warnings.some((w) => w.includes("移動")),
	drifted.warnings.join("; "),
);

// ── 正規化: 別名タイプ・未知タイプ ──────────────────────────────────────────
console.log("[5] 正規化: 別名・未知タイプ");
const aliased = normalizeRpgLevel({
	asciiMap: goodMap,
	entities: [
		{ type: "Ghost", col: 8, row: 10, message: "……" }, // 別名 → npc
		{ type: "Portal", col: 3, row: 18, toCol: 26, toRow: 2 }, // 別名 → warp
		{ type: "sword", col: 5, row: 5 }, // 未知 → 破棄
	],
});
const aliasedParsed = RpgLevelSchema.safeParse(aliased.data);
check("正規化後にZod通過", aliasedParsed.success);
if (aliasedParsed.success) {
	const types = aliasedParsed.data.entities.map((e) => e.type);
	check(
		"ghost→npc, portal→warp, sword破棄",
		types.length === 2 && types[0] === "npc" && types[1] === "warp",
		`got: ${types.join(",")}`,
	);
}

// ── ワープ経由でしか行けない場所も到達扱い ──────────────────────────────────
console.log("[6] ワープ到達性: 孤島の G へワープでつなぐ");
const bridged = buildRpgManifest(concept, {
	asciiMap: isolatedRows(goodMap),
	entities: [{ type: "warp", col: 8, row: 10, toCol: 28, toRow: 20 }],
});
if (bridged.manifest) {
	const parsed = RpgManifestSchema.parse(bridged.manifest);
	const lint = lintRpgManifest(parsed);
	check("ワープ経由でGに到達できる", lint.errors.length === 0, lint.errors.join("; "));
} else {
	check("ビルド成功", false, bridged.errors.join("; "));
}

if (failed > 0) {
	console.error(`\n${failed} 件のチェックが失敗しました`);
	process.exit(1);
}
console.log("\nすべてのチェックが成功しました 🎉");
