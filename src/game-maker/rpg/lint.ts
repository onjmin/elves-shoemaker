// ウォーキングシミュレーター用のセマンティックリント（マルチシーン版）。
// 各シーン内は「4方向歩行＋同一シーン内ワープ」を辺とした BFS、
// シーン間は「扉（warpSceneId）」を辺としたグラフで散策可能性を検証する。

import type { RpgManifest } from "./schema";

export interface RpgLintResult {
	errors: string[];
	warnings: string[];
}

const TILE_SIZE = 32;

interface LintObject {
	objType?: string;
	message?: string;
	pages?: unknown[];
	name?: string;
	emoji: string;
	col: number;
	row: number;
	warpTarget?: { col: number; row: number };
	warpSceneId?: string;
	warpEntryCol?: number;
	warpEntryRow?: number;
}

export function lintRpgManifest(m: RpgManifest): RpgLintResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const scenes = m.scenes as {
		id: string;
		name?: string;
		map: number[][];
		objects: LintObject[];
	}[];
	if (!scenes || scenes.length === 0) return { errors: ["scenes がありません"], warnings };

	const passableOn = (map: number[][], c: number, r: number) => {
		const row = map[r];
		if (!row || c < 0 || c >= row.length) return false;
		return m.tiles[String(row[c] ?? 0)]?.passable !== false;
	};

	// 開始位置（scenes[0]）
	const startCol = Math.round(m.player.start.x / TILE_SIZE);
	const startRow = Math.round(m.player.start.y / TILE_SIZE);
	if (!passableOn(scenes[0].map, startCol, startRow)) {
		errors.push(`開始位置 (${startCol}, ${startRow}) が壁の中です`);
		return { errors, warnings };
	}

	// 各シーンへの「入口」を集める：シーン0はプレイヤー開始位置、
	// 他シーンは全扉の出現座標（warpEntryCol/Row）。
	const entries = new Map<string, { col: number; row: number }[]>();
	entries.set(scenes[0].id, [{ col: startCol, row: startRow }]);
	for (const sc of scenes) {
		for (const o of sc.objects) {
			if (!o.warpSceneId) continue;
			if (!scenes.some((s) => s.id === o.warpSceneId)) {
				errors.push(`シーン '${sc.id}' の扉が存在しないシーン '${o.warpSceneId}' を指しています`);
				continue;
			}
			const list = entries.get(o.warpSceneId) ?? [];
			list.push({ col: o.warpEntryCol ?? 0, row: o.warpEntryRow ?? 0 });
			entries.set(o.warpSceneId, list);
		}
	}

	// シーングラフ：扉を辺として scenes[0] から全シーンに到達できるか
	const reachableScenes = new Set<string>([scenes[0].id]);
	const queue = [scenes[0].id];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		const sc = scenes.find((s) => s.id === id);
		if (!sc) continue;
		for (const o of sc.objects) {
			if (o.warpSceneId && !reachableScenes.has(o.warpSceneId)) {
				reachableScenes.add(o.warpSceneId);
				queue.push(o.warpSceneId);
			}
		}
	}
	for (const sc of scenes) {
		if (!reachableScenes.has(sc.id)) {
			errors.push(`シーン '${sc.id}' に拠点からたどり着く扉がありません`);
		}
	}

	// シーン内の到達性
	let goalCount = 0;
	let goalReachable = false;
	let totalWalkable = 0;
	let totalNpc = 0;

	for (const sc of scenes) {
		const cols = sc.map[0]?.length ?? 0;
		const rows = sc.map.length;
		const key = (c: number, r: number) => r * cols + c;

		const warpEdges = new Map<number, { col: number; row: number }>();
		for (const o of sc.objects) {
			if (o.warpTarget) warpEdges.set(key(o.col, o.row), o.warpTarget);
		}

		const starts = (entries.get(sc.id) ?? []).filter((p) => passableOn(sc.map, p.col, p.row));
		if (starts.length === 0) {
			if (reachableScenes.has(sc.id)) {
				errors.push(`シーン '${sc.id}' の入口（扉の出現座標）がすべて壁の中です`);
			}
			continue;
		}
		const visited = new Set<number>();
		const bfs: [number, number][] = [];
		for (const s of starts) {
			if (visited.has(key(s.col, s.row))) continue;
			visited.add(key(s.col, s.row));
			bfs.push([s.col, s.row]);
		}
		while (bfs.length > 0) {
			const [c, r] = bfs.shift() as [number, number];
			const nexts: [number, number][] = [
				[c + 1, r],
				[c - 1, r],
				[c, r + 1],
				[c, r - 1],
			];
			const warp = warpEdges.get(key(c, r));
			if (warp) nexts.push([warp.col, warp.row]);
			for (const [nc, nr] of nexts) {
				if (!passableOn(sc.map, nc, nr) || visited.has(key(nc, nr))) continue;
				visited.add(key(nc, nr));
				bfs.push([nc, nr]);
			}
		}
		totalWalkable += visited.size;

		// めざめの場所（goal）
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				if (m.tiles[String(sc.map[r]?.[c] ?? 0)]?.special === "goal") {
					goalCount++;
					if (visited.has(key(c, r))) goalReachable = true;
				}
			}
		}

		// オブジェクトの到達性（隣接マス含む）
		for (const o of sc.objects) {
			const near = [
				[o.col, o.row],
				[o.col + 1, o.row],
				[o.col - 1, o.row],
				[o.col, o.row + 1],
				[o.col, o.row - 1],
			].some(([c, r]) => visited.has(key(c, r)));
			const isNpc = !o.warpSceneId && !o.warpTarget && (o.message || o.pages);
			if (isNpc) totalNpc++;
			if (!near) {
				if (o.warpSceneId) {
					errors.push(`シーン '${sc.id}' の扉 ${o.emoji} (${o.col}, ${o.row}) に到達できません`);
				} else {
					warnings.push(
						`シーン '${sc.id}' の ${o.emoji} (${o.col}, ${o.row}) に到達できません（孤島にいます）`,
					);
				}
			}
		}
	}

	if (goalCount === 0) {
		warnings.push("めざめの場所 'G' が無いため、クリアの無い永遠の散策マップになります");
	} else if (!goalReachable) {
		errors.push(
			"めざめの場所 'G' に開始位置から歩いて（扉・ワープ経由でも）到達できません。通路をつなげてください",
		);
	}
	if (goalCount > 1) {
		warnings.push(`めざめの場所 'G' が ${goalCount} 個あります（1つを推奨）`);
	}

	if (totalNpc === 0) warnings.push("NPCが1人もいません（寂しすぎる夢になります）");
	if (totalWalkable < 250) {
		warnings.push(
			`全ワールドの歩ける範囲の合計が ${totalWalkable} マスしかありません（目安は250マス以上）`,
		);
	}

	// 収集エフェクト：宣言されたが置かれていないもの
	const items = (m.items ?? []) as { id: string; name: string }[];
	if (items.length > 0) {
		const placed = new Set<string>();
		for (const sc of scenes) {
			for (const o of sc.objects) {
				const pages = o.pages as { commands?: { type?: string; itemId?: string }[] }[] | undefined;
				for (const p of pages ?? []) {
					for (const cmd of p.commands ?? []) {
						if (cmd.type === "giveItem" && cmd.itemId) placed.add(cmd.itemId);
					}
				}
			}
		}
		for (const it of items) {
			if (!placed.has(it.id)) {
				warnings.push(`エフェクト '${it.id}'（${it.name}）がどのワールドにも置かれていません`);
			}
		}
	}

	return { errors, warnings };
}
