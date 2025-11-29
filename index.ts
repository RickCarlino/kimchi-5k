import OpenAI from "openai";
import { LanguageServiceClient } from "@google-cloud/language";

type ServiceAccountJSON = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

type LemmaResult = {
  surface: string;
  lemma: string;
};

const requireEnv = (key: keyof typeof Bun.env): string => {
  const value = Bun.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const parseServiceAccountJSON = (): ServiceAccountJSON => {
  const raw = Bun.env.GCP_JSON_CREDS;
  if (!raw) {
    throw new Error(
      "Set GCP_JSON_CREDS to a JSON-stringified service account to use Google NLP lemmatization.",
    );
  }

  const parsed = JSON.parse(raw) as Partial<ServiceAccountJSON>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GCP_JSON_CREDS is present but missing client_email or private_key.");
  }

  return parsed as ServiceAccountJSON;
};

let openaiClient: OpenAI | null = null;
const getOpenAIClient = (): OpenAI => {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: requireEnv("OPENAI_API_KEY"),
    });
  }
  return openaiClient;
};

let languageClient: LanguageServiceClient | null = null;
const getLanguageClient = (): LanguageServiceClient => {
  if (!languageClient) {
    const credentials = parseServiceAccountJSON();
    languageClient = new LanguageServiceClient({
      projectId: credentials.project_id ?? Bun.env.GOOGLE_CLOUD_PROJECT,
      credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
      },
    });
  }
  return languageClient;
};

export const summarizeWithOpenAI = async (text: string): Promise<string> => {
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Summarize the text focusing on vocabulary insights.",
      },
      { role: "user", content: text },
    ],
    max_tokens: 120,
    temperature: 0.3,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
};

export const lemmatizeWithGoogleNLP = async (text: string): Promise<LemmaResult[]> => {
  const client = getLanguageClient();
  const [response] = await client.analyzeSyntax({
    document: { content: text, type: "PLAIN_TEXT" },
    encodingType: "UTF8",
  });

  const tokens = response.tokens ?? [];
  return tokens
    .map((token) => ({
      surface: token.text?.content ?? "",
      lemma: token.lemma ?? "",
    }))
    .filter((entry) => entry.surface.length > 0);
};

const printUsage = () => {
  console.log("Usage:");
  console.log("  bun run index.ts summary \"Text to summarize\"");
  console.log("  bun run index.ts lemmas \"Text to lemmatize\"");
};

const runCLI = async () => {
  const [, , mode, ...textArgs] = Bun.argv;
  if (!mode) {
    printUsage();
    return;
  }

  const text = textArgs.join(" ").trim();
  if (!text) {
    console.error("Provide text to process.");
    printUsage();
    Bun.exit(1);
  }

  if (mode === "summary") {
    const summary = await summarizeWithOpenAI(text);
    console.log(summary);
    return;
  }

  if (mode === "lemmas") {
    const lemmas = await lemmatizeWithGoogleNLP(text);
    console.table(lemmas);
    return;
  }

  console.error(`Unknown mode: ${mode}`);
  printUsage();
  Bun.exit(1);
};

if (import.meta.main) {
  runCLI().catch((error) => {
    console.error(error.message);
    Bun.exit(1);
  });
}
