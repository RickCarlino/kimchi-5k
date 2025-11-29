import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

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
  eng?: string;
};

type DefinitionRecord = Record<string, DefinitionEntry>;

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");
const BATCH_SIZE = 100;
const MODEL = "gpt-5.1";

const USER_PROMPT = `
You are translating Korean learner dictionary entries to natural English.
For each item, translate the definition text into clear, concise English (one sentence). Ignore the term in translation.
Return JSON only:
{ "translations": [ { "rank": number, "eng": string } ] }
Use concise, plain English; keep any sense of the original; no quotes around the result.
`;

const client = new OpenAI();

const loadDefinitions = async (): Promise<DefinitionRecord> => {
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  return JSON.parse(raw) as DefinitionRecord;
};

const persistDefinitions = async (record: DefinitionRecord) => {
  await writeFile(DEFINITIONS_PATH, JSON.stringify(record, null, 2), "utf8");
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const res: T[][] = [];
  for (let i = 0; i < items.length; i += size) res.push(items.slice(i, i + size));
  return res;
};

const buildPrompt = (batch: Array<[string, DefinitionEntry]>): string => {
  const lines = batch.map(([rank, entry]) => `- rank: ${rank}, def: "${entry.def}"`).join("\n");
  return `${USER_PROMPT.trim()}\nItems:\n${lines}`;
};

const parseTranslations = (text: string): Array<{ rank: number; eng: string }> => {
  const parsed = JSON.parse(text) as { translations?: Array<{ rank: number; eng: string }> };
  return (
    parsed.translations?.filter(
      (t) => t && typeof t.rank === "number" && typeof t.eng === "string" && t.eng.trim().length > 0,
    ) ?? []
  );
};

const main = async () => {
  const record = await loadDefinitions();
  const pending = Object.entries(record).filter(
    ([, entry]) => entry.def !== null && !entry.eng,
  );

  if (pending.length === 0) {
    console.log("All entries already have eng translations. Nothing to do.");
    return;
  }

  const batches = chunk(pending, BATCH_SIZE);
  console.log(`Translating ${pending.length} entries in ${batches.length} batch(es).`);

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const requestId = randomUUID();
    console.log(`Starting batch ${i + 1}/${batches.length} (requestId: ${requestId})...`);
    const prompt = buildPrompt(batch);

    const response = await client.responses.create({
      model: MODEL,
      metadata: { engRequestId: requestId },
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "eng_translations",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["translations"],
            properties: {
              translations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rank", "eng"],
                  properties: {
                    rank: { type: "integer" },
                    eng: { type: "string" },
                  },
                },
              },
            },
          },
        },
        verbosity: "low",
      },
    });

    if (!response.output_text) {
      throw new Error(`No output_text for eng request ${requestId}`);
    }

    const translations = parseTranslations(response.output_text);
    const stamp = new Date().toISOString();
    for (const t of translations) {
      const entry = record[String(t.rank)];
      if (!entry) continue;
      entry.eng = t.eng.trim();
      entry.llmCheckOn = entry.llmCheckOn ?? stamp;
    }

    await persistDefinitions(record);
    console.log(`Finished batch ${i + 1}/${batches.length}: applied ${translations.length} translations.`);
  }
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
