// unj-reze へのゲーム投稿クライアント。
// POST /api/games { preset, title, manifest, creatorSlug } → 201 でゲームレコード作成。
// （投稿されたゲームをタイムラインに出すには、返ってきた gameId を付けて
//   ポストを作成する必要がある点に注意。ここではゲーム作成までを担当する）

export interface GamePostPayload {
	preset: string;
	title: string;
	manifest: unknown;
	creatorSlug?: string;
}

export interface CreatedGame {
	id: string | number;
	[key: string]: unknown;
}

export function unjRezeBaseUrl(): string {
	return (process.env.UNJ_REZE_API_BASE ?? "http://localhost:3000").replace(/\/$/, "");
}

export async function postGame(payload: GamePostPayload): Promise<CreatedGame> {
	const url = `${unjRezeBaseUrl()}/api/games`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`unj-reze API error (${res.status}): ${text.slice(0, 300)}`);
		}
		return (await res.json()) as CreatedGame;
	} finally {
		clearTimeout(timeout);
	}
}
