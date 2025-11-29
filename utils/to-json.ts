import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TermEntry = {
  term: string;
  rank: number;
};

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const RAW_DIR = join(ROOT_DIR, "raw");
const OUTPUT_PATH = join(ROOT_DIR, "data", "terms.json");

const linePattern = /^\s*(\d+)\.\s*(.+?)\s*$/;

const parseLine = (line: string, source: string): TermEntry | null => {
  if (!line.trim()) return null;
  const match = line.match(linePattern);
  if (!match) {
    throw new Error(`Unrecognized line in ${source}: "${line}"`);
  }

  const [, rankStr, term] = match;
  if (!rankStr || !term) {
    throw new Error(`Incomplete match in ${source}: "${line}"`);
  }

  return { rank: Number.parseInt(rankStr, 10), term };
};

const readTerms = async (): Promise<TermEntry[]> => {
  const entries: TermEntry[] = [];
  const files = (await readdir(RAW_DIR)).filter((file) => file.endsWith(".txt")).sort();

  for (const file of files) {
    const content = await readFile(join(RAW_DIR, file), "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const entry = parseLine(line, file);
      if (entry) entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.rank - b.rank);
};

const writeOutput = async (entries: TermEntry[]) => {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(entries, null, 2), "utf8");
};

const main = async () => {
  const entries = await readTerms();
  await writeOutput(entries);
  console.log(`Wrote ${entries.length} terms to ${OUTPUT_PATH}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
