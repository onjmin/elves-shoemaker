const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:1234/v1";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "not-needed";
const LLM_MODEL = process.env.LLM_MODEL ?? "local-model"; // Ollamaなどはモデル名指定が必須

const EMBED_BASE_URL = process.env.EMBED_API_BASE ?? "http://localhost:1234/v1";
const EMBED_MODEL = process.env.EMBED_MODEL_NAME ?? "local-model";

export interface LLMOutput {
	content: string;
	parsed?: unknown;
}

export const llm = {
	async complete(prompt: string): Promise<string> {
		const res = await this.ask(prompt);
		return res.content.trim();
	},

	async completeAsJson(prompt: string): Promise<{ data: object | null; error: string | null }> {
		const res = await this.ask(prompt);
		return repairAndParseJSON(res.content);
	},

	async ask(prompt: string): Promise<LLMOutput> {
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
				temperature: 0,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`LLM API Error (${response.status}): ${errorText}`);
		}

		const json = await response.json();
		const content = json.choices[0].message.content || "";

		return { content };
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
