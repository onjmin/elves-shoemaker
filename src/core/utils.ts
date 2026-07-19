/**
 * LLMの入力制限に合わせてテキストを切り詰め、
 * 省略されたことを示すフラグを付与する
 */
export const truncateForPrompt = (input: string, limit: number) => {
	return input.length > limit ? `${input.substring(0, limit)}... (truncated)` : input;
};

/**
 * 英語メッセージに数詞つきの名詞を埋め込むとき、単数/複数を手打ちで間違えがちなので
 * （"1 doors" のような余分な s 等）自動で正しい形にする。
 * 不規則複数形は irregularPlural を渡す（例: plural(n, "child", "children")）。
 */
export const plural = (count: number, singular: string, irregularPlural?: string): string => {
	const noun = count === 1 ? singular : (irregularPlural ?? `${singular}s`);
	return `${count} ${noun}`;
};
