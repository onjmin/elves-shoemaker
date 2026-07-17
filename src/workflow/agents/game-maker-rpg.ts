import "dotenv/config";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { emitDiscordWebhook } from "../../core/discord-webhook";
import { llm } from "../../core/llm-client";
import { repairPrompt } from "../../game-maker/prompts";
import { buildRpgManifest, renderRpgAsciiMap } from "../../game-maker/rpg/builder";
import { lintRpgManifest } from "../../game-maker/rpg/lint";
import { rpgConceptPrompt, rpgLevelPrompt } from "../../game-maker/rpg/prompts";
import {
	normalizeRpgLevel,
	type RpgConcept,
	RpgConceptSchema,
	RpgLevelSchema,
	type RpgManifest,
	RpgManifestSchema,
} from "../../game-maker/rpg/schema";
import { postGame, unjRezeBaseUrl } from "../../game-maker/submit";

/**
 * Game Maker Agent (RPG / ウォーキングシミュレーター)
 * テーマ（環境変数 GAME_THEME）から unj-reze の rpg エンジン用の
 * 「ゆめにっき系・散策ゲーム」を生成する。戦闘なし・敵なし。
 *
 * パイプラインは action 版と同じ:
 *   コンセプト → マップ+エンティティ → 決定的ビルド → 検証 → 修正ループ
 *   → logs/ へ保存。UNJ_REZE_SUBMIT=1 のときだけ POST /api/games へ投稿
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

async function generateLevel(
	concept: RpgConcept,
): Promise<{ manifest: RpgManifest; warnings: string[] }> {
	const basePrompt = rpgLevelPrompt(concept);
	let prompt = basePrompt;
	let lastJson = "";
	for (let i = 0; i < MAX_REPAIR; i++) {
		const { data, error } = await llm.completeAsJson(prompt);
		const errors: string[] = [];
		const warnings: string[] = [];
		let manifest: RpgManifest | null = null;

		if (!data) {
			errors.push(error ?? "JSONが見つかりません");
		} else {
			lastJson = JSON.stringify(data);
			const normalized = normalizeRpgLevel(data);
			warnings.push(...normalized.warnings);
			const level = RpgLevelSchema.safeParse(normalized.data);
			if (!level.success) {
				errors.push(
					...level.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 10),
				);
			} else {
				const built = buildRpgManifest(concept, level.data);
				errors.push(...built.errors);
				warnings.push(...built.warnings);
				if (built.manifest) {
					const schema = RpgManifestSchema.safeParse(built.manifest);
					if (!schema.success) {
						errors.push(
							...schema.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 10),
						);
					} else {
						manifest = schema.data;
						const lint = lintRpgManifest(manifest);
						errors.push(...lint.errors);
						warnings.push(...lint.warnings);
					}
				}
			}
		}

		if (manifest && errors.length === 0) {
			return { manifest, warnings };
		}
		console.log(`  ⚠ マップ検証NG (${i + 1}/${MAX_REPAIR}):`);
		for (const e of errors) console.log(`    - ${e}`);
		// 診断用：モデルが実際に出したマップを表示する
		const rawRows = (data as { asciiMap?: unknown } | null)?.asciiMap;
		if (Array.isArray(rawRows)) {
			console.log("    受信したマップ:");
			for (const l of rawRows.slice(0, 24)) console.log(`    | ${String(l).slice(0, 40)}`);
		}
		prompt = repairPrompt(basePrompt, lastJson || "(JSONの抽出に失敗)", errors);
	}
	throw new StageError("マップの生成に失敗しました（修正リトライ上限に到達）");
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
		console.log("[1/3] コンセプト生成中...");
		const concept = await generateConcept(theme);
		console.log(`  ✓ 「${concept.title}」(${concept.mood})`);

		console.log("[2/3] マップ生成中...");
		const { manifest, warnings } = await generateLevel(concept);
		console.log("  ✓ 検証OK");
		for (const w of warnings) console.log(`    ⚠ ${w}`);
		console.log(renderRpgAsciiMap(manifest.map));

		console.log("[3/3] 保存・投稿...");
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
				`# ✅ Game Maker (RPG散策) 完了\n\n「${concept.title}」を投稿しました (id: ${game.id})`,
			);
		} else {
			console.log("  ✓ ドライラン（UNJ_REZE_SUBMIT=1 で実投稿）");
			await emitDiscordWebhook(
				`# ✅ Game Maker (RPG散策) 完了（ドライラン）\n\n「${concept.title}」を生成し ${logPath} に保存しました。`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`✗ 失敗: ${message}`);
		await emitDiscordWebhook(`# ❌ Game Maker (RPG散策) 失敗\n\n${message}`);
		throw err;
	}
}
