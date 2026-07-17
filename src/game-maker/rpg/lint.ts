// ウォーキングシミュレーター用のセマンティックリント。
// 4方向歩行＋ワープを辺とした BFS で「散策できるか」を検証する。

import type { RpgManifest } from "./schema";

export interface RpgLintResult {
	errors: string[];
	warnings: string[];
}

const TILE_SIZE = 32;

export function lintRpgManifest(m: RpgManifest): RpgLintResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const rows = m.map.length;
	const cols = m.map[0]?.length ?? 0;
	if (rows === 0 || cols === 0) return { errors: ["マップが空です"], warnings };

	const tile = (c: number, r: number) => m.tiles[String(m.map[r]?.[c] ?? 0)];
	const passable = (c: number, r: number) => {
		if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
		return tile(c, r)?.passable !== false;
	};

	const startCol = Math.round(m.player.start.x / TILE_SIZE);
	const startRow = Math.round(m.player.start.y / TILE_SIZE);
	if (!passable(startCol, startRow)) {
		errors.push(`開始位置 (${startCol}, ${startRow}) が壁の中です`);
		return { errors, warnings };
	}

	// ワープの辺（踏むと飛ぶ）
	const warpEdges = new Map<number, { col: number; row: number }>();
	const key = (c: number, r: number) => r * cols + c;
	for (const o of m.objects) {
		const obj = o as {
			objType?: string;
			warpTarget?: { col: number; row: number };
			col: number;
			row: number;
		};
		if (obj.objType === "warp" && obj.warpTarget) {
			warpEdges.set(key(obj.col, obj.row), obj.warpTarget);
		}
	}

	// BFS（4方向歩行＋ワープ）
	const visited = new Set<number>([key(startCol, startRow)]);
	const queue: [number, number][] = [[startCol, startRow]];
	while (queue.length > 0) {
		const [c, r] = queue.shift() as [number, number];
		const nexts: [number, number][] = [
			[c + 1, r],
			[c - 1, r],
			[c, r + 1],
			[c, r - 1],
		];
		const warp = warpEdges.get(key(c, r));
		if (warp) nexts.push([warp.col, warp.row]);
		for (const [nc, nr] of nexts) {
			if (!passable(nc, nr) || visited.has(key(nc, nr))) continue;
			visited.add(key(nc, nr));
			queue.push([nc, nr]);
		}
	}

	// めざめの場所（goal）: あるなら到達可能でなければエラー
	let goalCount = 0;
	let goalReachable = false;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (tile(c, r)?.special === "goal") {
				goalCount++;
				if (visited.has(key(c, r))) goalReachable = true;
			}
		}
	}
	if (goalCount > 0 && !goalReachable) {
		errors.push(
			"めざめの場所 'G' に開始位置から歩いて（またはワープで）到達できません。通路をつなげてください",
		);
	}

	// NPC・ワープの到達性（隣接マス含む）
	let npcCount = 0;
	for (const o of m.objects) {
		const obj = o as {
			objType?: string;
			message?: string;
			emoji: string;
			col: number;
			row: number;
		};
		const near = [
			[obj.col, obj.row],
			[obj.col + 1, obj.row],
			[obj.col - 1, obj.row],
			[obj.col, obj.row + 1],
			[obj.col, obj.row - 1],
		].some(([c, r]) => visited.has(key(c, r)));
		if (obj.objType !== "warp" && obj.message) npcCount++;
		if (!near) {
			warnings.push(`${obj.emoji} (${obj.col}, ${obj.row}) に到達できません（孤島にいます）`);
		}
	}
	if (npcCount === 0) warnings.push("NPCが1人もいません（寂しすぎる夢になります）");

	// 散策の広さ：歩けるマスが少なすぎると警告
	if (visited.size < 60) {
		warnings.push(
			`歩ける範囲が ${visited.size} マスしかありません（狭すぎます。目安は100マス以上）`,
		);
	}

	return { errors, warnings };
}
