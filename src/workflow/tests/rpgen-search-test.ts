// RPGen Search クライアントのスモークテスト（要 RPGEN_SEARCH_TOKEN または unj-reze 起動）。
// 実APIに対して3種の検索を行い、参照文字列の組み立てまで確認する。

import "dotenv/config";
import { resolveAssets, searchRpgen } from "../../game-maker/rpgen";

async function main() {
	const mode = process.env.RPGEN_SEARCH_TOKEN ? "直接（Bearer トークン）" : "unj-reze プロキシ経由";
	console.log(`--- RPGen Search テスト（${mode}） ---`);

	const cases = [
		{ kind: "spriteAnims", q: "スライム" },
		{ kind: "sprites", q: "草" },
		{ kind: "sounds", q: "爆発" },
	] as const;

	let failed = 0;
	for (const c of cases) {
		try {
			const result = await searchRpgen(c.kind, { q: c.q, limit: 3 });
			const items = resolveAssets(c.kind, result.data);
			console.log(`✓ ${c.kind} "${c.q}": ${items.length}件${result.meta.hasNext ? "+" : ""}`);
			for (const item of items) {
				console.log(`    ${item.name || "(無題)"} [${item.id}] → ${item.ref}`);
			}
		} catch (err) {
			failed++;
			console.error(`✗ ${c.kind} "${c.q}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (failed > 0) {
		console.error(`\n${failed} 件失敗しました`);
		process.exit(1);
	}
	console.log("\nすべての検索が成功しました 🎉");
}

main();
