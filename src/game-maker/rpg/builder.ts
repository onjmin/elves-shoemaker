// LLM の出力（RpgConcept + RpgLevel）からウォーキングシミュレーターの
// マニフェストを決定的に組み立てる。action 版と同じ思想：
// ゲームを壊さない逸脱は自動補正して警告、壊す逸脱だけエラーとして差し戻す。

import { walkRef } from "../rpgen";
import {
	HERO_SPRITE_REF,
	NPC_SPRITE_BY_EMOJI,
	RPG_BGM,
	RPG_CHAR_TO_TILE,
	RPG_COLS,
	RPG_ROWS,
	RPG_SAFE_PAD,
	RPG_SFX,
	RPG_START_CHAR,
	RPG_TILES,
	rpgTileImageUrl,
	TILE_SIZE,
} from "./catalog";
import type { RpgConcept, RpgEntity, RpgLevel } from "./schema";

const uid = () => `o${Math.random().toString(36).slice(2, 9)}`;

export interface RpgBuildResult {
	manifest: Record<string, unknown> | null;
	errors: string[];
	warnings: string[];
}

export interface ParsedRpgMap {
	map: number[][];
	cols: number;
	start: { col: number; row: number } | null;
	goals: { col: number; row: number }[];
	errors: string[];
	warnings: string[];
}

/** ASCII → タイルIDグリッド（RPG_ROWS×RPG_COLS へ正規化） */
export function parseRpgAsciiMap(rows: string[]): ParsedRpgMap {
	const errors: string[] = [];
	const warnings: string[] = [];

	let lines = rows.flatMap((r) => r.split(/\r?\n/));
	if (lines.length !== rows.length) {
		warnings.push("asciiMap の文字列内に改行が含まれていたため、行として分割しました");
	}
	if (lines.some((l) => /[ 　]/.test(l))) {
		warnings.push("空白文字を草原 '.' に置き換えました");
		lines = lines.map((l) => l.replace(/[ 　]/g, "."));
	}

	// 行数の正規化：足りなければ最終行を複製して埋め、多ければ下を捨てる
	// （外周が M/W の行で終わることが多く、複製しても矛盾しにくい）。
	if (lines.length < RPG_ROWS) {
		warnings.push(`行数が ${lines.length} 行のため、最終行を複製して${RPG_ROWS}行にしました`);
		const last = lines[lines.length - 1] ?? "M".repeat(RPG_COLS);
		while (lines.length < RPG_ROWS) lines.push(last);
	} else if (lines.length > RPG_ROWS) {
		warnings.push(`行数が ${lines.length} 行のため、下の行を削って${RPG_ROWS}行にしました`);
		lines = lines.slice(0, RPG_ROWS);
	}

	// 列数の正規化：RPG_COLS まで行末の地形文字で右埋め
	const cols = Math.max(...lines.map((l) => l.length), RPG_COLS);
	lines = lines.map((l, i) => {
		if (l.length === cols) return l;
		const last = l[l.length - 1];
		const pad = last !== undefined && RPG_SAFE_PAD.has(last) ? last : "M";
		if (l.length > 0) warnings.push(`行${i + 1}が${l.length}文字のため '${pad}' で右埋めしました`);
		return l.padEnd(cols, pad);
	});

	const map: number[][] = [];
	let start: ParsedRpgMap["start"] = null;
	const goals: ParsedRpgMap["goals"] = [];
	const unknown = new Set<string>();

	for (let r = 0; r < RPG_ROWS; r++) {
		const row: number[] = [];
		for (let c = 0; c < cols; c++) {
			const ch = lines[r][c];
			if (ch === RPG_START_CHAR) {
				if (start)
					errors.push(`開始位置 '${RPG_START_CHAR}' が複数あります（1つだけにしてください）`);
				start = { col: c, row: r };
				row.push(0);
				continue;
			}
			const tile = RPG_CHAR_TO_TILE.get(ch);
			if (!tile) {
				unknown.add(ch);
				row.push(0);
				continue;
			}
			if (tile.special === "goal") goals.push({ col: c, row: r });
			row.push(tile.id);
		}
		map.push(row);
	}

	if (unknown.size > 0) {
		errors.push(`凡例にない文字が使われています: ${[...unknown].map((c) => `'${c}'`).join(", ")}`);
	}
	if (!start)
		errors.push(`開始位置 '${RPG_START_CHAR}' がありません（歩けるマスに1つ置いてください）`);
	if (goals.length === 0) {
		warnings.push("めざめの場所 'G' が無いため、クリアの無い永遠の散策マップになります");
	}

	return { map, cols, start, goals, errors, warnings };
}

