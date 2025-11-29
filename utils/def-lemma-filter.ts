import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type LemmaFreq = { lemma: string; count: number };
type TermEntry = { term: string; rank: number };

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const FREQ_PATH = join(ROOT_DIR, "data", "definition-lemmas.json");
const TERMS_PATH = join(ROOT_DIR, "data", "0-terms.json");
const OUTPUT_PATH = join(ROOT_DIR, "data", "definition-lemmas-filtered.json");

const loadFreq = async (): Promise<LemmaFreq[]> => {
  const raw = await readFile(FREQ_PATH, "utf8");
  return JSON.parse(raw) as LemmaFreq[];
};

const loadTerms = async (): Promise<Set<string>> => {
  const raw = await readFile(TERMS_PATH, "utf8");
  const parsed = JSON.parse(raw) as TermEntry[];
  return new Set(parsed.map((t) => t.term));
};

const main = async () => {
  const [freq, terms] = await Promise.all([loadFreq(), loadTerms()]);

  const filtered = freq.filter(
    (item) => item.count >= 2 && item.lemma.length > 1 && !terms.has(item.lemma),
  );

  await writeFile(OUTPUT_PATH, JSON.stringify(filtered, null, 2), "utf8");

  console.log(
    `Filtered ${freq.length} → ${filtered.length} entries (removed items in terms.json or with count < 2).`,
  );
  console.log(`Wrote ${OUTPUT_PATH}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
