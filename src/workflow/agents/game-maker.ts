import "dotenv/config";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { emitDiscordWebhook } from "../../core/discord-webhook";
import { llm } from "../../core/llm-client";
import { renderAsciiMap } from "../../game-maker/ascii-map";
import { buildActionManifest } from "../../game-maker/build-manifest";
import { lintActionManifest } from "../../game-maker/lint";
import { conceptPrompt, levelPrompt, repairPrompt } from "../../game-maker/prompts";
import {
	type ActionManifest,
	ActionManifestSchema,
	type GameConcept,
	GameConceptSchema,
	LevelDesignSchema,
} from "../../game-maker/schema";
import { postGame, unjRezeBaseUrl } from "../../game-maker/submit";

/**
 * Game Maker Agent
 * テーマ（環境変数 GAME_THEME）から unj-reze の action エンジン用ゲームを生成する。
 *
 * パイプライン:
 *   1. コンセプト生成（タイトル・雰囲気・横幅）
 *   2. レベルデザイン生成（ASCIIマップ＋エンティティ）→ 決定的ビルド → 検証
 *      検証エラーは修正プロンプトとして LLM に戻す（最大 MAX_REPAIR 回）
 *   3. logs/ へ保存。UNJ_REZE_SUBMIT=1 のときだけ POST /api/games へ投稿
 */

const MAX_CONCEPT_RETRY = 3;
const MAX_REPAIR = 4;

class StageError extends Error {}

async function generateConcept(theme: string): Promise<GameConcept> {
	let lastError = "";
	for (let i = 0; i < MAX_CONCEPT_RETRY; i++) {
		const prompt =
			lastError.length > 0
				? `${conceptPrompt(theme)}\n\n前回の出力は次の理由で不正でした。修正してください: ${lastError}`
				: conceptPrompt(theme);
		const { data, error } = await llm.completeAsJson(prompt);
		if (!data) {
			lastError = error ?? "JSONが見つかりません";
			continue;
		}
		const parsed = GameConceptSchema.safeParse(data);
		if (parsed.success) return parsed.data;
		lastError = parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
		console.log(`  ⚠ コンセプト検証NG (${i + 1}/${MAX_CONCEPT_RETRY}): ${lastError}`);
	}
	throw new StageError(`コンセプト生成に失敗しました: ${lastError}`);
}

async function generateLevel(
	concept: GameConcept,
): Promise<{ manifest: ActionManifest; warnings: string[] }> {
	let prompt = levelPrompt(concept);
	let lastJson = "";
	for (let i = 0; i < MAX_REPAIR; i++) {
		const { data, error } = await llm.completeAsJson(prompt);
		const errors: string[] = [];
		let warnings: string[] = [];
		let manifest: ActionManifest | null = null;

		if (!data) {
			errors.push(error ?? "JSONが見つかりません");
		} else {
			lastJson = JSON.stringify(data);
			const level = LevelDesignSchema.safeParse(data);
			if (!level.success) {
				errors.push(
					...level.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 10),
				);
			} else {
				const built = buildActionManifest(concept, level.data);
				errors.push(...built.errors);
				warnings = built.warnings;
				if (built.manifest) {
					const schema = ActionManifestSchema.safeParse(built.manifest);
					if (!schema.success) {
						errors.push(
							...schema.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 10),
						);
					} else {
						manifest = schema.data;
						const lint = lintActionManifest(manifest);
						errors.push(...lint.errors);
						warnings.push(...lint.warnings);
					}
				}
			}
		}

		if (manifest && errors.length === 0) {
			return { manifest, warnings };
		}
		console.log(`  ⚠ レベル検証NG (${i + 1}/${MAX_REPAIR}):`);
		for (const e of errors) console.log(`    - ${e}`);
		prompt = repairPrompt(lastJson || "(JSONの抽出に失敗)", errors);
	}
	throw new StageError("レベルデザインの生成に失敗しました（修正リトライ上限に到達）");
}

export async function run() {
	const theme = process.env.GAME_THEME ?? "王道の横スクロールアクション";
	const shouldSubmit = process.env.UNJ_REZE_SUBMIT === "1";

	console.log("--- Game Maker Agent 起動 ---");
	console.log(`テーマ: ${theme}`);
	await emitDiscordWebhook(
		`# 🎮 Game Maker 開始\n\nテーマ「${theme}」でゲーム生成を開始しました。`,
	);

	try {
		// 1. コンセプト
		console.log("[1/3] コンセプト生成中...");
		const concept = await generateConcept(theme);
		console.log(`  ✓ 「${concept.title}」(横幅${concept.worldCols} / ${concept.mood})`);

		// 2. レベルデザイン（生成→検証→修正ループ）
		console.log("[2/3] レベルデザイン生成中...");
		const { manifest, warnings } = await generateLevel(concept);
		console.log("  ✓ 検証OK");
		for (const w of warnings) console.log(`    ⚠ ${w}`);
		console.log(renderAsciiMap(manifest.map));

		// 3. 保存と投稿
		console.log("[3/3] 保存・投稿...");
		const logDir = resolve(process.cwd(), "logs");
		await fs.mkdir(logDir, { recursive: true });
		const logPath = resolve(logDir, `game-${Date.now()}.json`);
		await fs.writeFile(
			logPath,
			JSON.stringify({ title: concept.title, manifest }, null, 2),
			"utf-8",
		);
		console.log(`  ✓ 保存: ${logPath}`);

		if (shouldSubmit) {
			const game = await postGame({
				preset: manifest.preset,
				title: concept.title,
				manifest,
				creatorSlug: process.env.UNJ_REZE_CREATOR_SLUG || undefined,
			});
			console.log(`  ✓ 投稿完了: ${unjRezeBaseUrl()} (id: ${game.id})`);
			await emitDiscordWebhook(
				`# ✅ Game Maker 完了\n\n「${concept.title}」を投稿しました (id: ${game.id})`,
			);
		} else {
			console.log("  ✓ ドライラン（UNJ_REZE_SUBMIT=1 で実投稿）");
			await emitDiscordWebhook(
				`# ✅ Game Maker 完了（ドライラン）\n\n「${concept.title}」を生成し ${logPath} に保存しました。`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`✗ 失敗: ${message}`);
		await emitDiscordWebhook(`# ❌ Game Maker 失敗\n\n${message}`);
		throw err;
	}
}
