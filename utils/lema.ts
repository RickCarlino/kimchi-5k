import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LanguageServiceClient } from "@google-cloud/language";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TermEntry = {
  term: string;
  rank: number;
};

type LemmaEntry = TermEntry & {
  lemma?: string;
  pos: string;
};

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
const TERMS_PATH = join(ROOT_DIR, "data", "terms.json");
const OUTPUT_PATH = join(ROOT_DIR, "data", "lemmas.json");
const BATCH_SIZE = 100;
const MAX_CONCURRENCY = 10;
const MAX_REQUESTS_PER_MINUTE = 540; // stay under the 600 rpm limit with some buffer
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

const loadTerms = async (): Promise<TermEntry[]> => {
  const raw = await readFile(TERMS_PATH, "utf8");
  const parsed = JSON.parse(raw) as TermEntry[];
  return parsed;
};

const lemmatizeOne = async (entry: TermEntry): Promise<LemmaEntry> => {
  const [response] = await languageClient.analyzeSyntax({
    document: { content: entry.term, type: "PLAIN_TEXT" },
    encodingType: "UTF8",
  });

  const token = response.tokens?.[0];
  const lemmaFromService = token?.lemma?.trim();
  const normalizedLemma = lemmaFromService && lemmaFromService.length > 0 ? lemmaFromService : entry.term;
  const pos = String(token?.partOfSpeech?.tag ?? "UNKNOWN");

  if (normalizedLemma === entry.term) {
    return { ...entry, pos };
  }

  return { ...entry, lemma: normalizedLemma, pos };
};

const lemmatizeWithRetry = async (entry: TermEntry): Promise<LemmaEntry> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await lemmatizeOne(entry);
    } catch (error) {
      const code = (error as { code?: number }).code;
      const isRateLimit = code === 8; // RESOURCE_EXHAUSTED
      if (!isRateLimit || attempt === MAX_RETRIES) {
        throw error;
      }
      const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
      console.warn(
        `Rate limited on "${entry.term}". Retrying in ${backoffMs}ms (attempt ${attempt + 1} of ${MAX_RETRIES + 1})`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Exhausted retries");
};

const enforceRateLimit = async (chunkSize: number, startedAtMs: number) => {
  const minDurationMs = Math.ceil((chunkSize / MAX_REQUESTS_PER_MINUTE) * 60_000);
  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < minDurationMs) {
    await sleep(minDurationMs - elapsedMs);
  }
};

const lemmatizeBatch = async (batch: TermEntry[]): Promise<LemmaEntry[]> => {
  const results: LemmaEntry[] = [];
  for (let i = 0; i < batch.length; i += MAX_CONCURRENCY) {
    const chunk = batch.slice(i, i + MAX_CONCURRENCY);
    const chunkStarted = Date.now();
    const chunkResults = await Promise.all(chunk.map((entry) => lemmatizeWithRetry(entry)));
    results.push(...chunkResults);
    await enforceRateLimit(chunk.length, chunkStarted);
  }
  return results;
};

const main = async () => {
  const allTerms = await loadTerms();
  const results: LemmaEntry[] = [];

  for (let i = 0; i < allTerms.length; i += BATCH_SIZE) {
    const batch = allTerms.slice(i, i + BATCH_SIZE);
    const batchResults = await lemmatizeBatch(batch);
    results.push(...batchResults);
    console.log(`Processed ${Math.min(i + BATCH_SIZE, allTerms.length)} / ${allTerms.length}`);
  }

  await mkdir(join(ROOT_DIR, "data"), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf8");

  console.log(`Wrote ${results.length} lemmatized entries to ${OUTPUT_PATH}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
