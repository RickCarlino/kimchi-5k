import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Concern = { rank: number; key: "def" | "pos"; why: string };
type DefinitionEntry = {
  def: string | null;
  term: string;
  lemma?: string;
  pos: string;
  defRequestId: string;
  createdAt: string;
  llmCheckOn?: string;
  concerns?: Concern[];
};

type DefinitionRecord = Record<string, DefinitionEntry>;

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");

const load = async (): Promise<DefinitionRecord> => {
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  return JSON.parse(raw) as DefinitionRecord;
};

const pct = (part: number, total: number) => (total === 0 ? 0 : Math.round((part / total) * 1000) / 10);

const main = async () => {
  const data = await load();
  const entries = Object.values(data);
  const total = entries.length;

  let missingDef = 0;
  let needsCorrections = 0;
  let ok = 0;
  let unchecked = 0;

  for (const entry of entries) {
    const hasConcerns = Array.isArray(entry.concerns) && entry.concerns.length > 0;
    const hasDef = entry.def !== null;

    if (!hasDef) {
      missingDef += 1;
      continue;
    }
    if (!entry.llmCheckOn) {
      unchecked += 1;
    }
    if (hasConcerns) {
      needsCorrections += 1;
    } else {
      ok += 1;
    }
  }

  const result = {
    total,
    missingDef,
    needsCorrections,
    ok,
    unchecked,
    percent: {
      missingDef: pct(missingDef, total),
      needsCorrections: pct(needsCorrections, total),
      ok: pct(ok, total),
      unchecked: pct(unchecked, total),
    },
  };

  console.log(JSON.stringify(result, null, 2));
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
