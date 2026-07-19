import { Agent } from "undici";

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:1234/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "not-needed";
const LLM_MODEL = process.env.LLM_MODEL ?? "local-model"; // Ollamaなどはモデル名指定が必須

const EMBED_BASE_URL = process.env.EMBED_API_BASE ?? "http://localhost:1234/v1";
const EMBED_MODEL = process.env.EMBED_MODEL_NAME ?? "local-model";

export interface LLMOutput {
	content: string;
	parsed?: unknown;
}

// マルチステージのパイプライン（ワールドごとに1リクエストなど）ではLLM呼び出し回数が
// 増えるため、ローカルLLMの一時的な過負荷・タイムアウトで全体が落ちないようリトライする。
const LLM_MAX_RETRY = 3;
const LLM_RETRY_DELAY_MS = 3000;

// max_tokens を指定しないと、弱いローカルLLMが停止条件（EOS）を出せずに暴走生成することがある
// （実測: 4万トークン近く出力し続けた例あり）。生成量に上限を設けて暴走を止め、
// 上限に達して壊れたJSONになった場合は通常の検証エラーとして修正ループに乗せる。
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 6000);

// temperature:0（貪欲デコード）は、弱いローカルLLMでは「同じNPC/セリフを延々と繰り返す」
// 退行ループを誘発しやすい（実測: 同一の🌙NPCが十数体連続で出力された例あり）。
// 決定性より多様性を優先し、繰り返しに軽くペナルティを掛ける。
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.7);
const LLM_FREQUENCY_PENALTY = Number(process.env.LLM_FREQUENCY_PENALTY ?? 0.4);
const LLM_PRESENCE_PENALTY = Number(process.env.LLM_PRESENCE_PENALTY ?? 0.2);

// Node標準fetch（undici）の既定タイムアウト（headers/body 各300秒）は、CPU推論のローカルLLMには
// 不足しがちな一方、max_tokens で生成量を打ち切るようにしたため15分もの猶予は本来不要。
// 既定5分（env で調整可）とし、暴走時は max_tokens が、詰まった接続には timeout が対処する。
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 5 * 60 * 1000);
const llmDispatcher = new Agent({
	headersTimeout: LLM_TIMEOUT_MS,
	bodyTimeout: LLM_TIMEOUT_MS,
	connectTimeout: LLM_TIMEOUT_MS,
});

const isTransientNetworkError = (err: unknown): boolean =>
	err instanceof TypeError || // "fetch failed"
	(err instanceof Error &&
		typeof (err as { cause?: { code?: string } }).cause?.code === "string" &&
		((err as { cause?: { code?: string } }).cause?.code?.startsWith("UND_ERR_") ?? false));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LLM_PING_TIMEOUT_MS = 8000;

