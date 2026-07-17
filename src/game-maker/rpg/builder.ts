// LLM の出力（RpgConcept + ワールドごとの RpgWorldLevel）からウォーキングシミュレーターの
// マルチシーン・マニフェストを決定的に組み立てる。action 版と同じ思想：
// ゲームを壊さない逸脱は自動補正して警告、壊す逸脱だけエラーとして差し戻す。
//
// 2段階のAPI:
//   buildRpgWorld(concept, world, level)  … ワールド1つを検証・コンパイル（修正ループ用）
//   assembleRpgManifest(concept, worlds)  … 全ワールドを扉でリンクしてマニフェスト化

import { walkRef } from "../rpgen";
import {
	DOOR_DEFAULT_EMOJI,
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
	WARP_DEFAULT_EMOJI,
} from "./catalog";
import type { RpgConcept, RpgDialogue, RpgEntity, RpgWorldDef, RpgWorldLevel } from "./schema";

const uid = () => `o${Math.random().toString(36).slice(2, 9)}`;

const tileById = new Map(RPG_TILES.map((t) => [t.id, t]));

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

	return { map, cols, start, goals, errors, warnings };
}

// ── グリッドユーティリティ ─────────────────────────────────────────────────

const isPassableOn = (map: number[][], c: number, r: number): boolean => {
	const row = map[r];
	if (!row || c < 0 || c >= row.length) return false;
	return tileById.get(row[c] ?? 0)?.passable !== false;
};

/** prefCol/prefRow から近い順（チェビシェフ距離）に歩けるマスを探す。
 *  minDist を指定すると、その距離以上のマスだけを候補にする（扉の隣に降ろす用）。 */
export function findNearestPassable(
	map: number[][],
	prefCol: number,
	prefRow: number,
	minDist = 0,
): { col: number; row: number } | null {
	const cols = map[0]?.length ?? 0;
	const rows = map.length;
	for (let d = minDist; d < Math.max(cols, rows); d++) {
		for (let dc = -d; dc <= d; dc++) {
			for (let dr = -d; dr <= d; dr++) {
				if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
				const c = prefCol + dc;
				const r = prefRow + dr;
				if (isPassableOn(map, c, r)) return { col: c, row: r };
			}
		}
	}
	return null;
}

/** 4方向歩行＋ワープ辺のBFSで到達集合を求める。キーは row*cols+col。 */
export function computeWalkable(
	map: number[][],
	starts: { col: number; row: number }[],
	warpEdges: { from: { col: number; row: number }; to: { col: number; row: number } }[] = [],
): Set<number> {
	const cols = map[0]?.length ?? 0;
	const key = (c: number, r: number) => r * cols + c;
	const warpMap = new Map<number, { col: number; row: number }>();
	for (const e of warpEdges) warpMap.set(key(e.from.col, e.from.row), e.to);

	const visited = new Set<number>();
	const queue: [number, number][] = [];
	for (const s of starts) {
		if (!isPassableOn(map, s.col, s.row) || visited.has(key(s.col, s.row))) continue;
		visited.add(key(s.col, s.row));
		queue.push([s.col, s.row]);
	}
	while (queue.length > 0) {
		const [c, r] = queue.shift() as [number, number];
		const nexts: [number, number][] = [
			[c + 1, r],
			[c - 1, r],
			[c, r + 1],
			[c, r - 1],
		];
		const warp = warpMap.get(key(c, r));
		if (warp) nexts.push([warp.col, warp.row]);
		for (const [nc, nr] of nexts) {
			if (!isPassableOn(map, nc, nr) || visited.has(key(nc, nr))) continue;
			visited.add(key(nc, nr));
			queue.push([nc, nr]);
		}
	}
	return visited;
}

// ── 会話イベント → EventPage コンパイル ───────────────────────────────────

