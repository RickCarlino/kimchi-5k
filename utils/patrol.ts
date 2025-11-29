import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

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

type Concern = {
  rank: number;
  key: "def" | "pos";
  why: string;
};

type PosFix = {
  rank: number;
  newPos: string;
};

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");
const BATCH_SIZE = 10;
const MODEL = "gpt-5";

// Edit this prompt to fine‑tune how the LLM evaluates entries.
const USER_PROMPT = `
You are auditing a Korean learner's dictionary entries for CATASTROPHIC errors.
I am not talking about minor style issues or subjective preferences.
I am talking about mistakes that are so bad, we need to delete the entry.
Eg: POS tag says "NOUN" but definition describes a verb.
Eg: Definition is completely unrelated to the term.
Eg: Definition violates syntax of the Korean language.
This means NOT getting worried about nit picks like spacing, ambiguity of meaning, level of detail, existence of alternatives.
The errors you find must be UNDENIABLELY SERIOUS. There must be no room for debate.
Definitions should be simple, common-meaning, one-sentence Korean fit for learners.

If POS is wrong, DO NOT explain—just propose the corrected POS. Valid POS values:
["ADJ","ADV","CONJ","NOUN","VERB","AFFIX","DET","NUM","PRON","PRT","PUNCT","X"]

Return JSON only:
{
  "concerns": [{ "rank": number, "key": "def", "why": string }],
  "pos_fixes": [{ "rank": number, "newPos": string }]
}

If nothing is wrong, both arrays should be empty.
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
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const buildPrompt = (batch: Array<[string, DefinitionEntry]>): string => {
  const lines = batch
    .map(([rank, entry]) => {
      const defText = entry.def ?? "(null)";
      const lemmaPart = entry.lemma ? `, lemma: "${entry.lemma}"` : "";
      return `- rank: ${rank}, term: "${entry.term}"${lemmaPart}, pos: ${entry.pos}, def: "${defText}"`;
    })
    .join("\n");

  return `${USER_PROMPT.trim()}\nEntries:\n${lines}`;
};

const parseLLMResult = (text: string): { concerns: Concern[]; posFixes: PosFix[] } => {
  const parsed = JSON.parse(text) as { concerns?: Concern[]; pos_fixes?: PosFix[] };
  const concerns =
    (parsed.concerns ?? []).filter(
      (c) => c && typeof c.rank === "number" && c.key === "def" && typeof c.why === "string",
    ) ?? [];
  const posFixes =
    (parsed.pos_fixes ?? []).filter(
      (p) => p && typeof p.rank === "number" && typeof p.newPos === "string",
    ) ?? [];
  return { concerns, posFixes };
};

const auditBatch = async (
  batch: Array<[string, DefinitionEntry]>,
  requestId: string,
): Promise<{ concerns: Concern[]; posFixes: PosFix[] }> => {
  const prompt = buildPrompt(batch);

  const response = await client.responses.create({
    model: MODEL,
    metadata: { patrolRequestId: requestId },
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "patrol_concerns",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["concerns", "pos_fixes"],
          properties: {
            concerns: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rank", "key", "why"],
                properties: {
                  rank: { type: "integer" },
                  key: { type: "string", enum: ["def"] },
                  why: { type: "string" },
                },
              },
            },
            pos_fixes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rank", "newPos"],
                properties: {
                  rank: { type: "integer" },
                  newPos: {
                    type: "string",
                    enum: ["ADJ","ADV","CONJ","NOUN","VERB","AFFIX","DET","NUM","PRON","PRT","PUNCT","X"],
                  },
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
    throw new Error(`No output_text for patrol request ${requestId}`);
  }

  return parseLLMResult(response.output_text);
};

const groupConcernsByRank = (concerns: Concern[]): Map<number, Concern[]> => {
  const map = new Map<number, Concern[]>();
  for (const concern of concerns) {
    if (!map.has(concern.rank)) {
      map.set(concern.rank, []);
    }
    map.get(concern.rank)!.push(concern);
  }
  return map;
};

const main = async () => {
  const record = await loadRecord();
  const pending = Object.entries(record).filter(([, entry]) => entry.def !== null && !entry.llmCheckOn);

  if (pending.length === 0) {
    console.log("All entries with definitions have llmCheckOn; nothing to audit.");
    return;
  }

  const batches = chunk(pending, BATCH_SIZE);
  console.log(`Auditing ${pending.length} entries in ${batches.length} batch(es).`);

  const allConcerns: Concern[] = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const requestId = randomUUID();
    console.log(`Starting batch ${i + 1}/${batches.length} (requestId: ${requestId})...`);
    const { concerns, posFixes } = await auditBatch(batch!, requestId);
    allConcerns.push(...concerns);
    const concernsByRank = groupConcernsByRank(concerns);
    const posFixByRank = new Map(posFixes.map((p) => [p.rank, p.newPos]));

    // stamp llmCheckOn for this batch, regardless of concerns
    const stamp = new Date().toISOString();
    for (const [rank] of batch!) {
      const entry = record[rank]!;
      entry.llmCheckOn = stamp;
      const rankNum = Number(rank);
      entry.concerns = concernsByRank.get(rankNum) ?? [];
      const fixedPos = posFixByRank.get(rankNum);
      if (fixedPos) {
        entry.pos = fixedPos;
      }
    }
    await persistRecord(record);
    console.log(
      `Finished batch ${i + 1}/${batches.length}: ${concerns.length} def concern(s), ${posFixes.length} pos fix(es).`,
    );
  }

  console.log(JSON.stringify({ concerns: allConcerns }, null, 2));
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