export const llm = {
	async complete(prompt: string): Promise<string> {
		const res = await this.ask(prompt);
		return res.content.trim();
	},

	async completeAsJson(
		prompt: string,
		opts?: { schema?: object; schemaName?: string },
	): Promise<{ data: object | null; error: string | null; rawContent: string }> {
		// OpenAI互換の JSON mode。schema を渡した場合は response_format: json_schema として送り、
		// 対応サーバー（LM Studio 等）ではグラマー制約付き生成になるため、
		// 「JSONの外側に説明文が混ざる」「構文が壊れる」「キーの型が違う」種類の失敗を構造的に防げる。
		// ただし cross-field 制約（例: endingWorldId が worlds に含まれる）までは表現できないため、
		// Zod検証と修正ループは従来通り必要。schema 未指定時は json_object（構文のみ保証）にフォールバック。
		const res = await this.ask(prompt, { jsonMode: true, ...opts });
		const { data, error } = repairAndParseJSON(res.content);
		return { data, error, rawContent: res.content };
	},

	/** 本番の生成リクエストを送る前に、サーバーが生きているか短いタイムアウトで確認する。
	 *  生成リクエストは最大15分×3回リトライ＝最大45分待ってから失敗を報告しうるため、
	 *  サーバーが完全に落ちている場合はこれで数秒のうちに気付けるようにする。
	 *  ただし「モデル一覧は返すが生成リクエストだけ詰まる」ケースまでは検知できない点に注意。 */
	async ping(): Promise<{ ok: boolean; error?: string }> {
		try {
			const res = await fetch(`${LLM_BASE_URL}/models`, {
				headers: { Authorization: `Bearer ${LLM_API_KEY}` },
				signal: AbortSignal.timeout(LLM_PING_TIMEOUT_MS),
			});
			if (!res.ok) {
				return { ok: false, error: `HTTP ${res.status}` };
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	},

	async ask(
		prompt: string,
		opts?: { jsonMode?: boolean; schema?: object; schemaName?: string },
	): Promise<LLMOutput> {
		let lastErr: unknown;
		for (let attempt = 1; attempt <= LLM_MAX_RETRY; attempt++) {
			const startedAt = Date.now();
			try {
				const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						// キーが空でも規格通り Bearer を送って問題ないサーバーが多いです
						Authorization: `Bearer ${LLM_API_KEY}`,
					},
					body: JSON.stringify({
						model: LLM_MODEL, // 互換性のため追加
						messages: [{ role: "user", content: prompt }],
						temperature: LLM_TEMPERATURE,
						frequency_penalty: LLM_FREQUENCY_PENALTY,
						presence_penalty: LLM_PRESENCE_PENALTY,
						max_tokens: LLM_MAX_TOKENS,
						...(opts?.jsonMode
							? opts.schema
								? {
										response_format: {
											type: "json_schema",
											json_schema: {
												name: opts.schemaName ?? "response",
												schema: opts.schema,
											},
										},
									}
								: { response_format: { type: "json_object" } }
							: {}),
					}),
					// Node標準fetch（undici）拡張の非標準オプション。型定義に無いため as で通す。
					dispatcher: llmDispatcher,
				} as RequestInit & { dispatcher: Agent });

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`LLM API Error (${response.status}): ${errorText}`);
				}

				const json = await response.json();
				const content = json.choices[0].message.content || "";

				return { content };
			} catch (err) {
				lastErr = err;
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				if (!isTransientNetworkError(err) || attempt === LLM_MAX_RETRY) throw err;
				console.log(
					`  ⚠ LLM接続エラー（${attempt}/${LLM_MAX_RETRY}、${elapsedSec}秒後に発生）: ${err instanceof Error ? err.message : String(err)} — ${LLM_RETRY_DELAY_MS}ms後にリトライします`,
				);
				await sleep(LLM_RETRY_DELAY_MS);
			}
		}
		throw lastErr;
	},
};

/**
 * 記憶・検索用（Embedding）
 */
export const embedding = {
	async create(text: string): Promise<number[]> {
		const response = await fetch(`${EMBED_BASE_URL}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${LLM_API_KEY}`,
			},
			body: JSON.stringify({
				model: EMBED_MODEL,
				input: text,
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding API Error: ${response.statusText}`);
		}

		const json = await response.json();
		return json.data[0].embedding;
	},
};

/**
 * LLMが混ぜたノイズからJSONを救出する
 */
export function repairAndParseJSON(badJson: string): { data: object | null; error: string | null } {
	try {
		// 1. そのままパース
		return { data: JSON.parse(badJson), error: null };
	} catch {
		// 2. ブラケットを探して抽出
		const start = badJson.indexOf("{");
		const end = badJson.lastIndexOf("}");

		if (start !== -1 && end !== -1 && end > start) {
			const candidate = badJson.slice(start, end + 1);
			try {
				return { data: JSON.parse(candidate), error: null };
			} catch {
				return { data: null, error: `Invalid JSON structure: ${candidate}` };
			}
		}
		return { data: null, error: "No JSON object found in response" };
	}
}
