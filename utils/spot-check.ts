import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type DefinitionEntry = {
  def: string | null;
  term: string;
  lemma?: string;
  pos: string;
  defRequestId: string;
  createdAt: string;
};

type DefinitionRecord = Record<string, DefinitionEntry>;
type DefinitionWithRank = DefinitionEntry & { rank: string };

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");

const loadDefinitionRecord = async (): Promise<DefinitionRecord> => {
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  return JSON.parse(raw) as DefinitionRecord;
};

const toArray = (record: DefinitionRecord): DefinitionWithRank[] =>
  Object.entries(record).map(([rank, entry]) => ({ rank, ...entry }));

const groupByRequest = (entries: DefinitionWithRank[]): Map<string, DefinitionWithRank[]> => {
  const grouped = new Map<string, DefinitionWithRank[]>();
  for (const item of entries) {
    if (!item.def || !item.defRequestId) continue;
    if (!grouped.has(item.defRequestId)) {
      grouped.set(item.defRequestId, []);
    }
    grouped.get(item.defRequestId)!.push(item);
  }
  return grouped;
};

const sample = <T>(items: T[], count: number): T[] => items.slice(0, count);

const main = async () => {
  const args = process.argv.slice(2);
  const mode = args[0] === "--delete" ? "delete" : "sample";
  const idsArg = mode === "delete" ? args[1] : args[0] === "--id" ? args[1] : args[0];
  const filterIds = idsArg ? idsArg.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const record = await loadDefinitionRecord();
  const entriesWithRank = toArray(record);

  const grouped = groupByRequest(entriesWithRank);

  const targets =
    filterIds.length > 0
      ? [...grouped.entries()].filter(([id]) => filterIds.includes(id))
      : [...grouped.entries()];

  if (targets.length === 0) {
    console.log(
      filterIds.length > 0 ? `No entries found for ${idsArg}` : "No definitions with defRequestId found.",
    );
    return;
  }

  // Sort by requestId for stable output.
  targets.sort(([a], [b]) => a.localeCompare(b));

  if (mode === "sample") {
    for (const [defRequestId, entries] of targets) {
      const samples = sample(entries.sort((a, b) => a.term.localeCompare(b.term, "ko")), 3);

      console.log(defRequestId);
      for (const entry of samples) {
        console.log(`- ${entry.term}: ${entry.def}`);
      }
      console.log(); // blank line between groups
    }
    return;
  }

  // mode === "delete": clear definitions for the specified request IDs.
  let cleared = 0;
  for (const [rank, entry] of Object.entries(record)) {
    if (filterIds.includes(entry.defRequestId) && entry.def !== null) {
      record[rank] = {
        ...entry,
        def: null,
        defRequestId: "",
        createdAt: new Date().toISOString(),
      };
      cleared += 1;
    }
  }

  await writeFile(DEFINITIONS_PATH, JSON.stringify(record, null, 2), "utf8");
  console.log(`Cleared ${cleared} definitions across ${filterIds.length} request(s).`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
