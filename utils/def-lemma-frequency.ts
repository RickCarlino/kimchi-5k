import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LanguageServiceClient } from "@google-cloud/language";

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

type ServiceAccountJSON = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

const parseServiceAccountJSON = (): ServiceAccountJSON => {
  const raw = Bun.env.GCP_JSON_CREDS;
  if (!raw) {
    throw new Error("Set GCP_JSON_CREDS to a JSON-stringified service account to use Google NLP.");
  }
  const parsed = JSON.parse(raw) as Partial<ServiceAccountJSON>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GCP_JSON_CREDS is present but missing client_email or private_key.");
  }
  return parsed as ServiceAccountJSON;
};

const credentials = parseServiceAccountJSON();
const languageClient = new LanguageServiceClient({
  projectId: credentials.project_id ?? Bun.env.GOOGLE_CLOUD_PROJECT,
  credentials: {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  },
});

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");
const OUTPUT_PATH = join(ROOT_DIR, "data", "definition-lemmas.json");
const DEF_PER_REQUEST = 100; // concatenate up to 100 definitions per NLP call
const MAX_REQUESTS_PER_MINUTE = 540; // stay under 600 rpm
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadDefinitions = async (): Promise<DefinitionRecord> => {
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  return JSON.parse(raw) as DefinitionRecord;
};

const analyzeWithRetry = async (text: string): Promise<string[]> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const [response] = await languageClient.analyzeSyntax({
        document: { content: text, type: "PLAIN_TEXT", languageCode: "ko" },
        encodingType: "UTF8",
      });
      const lemmas =
        response.tokens
          ?.filter((t) => t.lemma && t.partOfSpeech?.tag !== "PUNCT")
          .map((t) => t.lemma!.trim().toLowerCase())
          .filter((l) => l.length > 0) ?? [];
      return lemmas;
    } catch (error) {
      const code = (error as { code?: number }).code;
      const isRateLimit = code === 8; // RESOURCE_EXHAUSTED
      if (!isRateLimit || attempt === MAX_RETRIES) {
        throw error;
      }
      const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
      console.warn(`Rate limited. Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      await sleep(backoffMs);
    }
  }
  throw new Error("Exhausted retries");
};

const enforceRateLimit = async (requestsMade: number, startedAtMs: number) => {
  const minDurationMs = Math.ceil((requestsMade / MAX_REQUESTS_PER_MINUTE) * 60_000);
  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < minDurationMs) {
    await sleep(minDurationMs - elapsedMs);
  }
};

const main = async () => {
  const record = await loadDefinitions();
  const definitions = Object.values(record)
    .map((e) => e.def)
    .filter((d): d is string => d !== null);

  if (definitions.length === 0) {
    console.log("No definitions found to lemmatize.");
    return;
  }

  console.log(`Lemmatizing ${definitions.length} definitions...`);

  const lemmas: string[] = [];
  for (let i = 0; i < definitions.length; i += DEF_PER_REQUEST) {
    const slice = definitions.slice(i, i + DEF_PER_REQUEST);
    const started = Date.now();
    const text = slice.join("\n");
    const result = await analyzeWithRetry(text);
    lemmas.push(...result);
    const processed = Math.min(i + slice.length, definitions.length);
    console.log(
      `Processed ${processed} / ${definitions.length} defs (running total lemmas: ${lemmas.length})`,
    );
    await enforceRateLimit(1, started);
  }

  const freq = new Map<string, number>();
  lemmas.forEach((lemma) => freq.set(lemma, (freq.get(lemma) ?? 0) + 1));

  const sorted = [...freq.entries()]
    .map(([lemma, count]) => ({ lemma, count }))
    .sort((a, b) => b.count - a.count || a.lemma.localeCompare(b.lemma));

  await mkdir(join(ROOT_DIR, "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(sorted, null, 2), "utf8");

  console.log(`Wrote ${sorted.length} unique lemmas to ${OUTPUT_PATH}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
