// ASCII マップ（LLMが出力）→ number[][]（マニフェスト形式）の変換。
// 20×15 の数値グリッドを LLM に直接書かせるとトークン数と誤り率が跳ね上がるため、
// 1文字=1マスの ASCII 表現を採用する。凡例は catalog.ts の ACTION_TILES.char。

import { CHAR_TO_TILE, ROWS, START_CHAR } from "./catalog";

export interface ParsedAsciiMap {
	map: number[][];
	cols: number;
	start: { col: number; row: number } | null;
	goals: { col: number; row: number }[];
	errors: string[];
	warnings: string[];
}

/**
 * ASCII 行の配列をタイルIDグリッドへ変換する。
 * ローカルLLMの出力ブレ（行の長さ不揃い・行数過不足）はある程度ここで吸収し、
 * 吸収できたものは warnings、できないものは errors として返す。
 */
export function parseAsciiMap(rows: string[]): ParsedAsciiMap {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 行数を ROWS(15) に正規化する。少なければ上に空行を足し、多ければ上から捨てる
	// （地面は下端にあるため、下側を保存するのが安全）。
	let lines = [...rows];
	if (lines.length < ROWS) {
		warnings.push(`行数が ${lines.length} 行しかないため、上に空行を追加して15行にしました`);
		while (lines.length < ROWS) lines.unshift("");
	} else if (lines.length > ROWS) {
		warnings.push(`行数が ${lines.length} 行あるため、上の行を削って15行にしました`);
		lines = lines.slice(lines.length - ROWS);
	}

	// 列数は最長行に合わせ、短い行は「行末の文字」で埋める（地面の行が途切れて
	// 意図しない穴ができるのを防ぐ。空行は '.' で埋める）。
	const cols = Math.max(...lines.map((l) => l.length), 1);
	lines = lines.map((l, i) => {
		if (l.length === cols) return l;
		const pad = l.length > 0 ? l[l.length - 1] : ".";
		if (l.length > 0) warnings.push(`行${i + 1}が${l.length}文字のため '${pad}' で右埋めしました`);
		return l.padEnd(cols, pad);
	});

	const map: number[][] = [];
	let start: ParsedAsciiMap["start"] = null;
	const goals: ParsedAsciiMap["goals"] = [];
	const unknownChars = new Set<string>();

	for (let r = 0; r < ROWS; r++) {
		const row: number[] = [];
		for (let c = 0; c < cols; c++) {
			const ch = lines[r][c];
			if (ch === START_CHAR) {
				if (start) errors.push(`開始位置 '${START_CHAR}' が複数あります（1つだけにしてください）`);
				start = { col: c, row: r };
				row.push(0);
				continue;
			}
			const tile = CHAR_TO_TILE.get(ch);
			if (!tile) {
				unknownChars.add(ch);
				row.push(0);
				continue;
			}
			if (tile.special === "goal") goals.push({ col: c, row: r });
			row.push(tile.id);
		}
		map.push(row);
	}

	if (unknownChars.size > 0) {
		errors.push(
			`凡例にない文字が使われています: ${[...unknownChars].map((c) => `'${c}'`).join(", ")}`,
		);
	}
	if (!start) errors.push(`開始位置 '${START_CHAR}' がありません`);
	if (goals.length === 0) errors.push("ゴール旗 'G' がありません");

	return { map, cols, start, goals, errors, warnings };
}

/** number[][] → ASCII（デバッグ・ログ用の逆変換） */
export function renderAsciiMap(map: number[][]): string {
	const idToChar = new Map<number, string>();
	for (const [ch, t] of CHAR_TO_TILE) idToChar.set(t.id, ch);
	return map.map((row) => row.map((id) => idToChar.get(id) ?? "?").join("")).join("\n");
}
