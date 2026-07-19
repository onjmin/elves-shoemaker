// ウォーキングシミュレーター向けの内部プロンプト。
// 凡例・ルールは catalog.ts から自動生成し、プロンプトとバリデータの乖離を防ぐ。
// ローカルLLM前提のため出力は常に「小さなJSONだけ」：コンセプト1回＋ワールドごとに1回。
// 修正プロンプトは ../prompts.ts の repairPrompt（課題全文を再掲する方式）を共用する。
//
// 指示文（ルール・出力形式の説明）は英語で書く。ローカルLLMは英語の指示追従の方が
// 総じて安定しやすいため。一方、ゲームの実際の文章（タイトル・セリフ等）は日本語の
// ゲームとして出したいので、該当キーには "in Japanese" と明記して要求する。

import { RPG_COLS, RPG_MOOD_HINTS, RPG_MOODS, RPG_ROWS, RPG_TILES } from "./catalog";
import type { RpgConcept, RpgWorldDef } from "./schema";

const tileLegend = RPG_TILES.map((t) => `  '${t.char}' = ${t.name} (${t.hint})`).join("\n");
const moodList = RPG_MOODS.map((m) => `"${m}" (${RPG_MOOD_HINTS[m]})`).join(" | ");

/** ステージ1: コンセプト（夢世界の一覧＋収集エフェクト） */
export function rpgConceptPrompt(theme: string): string {
	return `You are designing a "walking simulator" dream game in the style of Yume Nikki.
There is no combat and no enemies — the player wanders through several strange dream
worlds connected by doors. Come up with one new dream concept for the theme below.

Theme: ${theme}

## World structure
- "worlds" must have 3 to 5 entries. The first one is the "hub" (like Yume Nikki's
  Nexus) — a quiet place with doors to every other world.
- The rest are dream worlds with different moods. "theme" is one line describing what
  the player actually sees there, in Japanese (e.g. "赤い湿原に逆さまの鳥居が水面から生えている").
- "endingWorldId" is the one world (not the hub) where the "waking-up point" will be
  placed — pick the world meant to feel deepest / furthest in.
- "effects" are 0 to 3 collectible items scattered in the worlds. Picking one up can
  change how NPCs react to the player (e.g. a lantern, a small key, a wilted flower).
  "worldId" says which world each one is placed in.

Output ONLY a JSON object with the following keys. No explanation, no code fences.
Write "title", "subtitle", "endingMessage", world "name"/"theme", and effect "name" in
natural Japanese — this is a Japanese-language game.

{
  "title": "game title, in Japanese, under 20 chars, dreamlike mood",
  "subtitle": "title screen subtitle, in Japanese, under 30 chars",
  "endingMessage": "shown when the player wakes up, in Japanese, under 100 chars, wistful tone. Use \\n for line breaks",
  "playerEmoji": "one emoji for the player character",
  "worlds": [
    { "id": "nexus", "name": "hub name in Japanese", "mood": "dream", "theme": "one line of scenery, in Japanese" },
    { "id": "lowercase_english_id", "name": "world name in Japanese (~10 chars)", "mood": "night", "theme": "one line of scenery, in Japanese" }
  ],
  "effects": [
    { "id": "lowercase_english_id", "name": "item name in Japanese", "emoji": "one emoji", "worldId": "id of the world it's placed in" }
  ],
  "endingWorldId": "id of the world where the waking-up point goes"
}

"mood" must be one of: ${moodList}.`;
}