export function buildRpgManifest(concept: RpgConcept, level: RpgLevel): RpgBuildResult {
	const parsed = parseRpgAsciiMap(level.asciiMap);
	const errors = [...parsed.errors];
	const warnings = [...parsed.warnings];

	const tileById = new Map(RPG_TILES.map((t) => [t.id, t]));
	const isPassable = (c: number, r: number) => {
		if (c < 0 || r < 0 || c >= parsed.cols || r >= RPG_ROWS) return false;
		return tileById.get(parsed.map[r]?.[c] ?? 0)?.passable !== false;
	};
	/** prefCol/prefRow から近い順（チェビシェフ距離）に歩けるマスを探す */
	const findNearestPassable = (
		prefCol: number,
		prefRow: number,
	): { col: number; row: number } | null => {
		for (let d = 0; d < Math.max(parsed.cols, RPG_ROWS); d++) {
			for (let dc = -d; dc <= d; dc++) {
				for (let dr = -d; dr <= d; dr++) {
					if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
					const c = prefCol + dc;
					const r = prefRow + dr;
					if (isPassable(c, r)) return { col: c, row: r };
				}
			}
		}
		return null;
	};

	/** マップ外クランプ＋壁の中なら最寄りの歩けるマスへ（自動補正） */
	const fixPosition = (
		label: string,
		col0: number,
		row0: number,
	): { col: number; row: number } | null => {
		let col = Math.min(col0, parsed.cols - 1);
		let row = Math.min(row0, RPG_ROWS - 1);
		if (col !== col0 || row !== row0) {
			warnings.push(
				`${label}: 座標 (${col0}, ${row0}) がマップ外のため (${col}, ${row}) に移動しました`,
			);
		}
		if (!isPassable(col, row)) {
			const moved = findNearestPassable(col, row);
			if (!moved) return null;
			warnings.push(
				`${label}: (${col}, ${row}) が壁の中のため (${moved.col}, ${moved.row}) に移動しました`,
			);
			col = moved.col;
			row = moved.row;
		}
		return { col, row };
	};

	// 開始位置の自動補正
	let start = parsed.start;
	if (start) {
		const fixed = fixPosition("開始位置 'S'", start.col, start.row);
		if (fixed) start = fixed;
	}

	// エンティティ → オブジェクト
	const objects: Record<string, unknown>[] = [];
	const warpTargets: { col: number; row: number; toCol: number; toRow: number }[] = [];
	for (const [i, e] of level.entities.entries()) {
		const entity = e as RpgEntity;
		const pos = fixPosition(`entities[${i}] (${entity.type})`, entity.col, entity.row);
		if (!pos) continue;

		const base = {
			id: uid(),
			kind: "npc" as const,
			col: pos.col,
			row: pos.row,
			hp: 8,
			speed: 1,
			behavior: "still" as const,
			bullet: "none" as const,
			bulletSpeed: 3,
			bulletColor: "#00ffff",
			fireRate: 60,
			hazard: false,
			message: "",
		};

		if (entity.type === "npc") {
			if (!entity.message?.trim()) {
				errors.push(`entities[${i}] (npc): message（セリフ）が必須です`);
				continue;
			}
			const emoji = entity.emoji || "👤";
			const spriteId = NPC_SPRITE_BY_EMOJI[emoji];
			objects.push({
				...base,
				emoji,
				behavior: "random",
				speed: 0.6,
				message: entity.message.trim(),
				...(spriteId ? { spriteRef: walkRef(spriteId) } : {}),
			});
		} else {
			// warp: 飛び先が無ければ捨てる（警告）。壁の中なら補正
			if (entity.toCol === undefined || entity.toRow === undefined) {
				warnings.push(`entities[${i}] (warp): toCol/toRow が無いため無視しました`);
				continue;
			}
			const dest = fixPosition(`entities[${i}] (warp の飛び先)`, entity.toCol, entity.toRow);
			if (!dest) continue;
			objects.push({
				...base,
				emoji: entity.emoji || "🌀",
				objType: "warp",
				warpTarget: { col: dest.col, row: dest.row },
			});
			warpTargets.push({ col: pos.col, row: pos.row, toCol: dest.col, toRow: dest.row });
		}
	}

	if (errors.length > 0 || !start) {
		return { manifest: null, errors, warnings };
	}

	const manifest = {
		preset: "dq",
		engine: "rpg",
		name: concept.title,
		gravity: 0,
		friction: 1,
		player: {
			emoji: concept.playerEmoji,
			color: "#8888cc",
			speed: 3,
			jumpPower: 0,
			w: TILE_SIZE,
			h: TILE_SIZE,
			start: { x: start.col * TILE_SIZE, y: start.row * TILE_SIZE },
			spriteRef: HERO_SPRITE_REF,
		},
		tiles: Object.fromEntries(
			RPG_TILES.map((t) => [
				String(t.id),
				{
					name: t.name,
					color: t.color,
					passable: t.passable,
					...(t.special ? { special: t.special } : {}),
					...(t.spriteId ? { imageUrl: rpgTileImageUrl(t.spriteId) } : {}),
				},
			]),
		),
		map: parsed.map,
		objects,
		bgm: RPG_BGM[concept.mood] ?? RPG_BGM.dream,
		sfx: { ...RPG_SFX },
		scroll: { worldCols: parsed.cols, worldRows: RPG_ROWS },
		titleScreen: {
			enabled: true,
			heading: concept.title,
			subtitle: concept.subtitle || undefined,
			textColor: "#ccccee",
			menu: [{ kind: "newGame", label: "ゆめをみる" }],
		},
		ending: {
			enabled: true,
			heading: "めがさめた",
			message: concept.endingMessage,
			textColor: "#ccccee",
		},
	};

	return { manifest, errors, warnings };
}

/** number[][] → ASCII（ログ表示用） */
export function renderRpgAsciiMap(map: number[][]): string {
	const idToChar = new Map<number, string>();
	for (const [ch, t] of RPG_CHAR_TO_TILE) idToChar.set(t.id, ch);
	return map.map((row) => row.map((id) => idToChar.get(id) ?? "?").join("")).join("\n");
}
