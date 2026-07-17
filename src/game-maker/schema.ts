// unj-reze のゲーム投稿フォーマット（GameManifestDraft）の action エンジン向けサブセット。
// 出典: unj-reze/components/GameMaker.tsx の GameManifestDraft（保存用マニフェスト）。
// LLM の出力（GameDesign）と最終成果物（ActionManifest）を Zod で二段階に検証する。

import { z } from "zod";
import { ENTITY_TYPES, MAX_WORLD_COLS, MIN_WORLD_COLS } from "./catalog";

// ── LLM が出力する中間表現（デザインJSON） ─────────────────────────────────
// マニフェスト全体を LLM に書かせない。小さな決定だけを出力させ、
// 組み立ては build-manifest.ts が決定的に行う。

/** ステージ1: コンセプト */
export const GameConceptSchema = z.object({
	title: z.string().min(1).max(40),
	subtitle: z.string().max(60).default(""),
	endingMessage: z.string().min(1).max(200),
	playerEmoji: z.string().min(1).max(8).default("🦝"),
	/** ステージの横幅（列数）。20〜300。60前後を推奨 */
	worldCols: z.number().int().min(MIN_WORLD_COLS).max(MAX_WORLD_COLS),
	/** BGM の雰囲気 */
	mood: z.enum(["overworld", "underground", "castle"]).default("overworld"),
});
export type GameConcept = z.infer<typeof GameConceptSchema>;

/** ステージ2: レベルデザイン（ASCIIマップ＋エンティティ配置） */
export const EntityPlacementSchema = z.object({
	type: z.enum(ENTITY_TYPES as [string, ...string[]]),
	col: z.number().int().min(0),
	row: z.number().int().min(0),
	/** NPC（toad/princess）のセリフ */
	message: z.string().max(300).optional(),
});
export type EntityPlacement = z.infer<typeof EntityPlacementSchema>;

export const LevelDesignSchema = z.object({
	asciiMap: z.array(z.string()).min(5).max(30),
	entities: z.array(EntityPlacementSchema).max(80),
});
export type LevelDesign = z.infer<typeof LevelDesignSchema>;

// ── 最終成果物: GameManifestDraft（action エンジンサブセット） ──────────────
// POST /api/games の body.manifest にそのまま入る形。

export const ManifestTileSchema = z.object({
	name: z.string(),
	color: z.string(),
	passable: z.boolean(),
	special: z.string().optional(),
	imageRef: z.string().optional(),
	imageUrl: z.string().optional(),
	imageOverflowTop: z.boolean().optional(),
	imageScale2x: z.boolean().optional(),
});

export const ManifestObjectSchema = z.object({
	id: z.string(),
	kind: z.literal("npc"),
	emoji: z.string(),
	spriteRef: z.string().optional(),
	col: z.number().int().min(0),
	row: z.number().int().min(0),
	hp: z.number().min(1),
	speed: z.number().min(0),
	behavior: z.enum(["still", "random", "chase", "flee", "patrolH", "patrolV", "walker"]),
	bullet: z.literal("none"),
	bulletSpeed: z.number(),
	bulletColor: z.string(),
	fireRate: z.number(),
	hazard: z.boolean(),
	message: z.string(),
	w: z.number().optional(),
	h: z.number().optional(),
	objType: z.enum(["npc", "platform", "item", "enemy"]).optional(),
	name: z.string().optional(),
	stompable: z.boolean().optional(),
	shell: z.boolean().optional(),
});

export const ActionManifestSchema = z.object({
	preset: z.literal("mario"),
	engine: z.literal("action"),
	name: z.string().min(1),
	gravity: z.number(),
	friction: z.number(),
	player: z.object({
		emoji: z.string(),
		color: z.string(),
		speed: z.number(),
		jumpPower: z.number(),
		w: z.number(),
		h: z.number(),
		start: z.object({ x: z.number(), y: z.number() }),
		spriteRef: z.string().optional(),
		hearts: z.number().int().min(1).optional(),
	}),
	tiles: z.record(z.string(), ManifestTileSchema),
	map: z.array(z.array(z.number().int())),
	objects: z.array(ManifestObjectSchema),
	bgm: z.string(),
	sfx: z.record(z.string(), z.string()),
	scroll: z.object({ worldCols: z.number().int() }).optional(),
	titleScreen: z
		.object({
			enabled: z.boolean(),
			heading: z.string(),
			subtitle: z.string().optional(),
			textColor: z.string().optional(),
			menu: z.array(z.object({ kind: z.literal("newGame"), label: z.string() })),
		})
		.optional(),
	ending: z
		.object({
			enabled: z.boolean(),
			heading: z.string(),
			message: z.string().optional(),
			textColor: z.string().optional(),
		})
		.optional(),
});
export type ActionManifest = z.infer<typeof ActionManifestSchema>;
export type ManifestObject = z.infer<typeof ManifestObjectSchema>;
