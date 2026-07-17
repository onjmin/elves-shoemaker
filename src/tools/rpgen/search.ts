import { z } from "zod";
import {
	type ResolvedAsset,
	type RpgenKind,
	resolveAssets,
	searchRpgen,
} from "../../game-maker/rpgen";
import { createTool, type ToolResponse, toolResult } from "../types";

export const RpgenSearchArgsSchema = z.object({
	kind: z.enum(["sprites", "spriteAnims", "sounds"]),
	query: z.string().min(1),
	limit: z.number().int().min(1).max(30).default(10),
});

export type RpgenSearchArgs = z.infer<typeof RpgenSearchArgsSchema>;

export interface RpgenSearchData {
	items: ResolvedAsset[];
	hasNext: boolean;
}

/**
 * TOOL: rpgen.search
 * RPGen Search から素材（タイル画像・歩行アニメ・効果音/BGM）を検索します。
 * 返ってくる ref はそのままゲームマニフェストに書ける参照文字列です。
 * 認証: .env の RPGEN_SEARCH_TOKEN（未設定時は UNJ_REZE_API_BASE のプロキシ経由）。
 */
export const rpgenSearchTool = createTool<RpgenSearchArgs, RpgenSearchData>({
	name: "rpgen.search",
	description:
		"Search game assets on RPGen Search. kind: 'sprites' (16x16 tile images), 'spriteAnims' (walking character sheets for NPCs/enemies), 'sounds' (mp3 SFX/BGM). Returns ready-to-use ref strings for game manifests. Search with Japanese keywords (e.g. スライム, 草原, 爆発).",
	inputSchema: {
		kind: {
			type: "string",
			description: "Asset kind: 'sprites' | 'spriteAnims' | 'sounds'.",
		},
		query: {
			type: "string",
			description: "Search keyword (Japanese works best, e.g. 'スライム', '城', '洞窟').",
		},
		limit: {
			type: "number",
			description: "Max results (1-30, default 10).",
		},
	},

	handler: async (args: RpgenSearchArgs): Promise<ToolResponse<RpgenSearchData>> => {
		const parsed = RpgenSearchArgsSchema.safeParse(args);
		if (!parsed.success) {
			return toolResult.fail(
				`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
			);
		}
		const { kind, query, limit } = parsed.data;
		try {
			const result = await searchRpgen(kind as RpgenKind, { q: query, limit });
			const items = resolveAssets(kind as RpgenKind, result.data);
			const preview = items
				.slice(0, 5)
				.map((i) => `${i.name || "(無題)"} [id:${i.id}]`)
				.join(", ");
			const more = result.meta.hasNext ? " (more available)" : "";
			return toolResult.ok(
				`Found ${items.length} ${kind} for "${query}"${more}. Top: ${preview || "(none — try another keyword)"}`,
				{ items, hasNext: result.meta.hasNext },
			);
		} catch (err) {
			return toolResult.fail(
				`rpgen search failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
