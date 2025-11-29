import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type LemmaEntry = {
  rank: number;
  term: string;
  lemma?: string;
  pos: string;
  def?: unknown;
};

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const LEMMAS_PATH = join(ROOT_DIR, "data", "1-lemmas.json");
const TARGET_POS = new Set(["ADJ", "ADV", "CONJ", "NOUN", "VERB"]);

const loadLemmas = async (): Promise<LemmaEntry[]> => {
  const raw = await readFile(LEMMAS_PATH, "utf8");
  return JSON.parse(raw) as LemmaEntry[];
};

const main = async () => {
  const lemmas = await loadLemmas();
  const missingDefinitions = lemmas.filter((entry) => TARGET_POS.has(entry.pos) && !entry.def);

  missingDefinitions.forEach((entry) => {
    const lemmaPart = entry.lemma ? ` (${entry.lemma})` : "";
    console.log(`${entry.rank}\t${entry.term}${lemmaPart}\t${entry.pos}`);
  });

  console.log(`Total needing definitions: ${missingDefinitions.length}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