type EventCommandDraft = Record<string, unknown>;
interface EventPageDraft {
	name?: string;
	conditions: Record<string, unknown>;
	commands: EventCommandDraft[];
}

const msgCmd = (text: string): EventCommandDraft => ({ type: "message", text });

/** 会話DSL → エンジンの EventPage 配列。先頭ページから条件マッチで選ばれるため、
 *  「エフェクト反応 → はじめて → ふだん」の順に並べる。 */
export function compileDialogue(dialogue: RpgDialogue): EventPageDraft[] {
	const pages: EventPageDraft[] = [];
	if (dialogue.ifEffect) {
		pages.push({
			name: "エフェクト反応",
			conditions: { itemId: dialogue.ifEffect.effectId, hasItem: true },
			commands: dialogue.ifEffect.lines.map(msgCmd),
		});
	}
	if (dialogue.onceLines) {
		pages.push({
			name: "はじめて",
			conditions: { selfSwitchId: "A", selfSwitchValue: false },
			commands: [
				...dialogue.onceLines.map(msgCmd),
				{ type: "setSelfSwitch", id: "A", value: true },
			],
		});
	}
	const defaultCommands: EventCommandDraft[] = dialogue.lines.map(msgCmd);
	if (dialogue.choice) {
		defaultCommands.push({
			type: "choice",
			text: dialogue.choice.prompt,
			choices: dialogue.choice.options.map((o) => ({
				label: o.label,
				commands: o.lines.map(msgCmd),
			})),
		});
	}
	pages.push({ name: "ふだん", conditions: {}, commands: defaultCommands });
	return pages;
}

// ── ワールド単位のビルド（修正ループの検証を兼ねる） ─────────────────────────

export interface DoorSpec {
	objId: string;
	col: number;
	row: number;
	toWorld: string;
	toCol?: number;
	toRow?: number;
	emoji: string;
}

export interface BuiltWorld {
	def: RpgWorldDef;
	map: number[][];
	cols: number;
	rows: number;
	/** 拠点のみ非null */
	start: { col: number; row: number } | null;
	/** エンディングワールドのみ非null */
	goal: { col: number; row: number } | null;
	/** npc / warp / effect のオブジェクト（door は assemble でリンク後に追加） */
	objects: Record<string, unknown>[];
	doors: DoorSpec[];
	warpEdges: { from: { col: number; row: number }; to: { col: number; row: number } }[];
	/** BFS起点：拠点は S、それ以外は拠点への扉 */
	anchor: { col: number; row: number };
	/** anchor からの到達集合 */
	walkable: Set<number>;
}

export interface RpgWorldBuildResult {
	world: BuiltWorld | null;
	errors: string[];
	warnings: string[];
}

