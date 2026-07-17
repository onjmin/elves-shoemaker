// RPGen Search（https://rpgen-search.pages.dev）の素材検索クライアント。
//
// - 検索JSON API は Bearer トークン認証（.env の RPGEN_SEARCH_TOKEN）。
//   トークン未設定時は unj-reze のサーバープロキシ（/api/rpgen/*）へフォールバックする
//   （プロキシ側がトークンを付与するため、unj-reze が起動していれば無認証で使える）。
// - 画像/音声の実体ファイルは認証不要の直リンク（CORS許可済み）。
//
// 参照: unj-reze/lib/rpgen-assets.ts, unj-reze/app/api/rpgen/[...path]/route.ts

const CDN = "https://rpgen-search.pages.dev";

const searchOrigin = () => process.env.RPGEN_SEARCH_ORIGIN ?? CDN;
const searchToken = () => process.env.RPGEN_SEARCH_TOKEN;
const unjRezeProxy = () =>
	`${(process.env.UNJ_REZE_API_BASE ?? "http://localhost:3000").replace(/\/$/, "")}/api/rpgen`;

// ───────────────── アセット実体URL / 参照文字列 ─────────────────
// 実体ファイル名は検索APIの `id`（ハッシュ文字列）。no とは別物なので必ず id を使う。

/** 単体スプライト（16x16 ドット絵）。タイル画像に使う。 */
export const spriteUrl = (id: string) => `${CDN}/data/images/sprites/${id}.png`;
/** 歩行アニメシート（2フレーム×4方向）。NPC・敵の見た目に使う。 */
export const sAnimUrl = (id: string) => `${CDN}/data/images/sAnims/${id}.png`;
/** 効果音/BGM（mp3）。 */
export const soundUrl = (id: string) => `${CDN}/data/audio/sound/${id}.mp3`;

/** タイルの imageRef（GameMaker の url: 参照） */
export const tileRef = (id: string) => `url:${spriteUrl(id)}`;
/** NPC・敵の spriteRef（歩行アニメ自動解釈） */
export const walkRef = (id: string) => `walk:auto:u:${sAnimUrl(id)}`;
/** BGM / SFX の direct 参照 */
export const soundRef = (id: string) => `direct:${soundUrl(id)}`;

// ───────────────── 検索 ─────────────────

export type RpgenKind = "sprites" | "spriteAnims" | "sounds";

const ENDPOINT: Record<RpgenKind, string> = {
	sprites: "sprites",
	spriteAnims: "sprite-anims",
	sounds: "sounds",
};

export interface RpgenSearchParams {
	q?: string;
	page?: number;
	limit?: number;
	category1?: number;
	category2?: number;
}

export interface RpgenItem {
	no: number;
	id: string;
	/** sprites/sprite-anims は name、sounds は title */
	name?: string;
	title?: string;
	comment?: string;
}

export interface RpgenSearchResult {
	data: RpgenItem[];
	/** 実APIの meta は総件数を返さない（hasNext でページ送り判定する） */
	meta: { hasNext: boolean; page: number; limit: number };
}

export async function searchRpgen(
	kind: RpgenKind,
	params: RpgenSearchParams = {},
): Promise<RpgenSearchResult> {
	const usp = new URLSearchParams();
	if (params.q?.trim()) usp.set("q", params.q.trim());
	if (params.page) usp.set("page", String(params.page));
	usp.set("limit", String(params.limit ?? 20));
	if (params.category1 != null) usp.set("category1", String(params.category1));
	if (params.category2 != null) usp.set("category2", String(params.category2));

	const token = searchToken();
	// トークンがあれば上流を直接、なければ unj-reze プロキシ経由
	const base = token ? `${searchOrigin()}/api/rpgen` : unjRezeProxy();
	const url = `${base}/${ENDPOINT[kind]}?${usp.toString()}`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	try {
		// 上流（rpgen-crawler/deploy/api）は Bearer トークン + Origin/Referer の
		// ドメイン検証を行う。localhost は開発用ホストとして常に許可されているため、
		// ローカルエージェントからは localhost を名乗るのが正規の使い方。
		const devOrigin = "http://localhost:3000";
		const res = await fetch(url, {
			headers: token ? { Authorization: `Bearer ${token}`, Origin: devOrigin } : {},
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(
				`rpgen-search ${ENDPOINT[kind]} error (${res.status}): ${text.slice(0, 200)}`,
			);
		}
		return (await res.json()) as RpgenSearchResult;
	} finally {
		clearTimeout(timeout);
	}
}

/** 検索結果を「ゲームで即使える参照」つきの一覧に整形する。 */
export interface ResolvedAsset {
	id: string;
	name: string;
	comment: string;
	/** マニフェストにそのまま書ける参照文字列 */
	ref: string;
	/** プレビュー用の実体URL */
	url: string;
}

export function resolveAssets(kind: RpgenKind, items: RpgenItem[]): ResolvedAsset[] {
	return items.map((item) => {
		const name = item.name ?? item.title ?? "";
		switch (kind) {
			case "sprites":
				return {
					id: item.id,
					name,
					comment: item.comment ?? "",
					ref: tileRef(item.id),
					url: spriteUrl(item.id),
				};
			case "spriteAnims":
				return {
					id: item.id,
					name,
					comment: item.comment ?? "",
					ref: walkRef(item.id),
					url: sAnimUrl(item.id),
				};
			default:
				return {
					id: item.id,
					name,
					comment: item.comment ?? "",
					ref: soundRef(item.id),
					url: soundUrl(item.id),
				};
		}
	});
}
