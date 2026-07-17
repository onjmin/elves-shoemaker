// ウォーキングシミュレーター（rpg エンジン）向けの中間表現とマニフェストの Zod スキーマ。

import { z } from "zod";
import { RPG_ENTITY_ALIASES, RPG_ENTITY_TYPES } from "./catalog";

/** ステージ1: コンセプト */
export const RpgConceptSchema = z.object({
	title: z.string().min(1).max(40),
	subtitle: z.string().max(60).default(""),
	/** めざめの場所を踏んだとき（＝夢から覚めたとき）に表示する文 */
	endingMessage: z.string().min(1).max(300),
	playerEmoji: z.string().min(1).max(8).default("🚶"),
	/** BGM の雰囲気 */
	mood: z.enum(["dream", "night", "ruins"]).default("dream"),
});
export type RpgConcept = z.infer<typeof RpgConceptSchema>;

/** ステージ2: マップ＋エンティティ */
export const RpgEntitySchema = z.object({
	type: z.enum(RPG_ENTITY_TYPES as [string, ...string[]]),
	col: z.number().int().min(0),
	row: z.number().int().min(0),
	/** npc: 見た目の絵文字（省略時 👤） */
	emoji: z.string().max(8).optional(),
	/** npc: 話しかけたときの不思議な一言（必須） */
	message: z.string().max(300).optional(),
	/** warp: 飛び先の座標（必須） */
	toCol: z.number().int().min(0).optional(),
	toRow: z.number().int().min(0).optional(),
});
export type RpgEntity = z.infer<typeof RpgEntitySchema>;

export const RpgLevelSchema = z.object({
	asciiMap: z.array(z.string()).min(8).max(40),
	entities: z.array(RpgEntitySchema).max(60),
});
export type RpgLevel = z.infer<typeof RpgLevelSchema>;

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
			warnings.push(`エンティティタイプ '${ent.type}' を '${alias}' として解釈しました`);
			ent.type = alias;
			return true;
		}
		warnings.push(`未知のエンティティタイプ '${ent.type}' を1件無視しました`);
		return false;
	});
	return { data: { ...obj, entities }, warnings };
}

/** 最終成果物（GameManifestDraft の rpg サブセット）。
 *  深い構造（イベント等）は builder が決定的に生成するため骨格だけ検証する。 */
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
	bgm: z.string(),
	sfx: z.record(z.string(), z.string()),
	scroll: z.object({ worldCols: z.number().int(), worldRows: z.number().int().optional() }),
});
export type RpgManifest = z.infer<typeof RpgManifestSchema>;
