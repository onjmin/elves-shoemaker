// LLM の出力（GameConcept + LevelDesign）から GameManifestDraft を決定的に組み立てる。
// デフォルト値・アセット参照・座標計算はすべてここで確定するため、
// LLM が触れるのは「タイトル・ASCIIマップ・エンティティ配置」だけになる。

import { parseAsciiMap } from "./ascii-map";
import {
	ACTION_BGM,
	ACTION_ENTITIES,
	ACTION_SFX,
	ACTION_TILES,
	type EntityType,
	PLAYER_SPRITE_REF,
	TILE_SIZE,
} from "./catalog";
import type { ActionManifest, GameConcept, LevelDesign, ManifestObject } from "./schema";

const uid = () => `o${Math.random().toString(36).slice(2, 9)}`;

export interface BuildResult {
	manifest: ActionManifest | null;
	errors: string[];
	warnings: string[];
}

export function buildActionManifest(concept: GameConcept, level: LevelDesign): BuildResult {
	const parsed = parseAsciiMap(level.asciiMap);
	const errors = [...parsed.errors];
	const warnings = [...parsed.warnings];

	// エンティティ → ManifestObject
	const objects: ManifestObject[] = [];
	for (const [i, e] of level.entities.entries()) {
		const preset = ACTION_ENTITIES[e.type as EntityType];
		if (!preset) {
			errors.push(`entities[${i}]: 未知のタイプ '${e.type}'`);
			continue;
		}
		if (e.col >= parsed.cols || e.row >= parsed.map.length) {
			errors.push(`entities[${i}] (${e.type}): 座標 (${e.col}, ${e.row}) がマップ外です`);
			continue;
		}
		const isNpc = preset.objType === "npc";
		if (isNpc && !e.message?.trim()) {
			errors.push(`entities[${i}] (${e.type}): NPC には message（セリフ）が必須です`);
			continue;
		}
		objects.push({
			id: uid(),
			kind: "npc",
			emoji: preset.emoji,
			spriteRef: preset.spriteRef,
			col: e.col,
			row: e.row,
			hp: preset.hp,
			speed: preset.speed,
			behavior: preset.behavior,
			bullet: "none",
			bulletSpeed: 3,
			bulletColor: "#00ffff",
			fireRate: 60,
			hazard: preset.hazard,
			message: isNpc ? (e.message ?? "").trim() : "",
			...(preset.w !== undefined ? { w: preset.w } : {}),
			...(preset.h !== undefined ? { h: preset.h } : {}),
			...(preset.objType ? { objType: preset.objType } : {}),
			...(preset.objType === "platform" || preset.name === "movingPlatform"
				? { name: preset.name }
				: {}),
			...(preset.stompable ? { stompable: true } : {}),
			...(preset.shell ? { shell: true } : {}),
		});
	}

	if (errors.length > 0 || !parsed.start) {
		return { manifest: null, errors, warnings };
	}

	// プレイヤー開始位置: 'S' のマスに足元が来るように配置する。
	// プレイヤーは h=64（縦2マス）なので、上端 y は (S行 - 1) * 32。
	const startX = parsed.start.col * TILE_SIZE;
	const startY = Math.max(0, (parsed.start.row - 1) * TILE_SIZE);

	const manifest: ActionManifest = {
		preset: "mario",
		engine: "action",
		name: concept.title,
		gravity: 0.5,
		friction: 0.85,
		player: {
			emoji: concept.playerEmoji,
			color: "#ff4444",
			speed: 5,
			jumpPower: -8.0,
			w: 24,
			h: 64,
			start: { x: startX, y: startY },
			spriteRef: PLAYER_SPRITE_REF,
			hearts: 3,
		},
		tiles: Object.fromEntries(
			ACTION_TILES.map((t) => [
				String(t.id),
				{
					name: t.name,
					color: t.color,
					passable: t.passable,
					...(t.special ? { special: t.special } : {}),
					...(t.imageUrl ? { imageUrl: t.imageUrl } : {}),
					...(t.imageOverflowTop ? { imageOverflowTop: true } : {}),
					...(t.imageScale2x ? { imageScale2x: true } : {}),
				},
			]),
		),
		map: parsed.map,
		objects,
		bgm: ACTION_BGM[concept.mood] ?? ACTION_BGM.overworld,
		sfx: { ...ACTION_SFX },
		scroll: { worldCols: parsed.cols },
		titleScreen: {
			enabled: true,
			heading: concept.title,
			subtitle: concept.subtitle || undefined,
			textColor: "#ffe000",
			menu: [{ kind: "newGame", label: "はじめる" }],
		},
		ending: {
			enabled: true,
			heading: "GAME CLEAR!",
			message: concept.endingMessage,
			textColor: "#ffe000",
		},
	};

	return { manifest, errors, warnings };
}
