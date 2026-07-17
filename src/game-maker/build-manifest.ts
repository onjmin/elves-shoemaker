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
	ROWS,
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
	// LLMは行の長さを安定して守れないため、意図した横幅（worldCols）まで右埋めする
	const parsed = parseAsciiMap(level.asciiMap, concept.worldCols);
	const errors = [...parsed.errors];
	const warnings = [...parsed.warnings];

	// タイル通行情報（開始位置の自動補正に使う）
	const tileById = new Map(ACTION_TILES.map((t) => [t.id, t]));
	const isPassable = (c: number, r: number) => {
		if (c < 0 || r < 0 || c >= parsed.cols || r >= ROWS) return false;
		return tileById.get(parsed.map[r]?.[c] ?? 0)?.passable !== false;
	};
	/** 立てるマス（足元が固体タイル or すり抜け床） */
	const isStandable = (c: number, r: number) => {
		if (!isPassable(c, r) || r + 1 >= ROWS) return false;
		const below = tileById.get(parsed.map[r + 1]?.[c] ?? 0);
		return below !== undefined && (!below.passable || below.special === "oneway");
	};
	/** prefCol から近い順に「立てるマス」を探す（各列では最も低い位置を優先） */
	const findNearestStandable = (prefCol: number): { col: number; row: number } | null => {
		for (let d = 0; d < parsed.cols; d++) {
			for (const c of d === 0 ? [prefCol] : [prefCol - d, prefCol + d]) {
				if (c < 0 || c >= parsed.cols) continue;
				for (let r = ROWS - 2; r >= 0; r--) {
					if (isStandable(c, r)) return { col: c, row: r };
				}
			}
		}
		return null;
	};

	// 地面の自動生成：立てるマスが1つも無い（＝モデルが地面を描き忘れた）場合、
	// 下2行の空マスを岩床(5)で埋めて最低限遊べるステージにする。
	// 一部でも地面があるマップには適用しない（意図的な穴を保護するため）。
	const hasAnyStandable = () => {
		for (let c = 0; c < parsed.cols; c++) {
			for (let r = 0; r < ROWS - 1; r++) if (isStandable(c, r)) return true;
		}
		return false;
	};
	if (!hasAnyStandable()) {
		for (const r of [ROWS - 2, ROWS - 1]) {
			for (let c = 0; c < parsed.cols; c++) {
				if (parsed.map[r][c] === 0) parsed.map[r][c] = 5;
			}
		}
		warnings.push("マップに立てる地面が1つも無いため、下2行に地面(岩床)を敷きました");
	}

	// エンティティ → ManifestObject
	const objects: ManifestObject[] = [];
	for (const [i, e] of level.entities.entries()) {
		const preset = ACTION_ENTITIES[e.type as EntityType];
		if (!preset) {
			errors.push(`entities[${i}]: 未知のタイプ '${e.type}'`);
			continue;
		}
		// マップ外の座標はエラーにせず、範囲内へクランプして警告に留める
		let col = e.col;
		let row = e.row;
		if (col >= parsed.cols || row >= ROWS) {
			col = Math.min(col, parsed.cols - 1);
			row = Math.min(row, ROWS - 1);
			warnings.push(
				`entities[${i}] (${e.type}): 座標 (${e.col}, ${e.row}) がマップ外のため (${col}, ${row}) に移動しました`,
			);
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
			col,
			row,
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

	// 開始位置の自動補正：'S' の足元に地面が無い場合、最寄りの立てるマスへ移動する
	let start = parsed.start;
	if (start && !isStandable(start.col, start.row)) {
		const relocated = findNearestStandable(start.col);
		if (relocated) {
			warnings.push(
				`開始位置 'S' (${start.col}, ${start.row}) の下に地面が無いため (${relocated.col}, ${relocated.row}) に移動しました`,
			);
			start = relocated;
		}
	}

	if (errors.length > 0 || !start) {
		return { manifest: null, errors, warnings };
	}

	// プレイヤー開始位置: 'S' のマスに足元が来るように配置する。
	// プレイヤーは h=64（縦2マス）なので、上端 y は (S行 - 1) * 32。
	const startX = start.col * TILE_SIZE;
	const startY = Math.max(0, (start.row - 1) * TILE_SIZE);

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
