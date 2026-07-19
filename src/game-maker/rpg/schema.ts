// ウォーキングシミュレーター（rpg エンジン）向けの中間表現とマニフェストの Zod スキーマ。
// ゆめにっき系：複数の夢世界（シーン）を扉でつなぎ、会話イベントと収集エフェクトで
// 散策に奥行きを出す。LLM の出力は「コンセプト1回＋ワールドごとに1回」の小さなJSONに分割する。

import { z } from "zod";
import { RPG_ENTITY_ALIASES, RPG_ENTITY_TYPES, RPG_MOODS } from "./catalog";

/** ワールドID・エフェクトID用のゆるいスラッグ */
const slug = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z][a-z0-9_-]{0,15}$/,
		"must be a lowercase-letter-first alphanumeric id, 16 characters or fewer",
	);

/** ステージ1: コンセプト（夢世界の一覧を含む） */
export const RpgWorldDefSchema = z.object({
	id: slug,
	name: z.string().min(1).max(20),
	/** BGM・雰囲気 */
	mood: z.enum(RPG_MOODS),
	/** この世界の情景を1行で（ステージ2のマップ生成に文脈として渡す） */
	theme: z.string().min(1).max(80),
});
export type RpgWorldDef = z.infer<typeof RpgWorldDefSchema>;

export const RpgEffectDefSchema = z.object({
	id: slug,
	name: z.string().min(1).max(16),
	emoji: z.string().min(1).max(8),
	/** どのワールドに置くか */
	worldId: slug,
});
export type RpgEffectDef = z.infer<typeof RpgEffectDefSchema>;

export const RpgConceptSchema = z
	.object({
		title: z.string().min(1).max(40),
		subtitle: z.string().max(60).default(""),
		/** めざめの場所を踏んだとき（＝夢から覚めたとき）に表示する文 */
		endingMessage: z.string().min(1).max(300),
		playerEmoji: z.string().min(1).max(8).default("🚶"),
		/** 夢世界の一覧。最初の1つが「拠点（ネクサス）」で、他の全ワールドへの扉を持つ */
		worlds: z.array(RpgWorldDefSchema).min(3).max(6),
		/** 収集エフェクト（0〜3個）。NPCの会話が反応する小道具 */
		effects: z.array(RpgEffectDefSchema).max(3).default([]),
		/** めざめの場所 'G' を置くワールド（拠点以外） */
		endingWorldId: slug,
	})
	.superRefine((c, ctx) => {
		const ids = c.worlds.map((w) => w.id);
		if (new Set(ids).size !== ids.length) {
			ctx.addIssue({ code: "custom", path: ["worlds"], message: "worlds ids must be unique" });
		}
		if (!ids.includes(c.endingWorldId)) {
			ctx.addIssue({
				code: "custom",
				path: ["endingWorldId"],
				message: `endingWorldId '${c.endingWorldId}' does not match any id in worlds`,
			});
		}
		if (c.endingWorldId === ids[0]) {
			ctx.addIssue({
				code: "custom",
				path: ["endingWorldId"],
				message: "endingWorldId must not be the first world (that's the hub)",
			});
		}
		const effIds = c.effects.map((e) => e.id);
		if (new Set(effIds).size !== effIds.length) {
			ctx.addIssue({
				code: "custom",
				path: ["effects"],
				message: "effects ids must be unique",
			});
		}
		for (const [i, e] of c.effects.entries()) {
			if (!ids.includes(e.worldId)) {
				ctx.addIssue({
					code: "custom",
					path: ["effects", i, "worldId"],
					message: `effects[${i}].worldId '${e.worldId}' does not match any id in worlds`,
				});
			}
		}
	});
export type RpgConcept = z.infer<typeof RpgConceptSchema>;

/** ステージ2: NPC の会話イベント（決定的に EventPage へコンパイルされる小さなDSL）。
 *  - lines:     ふだんの会話（メッセージウィンドウで順に表示）
 *  - onceLines: はじめて話しかけたときだけの会話（セルフスイッチで1回きり）
 *  - choice:    1段だけの選択肢。選んだ枝の lines を表示して閉じる
 *  - ifEffect:  指定エフェクトを持っているときだけの反応（最優先で表示） */
const dialogueLine = z.string().min(1).max(120);
export const RpgDialogueSchema = z.object({
	lines: z.array(dialogueLine).min(1).max(4),
	onceLines: z.array(dialogueLine).min(1).max(3).optional(),
	choice: z
		.object({
			prompt: dialogueLine,
			options: z
				.array(
					z.object({
						label: z.string().min(1).max(12),
						lines: z.array(dialogueLine).min(1).max(3),
					}),
				)
				.min(2)
				.max(3),
		})
		.optional(),
	ifEffect: z
		.object({
			effectId: z.string(),
			lines: z.array(dialogueLine).min(1).max(3),
		})
		.optional(),
});
export type RpgDialogue = z.infer<typeof RpgDialogueSchema>;

