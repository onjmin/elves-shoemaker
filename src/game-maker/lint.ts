// 生成されたマニフェストの「遊べるか」検証（セマンティックリント）。
// Zod（構造検証）が通っても、ゴールに到達できない・開始位置が宙に浮いている等の
// ゲームとして壊れた出力は弾き、エラー文を LLM への修正プロンプトに流用する。

import { TILE_SIZE } from "./catalog";
import type { ActionManifest } from "./schema";

export interface LintResult {
	errors: string[];
	warnings: string[];
}

/** ジャンプ到達判定の近似パラメータ（jumpPower -8 / gravity 0.5 ≒ 2〜3マス） */
const JUMP_UP = 3; // 上方向に届くマス数
const JUMP_SPAN = 4; // 横方向に飛び越えられるマス数

export function lintActionManifest(m: ActionManifest): LintResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const rows = m.map.length;
	const cols = m.map[0]?.length ?? 0;
	if (rows === 0 || cols === 0) {
		return { errors: ["マップが空です"], warnings };
	}
	for (const [r, row] of m.map.entries()) {
		if (row.length !== cols) errors.push(`マップの行${r + 1}の列数(${row.length})が不揃いです`);
	}

	const tile = (c: number, r: number) => m.tiles[String(m.map[r]?.[c] ?? 0)];
	const passable = (c: number, r: number) => {
		if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
		return tile(c, r)?.passable !== false;
	};
	/** その足元に立てるか（下が固体タイル or すり抜け床） */
	const supported = (c: number, r: number) => {
		if (r + 1 >= rows) return false; // 最下段の下は奈落
		const below = tile(c, r + 1);
		return below !== undefined && (!below.passable || below.special === "oneway");
	};
	const standable = (c: number, r: number) => passable(c, r) && supported(c, r);

	// ── 開始位置 ────────────────────────────────────────────────────────────
	const startCol = Math.round(m.player.start.x / TILE_SIZE);
	const feetRow = Math.round(m.player.start.y / TILE_SIZE) + 1; // h=64 → 上端の1マス下が足元
	if (startCol < 0 || startCol >= cols || feetRow < 0 || feetRow >= rows) {
		errors.push("プレイヤー開始位置がマップ外です");
	} else if (!passable(startCol, feetRow)) {
		errors.push(`開始位置 (col ${startCol}) が固体タイルの中に埋まっています`);
	} else {
		// 真下3マス以内に地面がなければ開幕落下死の恐れ
		const hasGround = [1, 2, 3].some((d) => feetRow + d < rows && !passable(startCol, feetRow + d));
		if (!supported(startCol, feetRow) && !hasGround) {
			errors.push(`開始位置 (col ${startCol}) の下に地面がありません（開幕で穴に落ちます）`);
		}
	}

	// ── ゴール ──────────────────────────────────────────────────────────────
	const goals: { col: number; row: number }[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (tile(c, r)?.special === "goal") goals.push({ col: c, row: r });
		}
	}
	if (goals.length === 0) errors.push("ゴール（special: 'goal' のタイル）がありません");

	// ── 到達可能性（プラットフォーマー近似BFS） ──────────────────────────────
	// 「立てるマス」をノードとし、歩行＋ジャンプ（横JUMP_SPAN・上JUMP_UP以内）＋
	// 落下（横3マス以内・深さ無制限）で辺を張る。壁貫通を無視した過大近似なので、
	// ここで「到達不能」と出たものはほぼ確実に詰みマップ。
	if (goals.length > 0 && errors.length === 0) {
		const key = (c: number, r: number) => c * rows + r;
		const visited = new Set<number>();
		const queue: [number, number][] = [];
		// 開始マス（空中スタートなら着地点から）
		const sc = startCol;
		let sr = feetRow;
		while (sr + 1 < rows && !supported(sc, sr) && passable(sc, sr + 1)) sr++;
		if (standable(sc, sr)) {
			queue.push([sc, sr]);
			visited.add(key(sc, sr));
		}
		while (queue.length > 0) {
			const [c, r] = queue.shift() as [number, number];
			for (let dc = -JUMP_SPAN; dc <= JUMP_SPAN; dc++) {
				const nc = c + dc;
				if (nc < 0 || nc >= cols) continue;
				// 上は JUMP_UP まで、下は落下なので無制限
				for (let nr = Math.max(0, r - JUMP_UP); nr < rows; nr++) {
					if (nr > r && Math.abs(dc) > 3) break; // 遠距離の落下着地は横3マスまで
					if (!standable(nc, nr) || visited.has(key(nc, nr))) continue;
					visited.add(key(nc, nr));
					queue.push([nc, nr]);
				}
			}
		}
		const goalReached = goals.some((g) => {
			for (let dc = -2; dc <= 2; dc++) {
				for (let dr = -3; dr <= 3; dr++) {
					if (visited.has(key(g.col + dc, g.row + dr))) return true;
				}
			}
			return false;
		});
		if (!goalReached) {
			errors.push(
				"開始位置からゴール旗に到達できません（穴が広すぎる・壁が高すぎる等。ジャンプは横4マス・高さ3マスまで）",
			);
		}
	}

	// ── オブジェクト ────────────────────────────────────────────────────────
	let enemyCount = 0;
	for (const o of m.objects) {
		if (o.col >= cols || o.row >= rows) {
			errors.push(`オブジェクト ${o.emoji} (${o.col}, ${o.row}) がマップ外です`);
			continue;
		}
		if (!passable(o.col, o.row)) {
			warnings.push(`オブジェクト ${o.emoji} (${o.col}, ${o.row}) が固体タイルに埋まっています`);
		}
		if (o.hazard) {
			enemyCount++;
			if (Math.abs(o.col - startCol) <= 2 && Math.abs(o.row - feetRow) <= 2) {
				warnings.push(`敵 ${o.emoji} が開始位置のすぐそば (${o.col}, ${o.row}) にいます`);
			}
		}
	}
	if (enemyCount === 0) warnings.push("敵が1体もいません（単調なステージになります）");

	return { errors, warnings };
}
