// ウォーキングシミュレーター（rpg エンジン・マルチシーン版）ビルダー・検証パイプラインの
// LLM 不要テスト。拠点＋夢世界＋扉リンク＋会話イベント＋収集エフェクトを検証する。

import {
	assembleRpgManifest,
	type BuiltWorld,
	buildRpgWorld,
	compileDialogue,
	renderRpgAsciiMap,
} from "../../game-maker/rpg/builder";
import { lintRpgManifest } from "../../game-maker/rpg/lint";
import {
	normalizeRpgLevel,
	type RpgConcept,
	RpgConceptSchema,
	RpgManifestSchema,
	RpgWorldLevelSchema,
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

// ── テスト用コンセプト：拠点＋森＋最深部、エフェクト1つ ─────────────────────
const concept: RpgConcept = RpgConceptSchema.parse({
	title: "しずかなゆめ",
	subtitle: "テスト用の夢",
	endingMessage: "めがさめた。まくらが ぬれていた。",
	playerEmoji: "🚶",
	worlds: [
		{ id: "nexus", name: "とびらの間", mood: "dream", theme: "白い扉がならぶ静かな部屋" },
		{ id: "forest", name: "しずかな森", mood: "forest", theme: "霧のなかの森" },
		{ id: "deep", name: "ふかい場所", mood: "ruins", theme: "夢のいちばん奥" },
	],
	effects: [{ id: "lantern", name: "ランタン", emoji: "🏮", worldId: "forest" }],
	endingWorldId: "deep",
});

// ── マップ生成ヘルパー：外周M・内側草原の 30×24 に文字を置く ─────────────────
const blankGrid = (): string[][] =>
	Array.from({ length: 24 }, (_, r) =>
		Array.from({ length: 30 }, (_, c) => (r === 0 || r === 23 || c === 0 || c === 29 ? "M" : ".")),
	);
const rowsOf = (g: string[][]): string[] => g.map((r) => r.join(""));

const nexusGrid = blankGrid();
nexusGrid[5][5] = "S";
const nexusMap = rowsOf(nexusGrid);

const forestGrid = blankGrid();
const forestMap = rowsOf(forestGrid);

const deepGrid = blankGrid();
deepGrid[20][25] = "G";
const deepMap = rowsOf(deepGrid);

const dialogue = {
	onceLines: ["……はじめて みる かお。"],
	lines: ["まだ いたの？"],
	choice: {
		prompt: "かえりみちを きく？",
		options: [
			{ label: "きく", lines: ["とびらは うしろに ある。"] },
			{ label: "だまる", lines: ["……そう。"] },
		],
	},
	ifEffect: { effectId: "lantern", lines: ["その あかり…… どこで ひろったの。"] },
};

const nexusLevel = RpgWorldLevelSchema.parse({
	asciiMap: nexusMap,
	entities: [
		{ type: "door", col: 10, row: 5, emoji: "🚪", toWorld: "forest" },
		{ type: "door", col: 15, row: 5, emoji: "⛩️", toWorld: "deep" },
		{ type: "npc", col: 8, row: 10, emoji: "👻", message: "ここは だれかの ゆめの なか" },
	],
});
const forestLevel = RpgWorldLevelSchema.parse({
	asciiMap: forestMap,
	entities: [
		{ type: "door", col: 5, row: 5, toWorld: "nexus" },
		{ type: "effect", col: 20, row: 10, effectId: "lantern", message: "つめたい ひかりだ。" },
		{ type: "npc", col: 8, row: 8, emoji: "👧", dialogue },
		{ type: "warp", col: 3, row: 18, toCol: 26, toRow: 2 },
	],
});
const deepLevel = RpgWorldLevelSchema.parse({
	asciiMap: deepMap,
	entities: [
		{ type: "door", col: 5, row: 5, toWorld: "nexus" },
		{ type: "npc", col: 20, row: 15, emoji: "🐈", message: "……にゃあ" },
	],
});

console.log("[1] 正常系: 3ワールドのビルドとリンク");
const worlds: BuiltWorld[] = [];
for (const [def, level] of [
	[concept.worlds[0], nexusLevel],
	[concept.worlds[1], forestLevel],
	[concept.worlds[2], deepLevel],
] as const) {
	const built = buildRpgWorld(concept, def, level);
	check(`'${def.id}' ビルドエラーなし`, built.errors.length === 0, built.errors.join("; "));
	if (built.world) worlds.push(built.world);
}
const assembled = assembleRpgManifest(concept, worlds);
check("マニフェスト生成", assembled.manifest !== null, assembled.errors.join("; "));
if (assembled.manifest) {
	const schema = RpgManifestSchema.safeParse(assembled.manifest);
	check(
		"Zodスキーマ通過",
		schema.success,
		schema.success ? undefined : schema.error.issues.map((i) => i.message).join("; "),
	);
	if (schema.success) {
		const m = schema.data;
		const lint = lintRpgManifest(m);
		check("リント通過（G到達可能）", lint.errors.length === 0, lint.errors.join("; "));
		check("battleが無い（散策専用）", !("battle" in m));
		check("シーンが3つ", m.scenes.length === 3);
		check(
			"エフェクトが items に入る",
			(m.items ?? []).some((i) => i.id === "lantern"),
		);
		const forestScene = m.scenes.find((s) => s.id === "forest");
		const doorBack = forestScene?.objects.find(
			(o) => (o as { warpSceneId?: string }).warpSceneId === "nexus",
		) as { warpEntryCol?: number; warpEntryRow?: number } | undefined;
		check("森→拠点の扉オブジェクトがある", doorBack !== undefined);
		// toCol/toRow 省略時：拠点側の「森ゆき扉 (10,5)」のそばに出る
		const near =
			doorBack !== undefined &&
			Math.abs((doorBack.warpEntryCol ?? 99) - 10) <= 2 &&
			Math.abs((doorBack.warpEntryRow ?? 99) - 5) <= 2;
		check("扉の出現座標が相手側の扉のそば", near, JSON.stringify(doorBack));
		const evNpc = forestScene?.objects.find((o) => (o as { emoji: string }).emoji === "👧") as
			| { pages?: { name?: string }[] }
			| undefined;
		check(
			"会話イベントNPCにページがある（反応→はじめて→ふだん）",
			evNpc?.pages?.length === 3 &&
				evNpc.pages[0].name === "エフェクト反応" &&
				evNpc.pages[2].name === "ふだん",
			JSON.stringify(evNpc?.pages?.map((p) => p.name)),
		);
		console.log(renderRpgAsciiMap(m.scenes[0].map));
	}
}

console.log("[2] 会話DSLコンパイル");
const pages = compileDialogue(dialogue);
const lastCmds = pages[pages.length - 1].commands;
check("choice が ふだんページ末尾に付く", lastCmds[lastCmds.length - 1].type === "choice");
check(
	"onceLines がセルフスイッチで1回きり",
	pages[1].commands.some((c) => c.type === "setSelfSwitch"),
);

console.log("[3] 異常系: 拠点に S なし");
const noStart = buildRpgWorld(concept, concept.worlds[0], {
	asciiMap: nexusMap.map((r) => r.replace("S", ".")),
	entities: nexusLevel.entities,
});
check(
	"S欠落を検出",
	noStart.errors.some((e) => e.includes("開始位置")),
	noStart.errors.join("; "),
);

console.log("[4] 異常系: 拠点の扉が足りない");
const missingDoor = buildRpgWorld(concept, concept.worlds[0], {
	asciiMap: nexusMap,
	entities: nexusLevel.entities.filter((e) => (e as { toWorld?: string }).toWorld !== "deep"),
});
check(
	"deep への扉不足を検出",
	missingDoor.errors.some((e) => e.includes("deep")),
	missingDoor.errors.join("; "),
);

console.log("[5] 異常系: 帰り道の扉なし・G の重複");
const noReturn = buildRpgWorld(concept, concept.worlds[1], {
	asciiMap: forestMap,
	entities: forestLevel.entities.filter((e) => e.type !== "door"),
});
check(
	"拠点へ戻る扉の欠落を検出",
	noReturn.errors.some((e) => e.includes("戻る扉")),
	noReturn.errors.join("; "),
);
const goalInForest = buildRpgWorld(concept, concept.worlds[1], {
	asciiMap: forestMap.map((r, i) => (i === 12 ? `${r.slice(0, 14)}G${r.slice(15)}` : r)),
	entities: forestLevel.entities,
});
check(
	"エンディング以外の G は警告つきで草原化",
	goalInForest.errors.length === 0 && goalInForest.warnings.some((w) => w.includes("専用")),
	[...goalInForest.errors, ...goalInForest.warnings].join("; "),
);

console.log("[6] 異常系: G が孤立（到達不能）");
const isolatedDeep = deepMap.map((r, i) => {
	if (i === 19) return `${r.slice(0, 24)}WWW${r.slice(27)}`;
	if (i === 20) return `${r.slice(0, 24)}WGW${r.slice(27)}`;
	if (i === 21) return `${r.slice(0, 24)}WWW${r.slice(27)}`;
	return r;
});
const isolated = buildRpgWorld(concept, concept.worlds[2], {
	asciiMap: isolatedDeep,
	entities: deepLevel.entities,
});
check(
	"到達不能を検出",
	isolated.errors.some((e) => e.includes("到達")),
	isolated.errors.join("; "),
);

console.log("[7] 異常系: warp の飛び先が袋小路");
const pocketGrid = blankGrid();
pocketGrid[5][5] = "S";
for (const [c, r] of [
	[24, 19],
	[25, 19],
	[26, 19],
	[24, 20],
	[26, 20],
	[24, 21],
	[25, 21],
	[26, 21],
]) {
	pocketGrid[r][c] = "W";
}
const pocket = buildRpgWorld(concept, concept.worlds[0], {
	asciiMap: rowsOf(pocketGrid),
	entities: [...nexusLevel.entities, { type: "warp", col: 8, row: 8, toCol: 25, toRow: 20 }],
});
check(
	"袋小路ワープを検出",
	pocket.errors.some((e) => e.includes("詰み")),
	pocket.errors.join("; "),
);

console.log("[8] 異常系: 会話NPCが1マス幅の通路をふさぐ");
const corridorGrid = blankGrid();
corridorGrid[5][5] = "S";
for (let c = 20; c <= 28; c++) {
	corridorGrid[11][c] = "W";
	corridorGrid[13][c] = "W";
}
const plugged = buildRpgWorld(concept, concept.worlds[0], {
	asciiMap: rowsOf(corridorGrid),
	entities: [
		{ type: "door", col: 10, row: 5, toWorld: "forest" },
		{ type: "door", col: 27, row: 12, toWorld: "deep" }, // 通路の奥
		{ type: "npc", col: 23, row: 12, emoji: "👧", dialogue }, // 通路の栓
	],
});
check(
	"通路の栓を検出",
	plugged.errors.some((e) => e.includes("ふさいで")),
	plugged.errors.join("; "),
);

console.log("[9] 自動補正: 壁の中の座標・マップ外の座標");
const drifted = buildRpgWorld(concept, concept.worlds[0], {
	asciiMap: nexusMap,
	entities: [
		...nexusLevel.entities,
		{ type: "npc", col: 0, row: 0, emoji: "👤", message: "かべのなかにいる" },
		{ type: "warp", col: 12, row: 12, toCol: 99, toRow: 99 },
	],
});
check("補正してビルド成功", drifted.world !== null, drifted.errors.join("; "));
check(
	"移動の警告が出る",
	drifted.warnings.some((w) => w.includes("移動")),
	drifted.warnings.join("; "),
);

console.log("[10] 正規化: 別名・未知タイプ");
const aliased = normalizeRpgLevel({
	asciiMap: forestMap,
	entities: [
		{ type: "Ghost", col: 8, row: 10, message: "……" }, // 別名 → npc
		{ type: "Gate", col: 5, row: 5, toWorld: "nexus" }, // 別名 → door
		{ type: "Item", col: 20, row: 10, effectId: "lantern" }, // 別名 → effect
		{ type: "sword", col: 5, row: 5 }, // 未知 → 破棄
	],
});
const aliasedParsed = RpgWorldLevelSchema.safeParse(aliased.data);
check("正規化後にZod通過", aliasedParsed.success);
if (aliasedParsed.success) {
	const types = aliasedParsed.data.entities.map((e) => e.type);
	check(
		"ghost→npc, gate→door, item→effect, sword破棄",
		types.length === 3 && types[0] === "npc" && types[1] === "door" && types[2] === "effect",
		`got: ${types.join(",")}`,
	);
}

if (failed > 0) {
	console.error(`\n${failed} 件のチェックが失敗しました`);
	process.exit(1);
}
console.log("\nすべてのチェックが成功しました 🎉");