export function buildRpgWorld(
	concept: RpgConcept,
	worldDef: RpgWorldDef,
	level: RpgWorldLevel,
): RpgWorldBuildResult {
	const isNexus = concept.worlds[0].id === worldDef.id;
	const isEnding = concept.endingWorldId === worldDef.id;
	const worldIds = concept.worlds.map((w) => w.id);
	const parsed = parseRpgAsciiMap(level.asciiMap);
	const errors = [...parsed.errors];
	const warnings = [...parsed.warnings];
	const map = parsed.map;

	// 開始位置 S：拠点だけが持つ
	let start = parsed.start;
	if (isNexus && !start) {
		errors.push(`拠点ワールドには開始位置 '${RPG_START_CHAR}' が必要です（歩けるマスに1つ）`);
	}
	if (!isNexus && start) {
		warnings.push(`開始位置 '${RPG_START_CHAR}' は拠点ワールド専用のため無視しました`);
		start = null;
	}

	// めざめの場所 G：エンディングワールドにちょうど1つ
	let goal: { col: number; row: number } | null = null;
	if (isEnding) {
		if (parsed.goals.length !== 1) {
			errors.push(
				`このワールドはめざめの場所 'G' をちょうど1つ持つ必要があります（現在 ${parsed.goals.length} 個）`,
			);
		} else {
			goal = parsed.goals[0];
		}
	} else if (parsed.goals.length > 0) {
		warnings.push(
			`めざめの場所 'G' はワールド '${concept.endingWorldId}' 専用のため、草原に置き換えました`,
		);
		for (const g of parsed.goals) map[g.row][g.col] = 0;
	}

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
		if (!isPassableOn(map, col, row)) {
			const moved = findNearestPassable(map, col, row);
			if (!moved) return null;
			warnings.push(
				`${label}: (${col}, ${row}) が壁の中のため (${moved.col}, ${moved.row}) に移動しました`,
			);
			col = moved.col;
			row = moved.row;
		}
		return { col, row };
	};

	if (start) {
		const fixed = fixPosition(`開始位置 '${RPG_START_CHAR}'`, start.col, start.row);
		if (fixed) start = fixed;
	}

	// このワールドに割り当てられたエフェクト
	const assignedEffects = concept.effects.filter((e) => e.worldId === worldDef.id);
	const effectById = new Map(concept.effects.map((e) => [e.id, e]));

	const objects: Record<string, unknown>[] = [];
	const doors: DoorSpec[] = [];
	const warpEdges: BuiltWorld["warpEdges"] = [];
	const placedEffects = new Set<string>();
	const npcSpots: { col: number; row: number; emoji: string }[] = [];

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
			const emoji = entity.emoji || "👤";
			const spriteId = NPC_SPRITE_BY_EMOJI[emoji];
			const sprite = spriteId ? { spriteRef: walkRef(spriteId) } : {};
			if (entity.dialogue) {
				// 会話イベントNPC：その場に立たせる。objType は付けない
				// （dq.ts の王様と同じ「体のあるモブ + pages」。objType: 'event' は
				//   すり抜け対象になるため、体で触れる/話しかけると発動する形にする）
				objects.push({
					...base,
					emoji,
					pages: compileDialogue(entity.dialogue),
					...sprite,
				});
				if (entity.dialogue.ifEffect && !effectById.has(entity.dialogue.ifEffect.effectId)) {
					errors.push(
						`entities[${i}] (npc): dialogue.ifEffect.effectId '${entity.dialogue.ifEffect.effectId}' はコンセプトで宣言されていません`,
					);
				}
			} else if (entity.message?.trim()) {
				// つぶやきNPC：頭上メッセージでふらふら歩く
				objects.push({
					...base,
					emoji,
					behavior: "random",
					speed: 0.6,
					message: entity.message.trim(),
					...sprite,
				});
			} else {
				errors.push(`entities[${i}] (npc): message（一言）か dialogue（会話イベント）が必須です`);
				continue;
			}
			npcSpots.push({ col: pos.col, row: pos.row, emoji });
		} else if (entity.type === "warp") {
			if (entity.toCol === undefined || entity.toRow === undefined) {
				warnings.push(`entities[${i}] (warp): toCol/toRow が無いため無視しました`);
				continue;
			}
			const dest = fixPosition(`entities[${i}] (warp の飛び先)`, entity.toCol, entity.toRow);
			if (!dest) continue;
			objects.push({
				...base,
				emoji: entity.emoji || WARP_DEFAULT_EMOJI,
				objType: "warp",
				warpTarget: { col: dest.col, row: dest.row },
			});
			warpEdges.push({ from: pos, to: dest });
		} else if (entity.type === "door") {
			if (!entity.toWorld || !worldIds.includes(entity.toWorld)) {
				errors.push(
					`entities[${i}] (door): toWorld '${entity.toWorld ?? ""}' が不正です（${worldIds.join(", ")} から選ぶ）`,
				);
				continue;
			}
			if (entity.toWorld === worldDef.id) {
				errors.push(`entities[${i}] (door): toWorld が自分自身です（warp を使ってください）`);
				continue;
			}
			doors.push({
				objId: uid(),
				col: pos.col,
				row: pos.row,
				toWorld: entity.toWorld,
				toCol: entity.toCol,
				toRow: entity.toRow,
				emoji: entity.emoji || DOOR_DEFAULT_EMOJI,
			});
		} else {
			// effect
			const def = entity.effectId ? effectById.get(entity.effectId) : undefined;
			if (!def) {
				errors.push(
					`entities[${i}] (effect): effectId '${entity.effectId ?? ""}' はコンセプトで宣言されていません`,
				);
				continue;
			}
			if (def.worldId !== worldDef.id) {
				errors.push(
					`entities[${i}] (effect): '${def.id}' はワールド '${def.worldId}' に置くものです`,
				);
				continue;
			}
			if (placedEffects.has(def.id)) {
				warnings.push(`entities[${i}] (effect): '${def.id}' が重複配置されたため無視しました`);
				continue;
			}
			placedEffects.add(def.id);
			const obtainText = entity.message?.trim() || `${def.emoji}『${def.name}』を ひろった。`;
			objects.push({
				...base,
				emoji: def.emoji,
				name: def.name,
				objType: "event",
				pages: [
					{
						name: "入手済み",
						conditions: { selfSwitchId: "A", selfSwitchValue: true },
						commands: [{ type: "overheadMessage", text: "……ここに なにかが あった気がする。" }],
					},
					{
						name: "入手",
						conditions: {},
						commands: [
							{ type: "message", text: obtainText },
							{ type: "giveItem", itemId: def.id, count: 1 },
							{ type: "setSelfSwitch", id: "A", value: true },
						],
					},
				],
			});
		}
	}

	// 割り当てエフェクトの置き忘れ
	for (const def of assignedEffects) {
		if (!placedEffects.has(def.id)) {
			errors.push(
				`エフェクト '${def.id}'（${def.emoji}${def.name}）をこのワールドに配置してください（type: "effect"）`,
			);
		}
	}

	// 扉の構造ルール：拠点は全ワールドへ、他は拠点へ戻れること
	if (isNexus) {
		const covered = new Set(doors.map((d) => d.toWorld));
		const missing = worldIds.slice(1).filter((id) => !covered.has(id));
		if (missing.length > 0) {
			errors.push(
				`拠点ワールドには全ワールドへの扉が必要です。不足: ${missing.map((m) => `'${m}'`).join(", ")}`,
			);
		}
	} else {
		const nexusId = worldIds[0];
		if (!doors.some((d) => d.toWorld === nexusId)) {
			errors.push(`拠点 '${nexusId}' へ戻る扉（type: "door", toWorld: "${nexusId}"）が必要です`);
		}
	}

	if (errors.length > 0) {
		return { world: null, errors, warnings };
	}

	// BFS起点：拠点は S、それ以外は「拠点へ戻る扉」の位置
	const nexusDoor = doors.find((d) => d.toWorld === worldIds[0]);
	const anchor = isNexus ? (start as { col: number; row: number }) : (nexusDoor as DoorSpec); // 上の検証で存在保証
	const walkable = computeWalkable(map, [{ col: anchor.col, row: anchor.row }], warpEdges);
	const key = (c: number, r: number) => r * parsed.cols + c;

	// 到達性の検証（エラー＝散策が壊れる、警告＝寂しいだけ）
	for (const d of doors) {
		if (!walkable.has(key(d.col, d.row))) {
			errors.push(`扉 (${d.col}, ${d.row}) → '${d.toWorld}' に歩いて到達できません（孤島）`);
		}
	}
	if (goal && !walkable.has(key(goal.col, goal.row))) {
		errors.push(
			`めざめの場所 'G' (${goal.col}, ${goal.row}) に到達できません。通路をつなげてください`,
		);
	}
	for (const o of objects) {
		const obj = o as { objType?: string; emoji: string; name?: string; col: number; row: number };
		const near = [
			[obj.col, obj.row],
			[obj.col + 1, obj.row],
			[obj.col - 1, obj.row],
			[obj.col, obj.row + 1],
			[obj.col, obj.row - 1],
		].some(([c, r]) => walkable.has(key(c, r)));
		if (near) continue;
		if (obj.objType === "event" && obj.name) {
			errors.push(`エフェクト '${obj.name}' (${obj.col}, ${obj.row}) に到達できません`);
		} else {
			warnings.push(`${obj.emoji} (${obj.col}, ${obj.row}) に到達できません（孤島にいます）`);
		}
	}
	// その場に立つ会話NPCは体で通行をふさぐ（すり抜け不可のモブ）。
	// NPCのマスを壁扱いにしても扉・Gへ到達できることを確認する（1マス幅通路の栓を防ぐ）
	const standingNpcs = objects.filter(
		(o) =>
			(o as { pages?: unknown[]; objType?: string }).pages !== undefined &&
			(o as { objType?: string }).objType === undefined,
	) as { col: number; row: number; emoji: string }[];
	if (standingNpcs.length > 0) {
		const blockedMap = map.map((r) => [...r]);
		for (const n of standingNpcs) blockedMap[n.row][n.col] = 1; // 山＝通行不可
		const walkable2 = computeWalkable(
			blockedMap,
			[{ col: anchor.col, row: anchor.row }],
			warpEdges,
		);
		for (const d of doors) {
			if (walkable.has(key(d.col, d.row)) && !walkable2.has(key(d.col, d.row))) {
				errors.push(
					`会話NPCが通路をふさいでいて、扉 (${d.col}, ${d.row}) → '${d.toWorld}' に行けなくなります。NPCを広い場所に移動してください`,
				);
			}
		}
		if (goal && walkable.has(key(goal.col, goal.row)) && !walkable2.has(key(goal.col, goal.row))) {
			errors.push(
				`会話NPCが通路をふさいでいて、めざめの場所 'G' に行けなくなります。NPCを広い場所に移動してください`,
			);
		}
	}
	// ワープの飛び先が行き止まり（扉にもGにも戻れない袋小路）だと詰むためエラー
	for (const e of warpEdges) {
		const fromDest = computeWalkable(map, [e.to], warpEdges);
		const canEscape =
			doors.some((d) => fromDest.has(key(d.col, d.row))) ||
			(goal !== null && fromDest.has(key(goal.col, goal.row)));
		if (!canEscape) {
			errors.push(
				`warp の飛び先 (${e.to.col}, ${e.to.row}) から扉やめざめの場所に戻れません（詰みます）`,
			);
		}
	}

	if (walkable.size < 60) {
		warnings.push(`歩ける範囲が ${walkable.size} マスしかありません（目安は100マス以上）`);
	}
	if (npcSpots.length === 0) {
		warnings.push("NPCが1人もいません（寂しすぎる夢になります）");
	}

	if (errors.length > 0) {
		return { world: null, errors, warnings };
	}

	return {
		world: {
			def: worldDef,
			map,
			cols: parsed.cols,
			rows: RPG_ROWS,
			start,
			goal,
			objects,
			doors,
			warpEdges,
			anchor: { col: anchor.col, row: anchor.row },
			walkable,
		},
		errors,
		warnings,
	};
}

