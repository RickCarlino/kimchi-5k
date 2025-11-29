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
};

type DefinitionRecord = Record<string, DefinitionEntry>;

type Correction = {
  rank: number;
  action: "replace" | "keep" | "null";
  def: string | null;
};

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");
const BATCH_SIZE = 5;
const MODEL = "gpt-5.1";

const USER_PROMPT = `
You are a precise Korean learner dictionary editor.
For each entry with concerns, choose ONE action:
- "replace": supply a corrected one-sentence, learner-friendly Korean definition (no English).
- "keep": disregard the concern; keep the current definition as-is (return def = null to signal no change).
- "null": the term is not a real/usable Korean word; set definition to null (return def = null).

Valid POS values are already set; do not change POS.
Return JSON only:
{ "corrections": [ { "rank": number, "action": "replace" | "keep" | "null", "def": string | null } ] }

Rules:
- If action is "replace", you MUST provide a string in "def".
- If action is "keep" or "null", set "def" to null.
- Keep language simple, common-meaning, one sentence; end with a period.
`;

const client = new OpenAI();

const loadRecord = async (): Promise<DefinitionRecord> => {
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  return JSON.parse(raw) as DefinitionRecord;
};

const persistRecord = async (record: DefinitionRecord) => {
  await writeFile(DEFINITIONS_PATH, JSON.stringify(record, null, 2), "utf8");
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const res: T[][] = [];
  for (let i = 0; i < items.length; i += size) res.push(items.slice(i, i + size));
  return res;
};

const buildPrompt = (batch: Array<[string, DefinitionEntry]>): string => {
  const lines = batch
    .map(([rank, entry]) => {
      const concerns = (entry.concerns ?? []).map((c) => `- ${c.key}: ${c.why}`).join("\\n");
      const lemmaPart = entry.lemma ? `, lemma: "${entry.lemma}"` : "";
      return `rank: ${rank}, term: "${entry.term}"${lemmaPart}, pos: ${entry.pos}
def: "${entry.def ?? "(null)"}"
concerns:
${concerns || "(none)"}
`;
    })
    .join("\n");
  return `${USER_PROMPT.trim()}\nEntries:\n${lines}`;
};

const parseCorrections = (text: string): Correction[] => {
  const parsed = JSON.parse(text) as { corrections?: Correction[] };
  const list = parsed.corrections ?? [];
  return list.filter(
    (c) =>
      c &&
      typeof c.rank === "number" &&
      (c.action === "replace" || c.action === "keep" || c.action === "null") &&
      (typeof c.def === "string" || c.def === null),
  );
};

const applyCorrections = (record: DefinitionRecord, corrections: Correction[], timestamp: string) => {
  for (const c of corrections) {
    const entry = record[String(c.rank)];
    if (!entry) continue;
    if (c.action === "replace") {
      entry.def = c.def ?? entry.def;
    } else if (c.action === "null") {
      entry.def = null;
    } else if (c.action === "keep") {
      // leave def unchanged
    }
    entry.concerns = [];
    entry.llmCheckOn = timestamp;
  }
};

const main = async () => {
  const record = await loadRecord();
  const pending = Object.entries(record).filter(
    ([, entry]) => (entry.concerns?.length ?? 0) > 0 && entry.def !== null,
  );

  if (pending.length === 0) {
    console.log("No entries with concerns to correct.");
    return;
  }

  const batches = chunk(pending, BATCH_SIZE);
  console.log(`Applying corrections to ${pending.length} entries in ${batches.length} batch(es).`);

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const requestId = randomUUID();
    console.log(`Starting batch ${i + 1}/${batches.length} (requestId: ${requestId})...`);
    const prompt = buildPrompt(batch);

    const response = await client.responses.create({
      model: MODEL,
      metadata: { applyRequestId: requestId },
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "apply_corrections",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["corrections"],
            properties: {
              corrections: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rank", "action", "def"],
                  properties: {
                    rank: { type: "integer" },
                    action: { type: "string", enum: ["replace", "keep", "null"] },
                    def: { type: ["string", "null"] },
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
      throw new Error(`No output_text for apply request ${requestId}`);
    }

    const corrections = parseCorrections(response.output_text);
    const stamp = new Date().toISOString();
    applyCorrections(record, corrections, stamp);
    await persistRecord(record);
    console.log(`Finished batch ${i + 1}/${batches.length}: applied ${corrections.length} correction(s).`);
  }
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