/** ステージ2: ワールドごとのマップ＋エンティティ */
export const RpgEntitySchema = z.object({
	type: z.enum(RPG_ENTITY_TYPES as [string, ...string[]]),
	col: z.number().int().min(0),
	row: z.number().int().min(0),
	/** npc: 見た目の絵文字（省略時 👤）。door/warp/effect も上書き可 */
	emoji: z.string().max(8).optional(),
	/** npc: 頭上に出す不思議な一言（dialogue が無いNPCは必須） */
	message: z.string().max(300).optional(),
	/** npc: 会話イベント（メッセージウィンドウ・選択肢・条件分岐） */
	dialogue: RpgDialogueSchema.optional(),
	/** warp: 同一ワールド内の飛び先座標（必須） */
	toCol: z.number().int().min(0).optional(),
	toRow: z.number().int().min(0).optional(),
	/** door: 行き先ワールドID（必須）。toCol/toRow は行き先での出現座標（省略可） */
	toWorld: z.string().optional(),
	/** effect: 拾えるエフェクトのID（コンセプトで宣言したもの） */
	effectId: z.string().optional(),
});
export type RpgEntity = z.infer<typeof RpgEntitySchema>;

export const RpgWorldLevelSchema = z.object({
	asciiMap: z.array(z.string()).min(8).max(40),
	// 弱いLLMは指示を無視して同じNPCを大量に複製しがちなため、実用上の目安（15個程度）より
	// かなり寛容だが、暴走出力（数十個の複製）は確実に弾ける値に抑える。
	entities: z.array(RpgEntitySchema).max(24),
});
export type RpgWorldLevel = z.infer<typeof RpgWorldLevelSchema>;

// OpenAI互換の response_format.json_schema にそのまま渡せる形（Zod v4 のネイティブ変換）。
// superRefine によるクロスフィールド制約（endingWorldId が worlds に含まれる等）は
// JSON Schema で表現できないため反映されない点に注意——そこは従来通り safeParse 側で検証する。
export const RpgConceptJsonSchema = z.toJSONSchema(RpgConceptSchema);
export const RpgWorldLevelJsonSchema = z.toJSONSchema(RpgWorldLevelSchema);

/** Zod検証前の正規化：エンティティタイプの別名吸収・未知タイプの破棄。 */
export function normalizeRpgLevel(raw: unknown): { data: unknown; warnings: string[] } {
	const warnings: string[] = [];
	if (
		typeof raw !== "object" ||
		raw === null ||
		!Array.isArray((raw as { entities?: unknown }).entities)
	) {
		return { data: raw, warnings };
	}
	const obj = raw as { entities: unknown[] };
	const entities = obj.entities.filter((e) => {
		if (typeof e !== "object" || e === null) return true;
		const ent = e as { type?: unknown };
		if (typeof ent.type !== "string") return true;
		const key = ent.type.trim().toLowerCase();
		if ((RPG_ENTITY_TYPES as string[]).includes(key)) {
			ent.type = key;
			return true;
		}
		const alias = RPG_ENTITY_ALIASES[key];
		if (alias) {
			warnings.push(`Interpreted entity type '${ent.type}' as '${alias}'`);
			ent.type = alias;
			return true;
		}
		warnings.push(`Ignored 1 entity with unknown type '${ent.type}'`);
		return false;
	});
	return { data: { ...obj, entities }, warnings };
}

/** 最終成果物（GameManifestDraft の rpg サブセット）。
 *  深い構造（イベントページ等）は builder が決定的に生成するため骨格だけ検証する。 */
export const RpgManifestSchema = z.looseObject({
	preset: z.literal("dq"),
	engine: z.literal("rpg"),
	name: z.string().min(1),
	gravity: z.number(),
	friction: z.number(),
	player: z.looseObject({
		emoji: z.string(),
		start: z.object({ x: z.number(), y: z.number() }),
	}),
	tiles: z.record(
		z.string(),
		z.looseObject({ name: z.string(), color: z.string(), passable: z.boolean() }),
	),
	map: z.array(z.array(z.number().int())),
	objects: z.array(
		z.looseObject({
			id: z.string(),
			emoji: z.string(),
			col: z.number().int().min(0),
			row: z.number().int().min(0),
		}),
	),
	/** ワールド＝シーン。scenes[0] が拠点で、map/objects はその複製 */
	scenes: z
		.array(
			z.looseObject({
				id: z.string().min(1),
				name: z.string().optional(),
				map: z.array(z.array(z.number().int())),
				objects: z.array(
					z.looseObject({
						id: z.string(),
						emoji: z.string(),
						col: z.number().int().min(0),
						row: z.number().int().min(0),
					}),
				),
				bgm: z.string().optional(),
			}),
		)
		.min(1),
	items: z.array(z.looseObject({ id: z.string(), name: z.string(), emoji: z.string() })).optional(),
	bgm: z.string(),
	sfx: z.record(z.string(), z.string()),
	scroll: z.object({ worldCols: z.number().int(), worldRows: z.number().int().optional() }),
});
export type RpgManifest = z.infer<typeof RpgManifestSchema>;