// ── 全ワールドのリンクとマニフェスト組み立て ────────────────────────────────

export interface RpgAssembleResult {
	manifest: Record<string, unknown> | null;
	errors: string[];
	warnings: string[];
}

export function assembleRpgManifest(concept: RpgConcept, worlds: BuiltWorld[]): RpgAssembleResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const byId = new Map(worlds.map((w) => [w.def.id, w]));
	for (const def of concept.worlds) {
		if (!byId.has(def.id)) errors.push(`ワールド '${def.id}' のビルド結果がありません`);
	}
	const nexus = byId.get(concept.worlds[0].id);
	if (!nexus?.start) {
		errors.push("拠点ワールドの開始位置がありません");
	}
	if (errors.length > 0) return { manifest: null, errors, warnings };
	const start = (nexus as BuiltWorld).start as { col: number; row: number };

	/** ワールドWへの「安全な降着点」：W内の相手ワールド行き扉の隣（W の到達集合内） */
	const arrivalNear = (w: BuiltWorld, door: { col: number; row: number }) => {
		const spot = findNearestPassable(w.map, door.col, door.row, 1);
		const key = (c: number, r: number) => r * w.cols + c;
		if (spot && w.walkable.has(key(spot.col, spot.row))) return spot;
		return { col: door.col, row: door.row };
	};
	/** ワールドWのフォールバック降着点（明示座標が不正なとき用） */
	const fallbackArrival = (w: BuiltWorld) => {
		if (w.start) return w.start;
		return arrivalNear(w, w.anchor);
	};

	// 扉オブジェクトを生成してシーンに追加
	for (const w of worlds) {
		for (const d of w.doors) {
			const target = byId.get(d.toWorld) as BuiltWorld;
			const tKey = (c: number, r: number) => r * target.cols + c;
			let entry: { col: number; row: number } | null = null;
			if (d.toCol !== undefined && d.toRow !== undefined) {
				const clamped = {
					col: Math.min(Math.max(d.toCol, 0), target.cols - 1),
					row: Math.min(Math.max(d.toRow, 0), target.rows - 1),
				};
				const fixed = isPassableOn(target.map, clamped.col, clamped.row)
					? clamped
					: findNearestPassable(target.map, clamped.col, clamped.row);
				if (fixed && target.walkable.has(tKey(fixed.col, fixed.row))) {
					entry = fixed;
				} else {
					warnings.push(
						`扉 '${w.def.id}'→'${d.toWorld}' の出現座標 (${d.toCol}, ${d.toRow}) が孤島のため安全な位置へ変更しました`,
					);
				}
			}
			if (!entry) {
				// 相手側にある「こちらへ戻る扉」の隣へ降ろす（扉どうしが対になる）
				const counterpart = target.doors.find((td) => td.toWorld === w.def.id);
				entry = counterpart ? arrivalNear(target, counterpart) : fallbackArrival(target);
			}
			w.objects.push({
				id: d.objId,
				kind: "npc" as const,
				col: d.col,
				row: d.row,
				hp: 1,
				speed: 0,
				behavior: "still" as const,
				bullet: "none" as const,
				bulletSpeed: 3,
				bulletColor: "#00ffff",
				fireRate: 60,
				hazard: false,
				message: "",
				emoji: d.emoji,
				objType: "warp",
				warpSceneId: d.toWorld,
				warpEntryCol: entry.col,
				warpEntryRow: entry.row,
			});
		}
	}

	const scenes = worlds.map((w) => ({
		id: w.def.id,
		name: w.def.name,
		map: w.map,
		objects: w.objects,
		bgm: RPG_BGM[w.def.mood],
	}));

	const items = concept.effects.map((e) => ({
		id: e.id,
		name: e.name,
		emoji: e.emoji,
		description: "ゆめの なかで ひろった なにか。",
		category: "key" as const,
		consumable: false,
		discardable: false,
	}));

	const nexusScene = scenes[0];
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
		map: JSON.parse(JSON.stringify(nexusScene.map)),
		objects: JSON.parse(JSON.stringify(nexusScene.objects)),
		scenes,
		...(items.length > 0 ? { items } : {}),
		bgm: RPG_BGM[(nexus as BuiltWorld).def.mood],
		sfx: { ...RPG_SFX },
		scroll: { worldCols: (nexus as BuiltWorld).cols, worldRows: (nexus as BuiltWorld).rows },
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
