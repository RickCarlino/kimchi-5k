import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

type LemmaEntry = {
  rank: number;
  term: string;
  lemma?: string;
  pos: string;
};

type DefinitionEntry = {
  def: string | null;
  term: string;
  lemma?: string;
  pos: string;
  defRequestId: string;
  createdAt: string;
};

type DefinitionMap = Record<string, DefinitionEntry>;

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const LEMMAS_PATH = join(ROOT_DIR, "data", "1-lemmas.json");
const DEFINITIONS_PATH = join(ROOT_DIR, "data", "2-definitions.json");
const TARGET_POS = new Set(["ADJ", "ADV", "CONJ", "NOUN", "VERB"]);
const BATCH_SIZE = 50;
const MODEL = "gpt-5";
const MAX_OUTPUT_TOKENS = 2_048;

const client = new OpenAI();

const loadLemmas = async (): Promise<LemmaEntry[]> => {
  const raw = await readFile(LEMMAS_PATH, "utf8");
  return JSON.parse(raw) as LemmaEntry[];
};

const loadDefinitions = async (): Promise<DefinitionMap> => {
  try {
    const raw = await readFile(DEFINITIONS_PATH, "utf8");
    return JSON.parse(raw) as DefinitionMap;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const persistDefinitions = async (definitions: DefinitionMap) => {
  await mkdir(dirname(DEFINITIONS_PATH), { recursive: true });
  await writeFile(DEFINITIONS_PATH, JSON.stringify(definitions, null, 2), "utf8");
};

const ensureAllRanksPresent = (definitions: DefinitionMap, lemmas: LemmaEntry[]) => {
  for (const entry of lemmas) {
    if (!definitions[entry.rank]) {
      definitions[entry.rank] = {
        def: null,
        term: entry.term,
        lemma: entry.lemma,
        pos: entry.pos,
        defRequestId: "",
        createdAt: new Date().toISOString(),
      };
    }
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const buildPrompt = (batch: LemmaEntry[]): string => {
  const lines = batch
    .map((entry) => {
      const lemmaPart = entry.lemma ? `, lemma: "${entry.lemma}"` : "";
      return `- rank: ${entry.rank}, term: "${entry.term}"${lemmaPart}, pos: ${entry.pos}`;
    })
    .join("\n");

  return [
    "너는 한국어 학습자를 위한 사전 편집자다.",
    "아래 단어 각각에 대해 가장 흔하게 쓰이는 의미를 한 문장으로 풀어쓴 정의를 작성해라.",
    "쉬운 한국어만 사용하고, 영어 단어나 예시는 넣지 말라.",
    'JSON으로만 응답해. 구조는 { "definitions": [ { "rank": <number>, "def": "<string>" }, ... ] } 형식이다.',
    "문장 끝에는 온점을 붙여라.",
    "단어 목록:",
    lines,
  ].join("\n");
};

const parseDefinitions = (
  responseText: string,
  batchByRank: Map<number, LemmaEntry>,
  defRequestId: string,
): DefinitionMap => {
  const parsed = JSON.parse(responseText) as { definitions?: Array<{ rank: number; def: string }> };
  if (!parsed.definitions || !Array.isArray(parsed.definitions)) {
    throw new Error("응답에 definitions 배열이 없습니다.");
  }

  const results: DefinitionMap = {};
  for (const item of parsed.definitions) {
    if (!item || typeof item.rank !== "number" || typeof item.def !== "string") {
      throw new Error("정의 항목 형식이 잘못되었습니다.");
    }
    const source = batchByRank.get(item.rank);
    if (!source) continue;
    results[item.rank] = {
      def: item.def.trim(),
      term: source.term,
      lemma: source.lemma,
      pos: source.pos,
      defRequestId,
      createdAt: new Date().toISOString(),
    };
  }

  return results;
};

const requestBatch = async (batch: LemmaEntry[], requestId: string): Promise<DefinitionMap> => {
  const batchByRank = new Map(batch.map((entry) => [entry.rank, entry]));
  const prompt = buildPrompt(batch);

  const response = await client.responses.create({
    model: MODEL,
    metadata: { defRequestId: requestId },
    input: prompt,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "definitions",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["definitions"],
          properties: {
            definitions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rank", "def"],
                properties: {
                  rank: { type: "integer" },
                  def: { type: "string" },
                },
              },
            },
          },
        },
      },
      verbosity: "low",
    },
    reasoning: { effort: "minimal" },
  });

  if (!response.output_text) {
    throw new Error(`응답에 output_text가 없습니다 (request ${requestId}).`);
  }

  return parseDefinitions(response.output_text, batchByRank, requestId);
};

const main = async () => {
  const lemmas = await loadLemmas();
  const existingDefinitions = await loadDefinitions();

  // Ensure every lemma rank is represented in the output, even blacklisted POS.
  ensureAllRanksPresent(existingDefinitions, lemmas);
  await persistDefinitions(existingDefinitions);

  const todo = lemmas.filter(
    (entry) => TARGET_POS.has(entry.pos) && !existingDefinitions[entry.rank]?.def,
  );

  if (todo.length === 0) {
    console.log("모든 대상 품사의 정의가 이미 존재합니다. 🎉");
    return;
  }

  const batches = chunk(todo, BATCH_SIZE);
  console.log(`총 ${todo.length}개 정의가 필요합니다. ${batches.length}개 배치로 요청합니다.`);

  for (const batch of batches) {
    const requestId = randomUUID();
    const ranks = batch.map((entry) => entry.rank).join(", ");
    console.log(`요청 ${requestId} → 랭크: [${ranks}]`);

    const batchDefinitions = await requestBatch(batch, requestId);
    for (const [rank, definition] of Object.entries(batchDefinitions)) {
      existingDefinitions[rank] = definition;
    }
    await persistDefinitions(existingDefinitions);
    console.log(`요청 ${requestId} 완료. 누적 저장: ${Object.keys(existingDefinitions).length}개`);
  }
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
