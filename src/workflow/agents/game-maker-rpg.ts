import "dotenv/config";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { emitDiscordWebhook } from "../../core/discord-webhook";
import { llm } from "../../core/llm-client";
import { repairPrompt } from "../../game-maker/prompts";
import {
	assembleRpgManifest,
	type BuiltWorld,
	buildRpgWorld,
	renderRpgAsciiMap,
} from "../../game-maker/rpg/builder";
import { lintRpgManifest } from "../../game-maker/rpg/lint";
import { rpgConceptPrompt, rpgWorldPrompt } from "../../game-maker/rpg/prompts";
import {
	normalizeRpgLevel,
	type RpgConcept,
	RpgConceptSchema,
	RpgManifestSchema,
	type RpgWorldDef,
	RpgWorldLevelSchema,
} from "../../game-maker/rpg/schema";
import { postGame, unjRezeBaseUrl } from "../../game-maker/submit";

/**
 * Game Maker Agent (RPG / ウォーキングシミュレーター)
 * テーマ（環境変数 GAME_THEME）から unj-reze の rpg エンジン用の
 * 「ゆめにっき系・散策ゲーム」を生成する。戦闘なし・敵なし。
 *
 * パイプライン:
 *   コンセプト（拠点＋夢世界3〜5個＋収集エフェクト）
 *   → ワールドごとにマップ+エンティティ生成（各ワールドで検証・修正ループ）
 *   → 扉でリンクしてマルチシーン・マニフェストを決定的にビルド
 *   → 全体検証 → logs/ へ保存。UNJ_REZE_SUBMIT=1 のときだけ POST /api/games へ投稿
 */

const MAX_CONCEPT_RETRY = 3;
const MAX_REPAIR = 4;

class StageError extends Error {}

async function generateConcept(theme: string): Promise<RpgConcept> {
	let lastError = "";
	for (let i = 0; i < MAX_CONCEPT_RETRY; i++) {
		const prompt =
			lastError.length > 0
				? `${rpgConceptPrompt(theme)}\n\n前回の出力は次の理由で不正でした。修正してください: ${lastError}`
				: rpgConceptPrompt(theme);
		const { data, error } = await llm.completeAsJson(prompt);
		if (!data) {
			lastError = error ?? "JSONが見つかりません";
			continue;
		}
		const parsed = RpgConceptSchema.safeParse(data);
		if (parsed.success) return parsed.data;
		lastError = parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
		console.log(`  ⚠ コンセプト検証NG (${i + 1}/${MAX_CONCEPT_RETRY}): ${lastError}`);
	}
	throw new StageError(`コンセプト生成に失敗しました: ${lastError}`);
}

async function generateWorld(
	concept: RpgConcept,
	worldDef: RpgWorldDef,
): Promise<{ world: BuiltWorld; warnings: string[] }> {
	const basePrompt = rpgWorldPrompt(concept, worldDef);
	let prompt = basePrompt;
	let lastJson = "";
	for (let i = 0; i < MAX_REPAIR; i++) {
		const { data, error } = await llm.completeAsJson(prompt);
		const errors: string[] = [];
		const warnings: string[] = [];
		let world: BuiltWorld | null = null;

		if (!data) {
			errors.push(error ?? "JSONが見つかりません");
		} else {
			lastJson = JSON.stringify(data);
			const normalized = normalizeRpgLevel(data);
			warnings.push(...normalized.warnings);
			const level = RpgWorldLevelSchema.safeParse(normalized.data);
			if (!level.success) {
				errors.push(
					...level.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 10),
				);
			} else {
				const built = buildRpgWorld(concept, worldDef, level.data);
				errors.push(...built.errors);
				warnings.push(...built.warnings);
				world = built.world;
			}
		}

		if (world && errors.length === 0) {
			return { world, warnings };
		}
		console.log(`  ⚠ ワールド '${worldDef.id}' 検証NG (${i + 1}/${MAX_REPAIR}):`);
		for (const e of errors) console.log(`    - ${e}`);
		// 診断用：モデルが実際に出したマップを表示する
		const rawRows = (data as { asciiMap?: unknown } | null)?.asciiMap;
		if (Array.isArray(rawRows)) {
			console.log("    受信したマップ:");
			for (const l of rawRows.slice(0, 24)) console.log(`    | ${String(l).slice(0, 40)}`);
		}
		prompt = repairPrompt(basePrompt, lastJson || "(JSONの抽出に失敗)", errors);
	}
	throw new StageError(`ワールド '${worldDef.id}' の生成に失敗しました（修正リトライ上限に到達）`);
}