/** ステージ2: ワールドごとのマップとエンティティ */
export function rpgWorldPrompt(concept: RpgConcept, world: RpgWorldDef): string {
	const isNexus = concept.worlds[0].id === world.id;
	const isEnding = concept.endingWorldId === world.id;
	const nexusId = concept.worlds[0].id;
	const otherWorlds = concept.worlds.filter((w) => w.id !== world.id);
	const worldList = otherWorlds.map((w) => `  '${w.id}' = ${w.name} (${w.theme})`).join("\n");
	const assignedEffects = concept.effects.filter((e) => e.worldId === world.id);
	const knownEffects = concept.effects
		.map((e) => `  '${e.id}' = ${e.emoji}${e.name} (found in ${e.worldId})`)
		.join("\n");

	const doorRule = isNexus
		? `- This is the hub. Place exactly one door to every other world:
${otherWorlds.map((w) => `    { "type": "door", "toWorld": "${w.id}", ... }`).join("\n")}
- Place exactly one 'S' (player start position).`
		: `- Place exactly one door back to the hub: { "type": "door", "toWorld": "${nexusId}", ... }.
- You may add 0-1 shortcut doors to other worlds (makes the dream feel like it loops).
  Valid IDs for toWorld:
${worldList}
- Do not place 'S' (that's the hub's only).`;

	const goalRule = isEnding
		? `- This is the deepest world. Place exactly one 'G' (waking-up point) in the most
  remote spot. Stepping on it wakes the player up and ends the game.`
		: `- Do not place 'G' (that tile belongs only to world '${concept.endingWorldId}').`;

	const effectRule =
		assignedEffects.length > 0
			? `- This world must contain the following collectible effects (hide them somewhere
  not too obvious):
${assignedEffects.map((e) => `    { "type": "effect", "effectId": "${e.id}", "col": ..., "row": ..., "message": "short line shown when picked up, in Japanese" }`).join("\n")}`
			: `- This world has no assigned effects (do not use type: "effect" here).`;

	return `You are the map designer for a "walking simulator" dream game in the style of
Yume Nikki. Design one dream world, "${world.name}", for the game "${concept.title}".
Scenery: ${world.theme}
There is no combat. The player just walks, looks at the scenery, and talks to strange
inhabitants.

## How to write the map
- One character = one tile. The map must be exactly ${RPG_ROWS} rows, each row exactly
  ${RPG_COLS} characters.
- Available characters (legend):
${tileLegend}
  'S' = player start position (hub world only, on a walkable tile)

## Design rules
- Surround the whole map with 'M', 'W', or '~' so the player can't walk off the edge.
- Mix winding paths, dead ends, small rooms, and open plazas so it feels worth exploring.
- Use water ('~') and forest ('F') for scenery, and 'B' (bridge) / 'D' (door tile) /
  'o' (flowers) / 'd' (dark floor) as accents.
- At least 100 tiles must be walkable.
${goalRule}

## Entities
${doorRule}
${effectRule}
- "npc": 3 to 6 strange inhabitants, mixing two kinds:
  1. Wandering NPC — "message" is a short, mysterious one-liner in Japanese. Wanders around.
  2. Talking NPC (1-3 of these) — has "dialogue" and stands still, talking when approached.
- "warp": a whirlpool that teleports the player elsewhere in the same world when stepped
  on. 0 to 2 of these. Connecting far-apart spots makes it feel dreamlike.

## Writing "dialogue" (talking NPC conversation)
- lines: the everyday conversation (1-4 lines, each under 60 Japanese characters)
- onceLines: shown only the first time the player talks to this NPC (optional)
- choice: a single round of options (optional). "prompt" is the question, "options" has
  2-3 entries
- ifEffect: a special reaction if the player is carrying a specific effect (optional)
Known effects for this game:
${knownEffects || "  (none)"}
All dialogue text must be in Japanese. Example:
  { "type": "npc", "col": 5, "row": 8, "emoji": "👧",
    "dialogue": {
      "onceLines": ["……はじめて みる かお。", "ここは ながい ゆめの とちゅう。"],
      "lines": ["まだ いたの？"],
      "choice": { "prompt": "かえりみちを きく？", "options": [
        { "label": "きく", "lines": ["とびらは いつも うしろに ある。"] },
        { "label": "だまる", "lines": ["……そう。"] } ] }
    } }

## Output format
Output ONLY the JSON below. No explanation, no code fences.
- "asciiMap" is an array of exactly ${RPG_ROWS} strings, one per row, no embedded newlines.
- entities: col is 0-${RPG_COLS - 1}, row is 0-${RPG_ROWS - 1}.
- A door's toCol/toRow may be omitted (it will automatically land the player next to the
  matching door on the other side).
- Use at most ~15 entities total. Never output two NPCs with the same or near-identical
  dialogue/message — every NPC's text must be distinct.
- Stop as soon as you have written one JSON object. Do not continue with more JSON,
  explanation, or repeated content after it.

{
  "asciiMap": ["row 1 string", "row 2 string", ... all ${RPG_ROWS} rows],
  "entities": [
    { "type": "door", "col": 14, "row": 2, "emoji": "🚪", "toWorld": "world id" },
    { "type": "npc", "col": 5, "row": 8, "emoji": "👻", "message": "line in Japanese" },
    { "type": "warp", "col": 12, "row": 20, "toCol": 25, "toRow": 3 }
  ]
}`;
}
