import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { lintActionManifest } from "../../game-maker/lint";
import { ActionManifestSchema } from "../../game-maker/schema";
import { postGame, unjRezeBaseUrl } from "../../game-maker/submit";
import { createTool, type ToolResponse, toolResult } from "../types";

export interface UnjRezeSubmitGameArgs {
	title: string;
	manifestJson: string;
	dryRun: boolean;
	creatorSlug?: string;
}

export interface UnjRezeSubmitGameData {
	gameId?: string | number;
	dryRun: boolean;
	warnings: string[];
}

/**
 * TOOL: unjreze.submit_game
 * 検証済みのゲームマニフェストを unj-reze の POST /api/games に投稿します。
 * 投稿前に必ず Zod（構造）＋リント（遊べるか）の二段検証を通し、
 * 投稿内容は logs/ にも保存します。dryRun=true なら検証と保存だけ行います。
 */
export const unjRezeSubmitGameTool = createTool<UnjRezeSubmitGameArgs, UnjRezeSubmitGameData>({
	name: "unjreze.submit_game",
	description:
		"Validate a game manifest (GameManifestDraft JSON) and submit it to the unj-reze /api/games endpoint. Set dryRun=true to validate without publishing.",
	inputSchema: {
		title: {
			type: "string",
			description: "Game title shown on unj-reze.",
		},
		manifestJson: {
			type: "string",
			description: "The full GameManifestDraft as a JSON string.",
			isRawData: true,
		},
		dryRun: {
			type: "boolean",
			description: "If true, only validate and save locally; do not publish.",
		},
		creatorSlug: {
			type: "string",
			description: "Optional creator slug to attribute the game to.",
		},
	},

	handler: async (args: UnjRezeSubmitGameArgs): Promise<ToolResponse<UnjRezeSubmitGameData>> => {
		// 1. JSON パース
		let raw: unknown;
		try {
			raw = JSON.parse(args.manifestJson);
		} catch (err) {
			return toolResult.fail(
				`manifestJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// 2. 構造検証（Zod）
		const parsed = ActionManifestSchema.safeParse(raw);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.slice(0, 10)
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			return toolResult.fail(`Manifest schema validation failed: ${issues}`);
		}

		// 3. セマンティックリント（遊べるか）
		const lint = lintActionManifest(parsed.data);
		if (lint.errors.length > 0) {
			return toolResult.fail(`Playability check failed: ${lint.errors.join("; ")}`);
		}

		// 4. 投稿内容をローカルに保存（投稿の成否に関わらず記録を残す）
		const logDir = resolve(process.cwd(), "logs");
		await fs.mkdir(logDir, { recursive: true });
		const logPath = resolve(logDir, `game-${Date.now()}.json`);
		await fs.writeFile(
			logPath,
			JSON.stringify({ title: args.title, manifest: parsed.data }, null, 2),
			"utf-8",
		);

		if (args.dryRun) {
			return toolResult.ok(
				`Dry run OK: manifest is valid (${lint.warnings.length} warnings). Saved to ${logPath}. Not published.`,
				{ dryRun: true, warnings: lint.warnings },
			);
		}

		// 5. 投稿
		try {
			const game = await postGame({
				preset: parsed.data.preset,
				title: args.title,
				manifest: parsed.data,
				creatorSlug: args.creatorSlug || undefined,
			});
			return toolResult.ok(
				`Game published to ${unjRezeBaseUrl()} (id: ${game.id}). Saved to ${logPath}.`,
				{ gameId: game.id, dryRun: false, warnings: lint.warnings },
			);
		} catch (err) {
			return toolResult.fail(
				`Failed to publish game: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