export async function run() {
	const theme = process.env.GAME_THEME || "しずかな夢の世界の散策";
	const shouldSubmit = process.env.UNJ_REZE_SUBMIT === "1";

	console.log("--- Game Maker Agent (ウォーキングシミュレーター) 起動 ---");
	console.log(`テーマ: ${theme}`);
	await emitDiscordWebhook(
		`# 🌙 Game Maker (RPG散策) 開始\n\nテーマ「${theme}」で夢の世界の生成を開始しました。`,
	);

	try {
		console.log("[1/4] コンセプト生成中...");
		const concept = await generateConcept(theme);
		console.log(`  ✓ 「${concept.title}」`);
		console.log(`    ワールド: ${concept.worlds.map((w) => `${w.name}(${w.mood})`).join(" → ")}`);
		if (concept.effects.length > 0) {
			console.log(
				`    エフェクト: ${concept.effects.map((e) => `${e.emoji}${e.name}@${e.worldId}`).join(", ")}`,
			);
		}

		console.log(`[2/4] ワールド生成中... (${concept.worlds.length}個)`);
		const allWarnings: string[] = [];
		const worlds: BuiltWorld[] = [];
		for (const [i, worldDef] of concept.worlds.entries()) {
			console.log(`  (${i + 1}/${concept.worlds.length}) 「${worldDef.name}」...`);
			const { world, warnings } = await generateWorld(concept, worldDef);
			worlds.push(world);
			allWarnings.push(...warnings.map((w) => `[${worldDef.id}] ${w}`));
			console.log(`    ✓ 歩けるマス: ${world.walkable.size} / 扉: ${world.doors.length}`);
		}

		console.log("[3/4] リンク・全体検証中...");
		const assembled = assembleRpgManifest(concept, worlds);
		if (!assembled.manifest) {
			throw new StageError(`マニフェスト組み立てに失敗しました: ${assembled.errors.join("; ")}`);
		}
		allWarnings.push(...assembled.warnings);
		const schema = RpgManifestSchema.safeParse(assembled.manifest);
		if (!schema.success) {
			throw new StageError(
				`マニフェスト検証に失敗しました: ${schema.error.issues
					.map((e) => `${e.path.join(".")}: ${e.message}`)
					.slice(0, 10)
					.join("; ")}`,
			);
		}
		const manifest = schema.data;
		const lint = lintRpgManifest(manifest);
		allWarnings.push(...lint.warnings);
		if (lint.errors.length > 0) {
			throw new StageError(`全体検証に失敗しました: ${lint.errors.join("; ")}`);
		}
		console.log("  ✓ 検証OK");
		for (const w of allWarnings) console.log(`    ⚠ ${w}`);
		for (const sc of manifest.scenes) {
			console.log(`  ── ${sc.id}${sc.name ? `（${sc.name}）` : ""} ──`);
			console.log(renderRpgAsciiMap(sc.map));
		}

		console.log("[4/4] 保存・投稿...");
		const logDir = resolve(process.cwd(), "logs");
		await fs.mkdir(logDir, { recursive: true });
		const logPath = resolve(logDir, `game-rpg-${Date.now()}.json`);
		await fs.writeFile(
			logPath,
			JSON.stringify({ title: concept.title, manifest }, null, 2),
			"utf-8",
		);
		console.log(`  ✓ 保存: ${logPath}`);

		if (shouldSubmit) {
			const game = await postGame({
				preset: "dq",
				title: concept.title,
				manifest,
				creatorSlug: process.env.UNJ_REZE_CREATOR_SLUG || undefined,
			});
			console.log(`  ✓ 投稿完了: ${unjRezeBaseUrl()} (id: ${game.id})`);
			await emitDiscordWebhook(
				`# ✅ Game Maker (RPG散策) 完了\n\n「${concept.title}」（${concept.worlds.length}ワールド）を投稿しました (id: ${game.id})`,
			);
		} else {
			console.log("  ✓ ドライラン（UNJ_REZE_SUBMIT=1 で実投稿）");
			await emitDiscordWebhook(
				`# ✅ Game Maker (RPG散策) 完了（ドライラン）\n\n「${concept.title}」（${concept.worlds.length}ワールド）を生成し ${logPath} に保存しました。`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`✗ 失敗: ${message}`);
		await emitDiscordWebhook(`# ❌ Game Maker (RPG散策) 失敗\n\n${message}`);
		throw err;
	}
}
