import { readFile, stat } from "node:fs/promises";
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

let cache: { mtimeMs: number; data: Array<{ rank: number; entry: DefinitionEntry }> } | null = null;

const loadDefinitions = async () => {
  const { mtimeMs } = await stat(DEFINITIONS_PATH);
  if (cache && cache.mtimeMs === mtimeMs) {
    return cache.data;
  }
  const raw = await readFile(DEFINITIONS_PATH, "utf8");
  const parsed = JSON.parse(raw) as DefinitionRecord;
  const data = Object.entries(parsed)
    .map(([rank, entry]) => ({ rank: Number(rank), entry }))
    .sort((a, b) => a.rank - b.rank);
  cache = { mtimeMs, data };
  return data;
};

const html = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Kimchi 5k Definitions</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { font-family: "Inter", system-ui, -apple-system, sans-serif; background:#0f1115; color:#e9ecf1; }
    body { margin:0; }
    header { padding:16px 20px; background:#131722; position:sticky; top:0; z-index:1; box-shadow:0 2px 6px rgba(0,0,0,0.4);}
    h1 { margin:0 0 8px; font-size:20px; letter-spacing:0.2px;}
    .controls { display:flex; gap:10px; flex-wrap:wrap; }
    input, select { padding:6px 10px; border-radius:6px; border:1px solid #2b3242; background:#1a1f2d; color:#e9ecf1; }
    main { padding:14px 20px 40px; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:14px; }
    th, td { padding:8px 10px; border-bottom:1px solid #2b3242; vertical-align:top; }
    th { text-align:left; color:#9fb0c8; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#24314a; color:#d4e0ff; }
    .null { color:#ffadad; }
    .concern { display:block; margin-top:4px; color:#ffdd7f; }
    .pos-fixed { color:#9ae6b4; font-weight:600; }
  </style>
</head>
<body>
  <header>
    <h1>Kimchi 5k — Definitions</h1>
    <div class="controls">
      <input id="q" placeholder="Search term or definition..." />
      <select id="pos">
        <option value="">POS: any</option>
        <option>ADJ</option><option>ADV</option><option>CONJ</option><option>NOUN</option><option>VERB</option>
        <option>AFFIX</option><option>DET</option><option>NUM</option><option>PRON</option><option>PRT</option><option>PUNCT</option><option>X</option>
      </select>
      <select id="status">
        <option value="all">Definition: any</option>
        <option value="has">Has definition</option>
        <option value="missing">Missing definition</option>
      </select>
      <select id="concerns">
        <option value="all">Concerns: any</option>
        <option value="has">Has concerns</option>
        <option value="none">No concerns</option>
      </select>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <table>
      <thead>
        <tr>
          <th>Rank</th><th>Term</th><th>POS</th><th>Definition</th><th>Meta</th>
        </tr>
      </thead>
      <tbody id="rows">
      </tbody>
    </table>
  </main>
  <script type="module">
    const rows = document.getElementById("rows");
    const q = document.getElementById("q");
    const pos = document.getElementById("pos");
    const status = document.getElementById("status");
    const concernsSel = document.getElementById("concerns");
    const refreshBtn = document.getElementById("refresh");

    let data = [];

    async function load() {
      const res = await fetch("/api/definitions");
      data = await res.json();
      render();
    }

    function matchesFilters(item) {
      const term = item.entry.term.toLowerCase();
      const def = (item.entry.def || "").toLowerCase();
      const query = q.value.trim().toLowerCase();
      if (query && !term.includes(query) && !def.includes(query)) return false;
      if (pos.value && item.entry.pos !== pos.value) return false;
      if (status.value === "has" && item.entry.def === null) return false;
      if (status.value === "missing" && item.entry.def !== null) return false;
      const hasConcerns = Array.isArray(item.entry.concerns) && item.entry.concerns.length > 0;
      if (concernsSel.value === "has" && !hasConcerns) return false;
      if (concernsSel.value === "none" && hasConcerns) return false;
      return true;
    }

    function render() {
      const filtered = data.filter(matchesFilters).slice(0, 500); // safety cap
      rows.innerHTML = filtered.map(({rank, entry}) => {
        const concerns = (entry.concerns || []).map(c => '<span class="concern">⚠ ' + c.why + '</span>').join("");
        const def = entry.def === null ? '<span class="null">—</span>' : entry.def;
        const lemma = entry.lemma ? ' · lemma: ' + entry.lemma : '';
        const meta = 'req:' + (entry.defRequestId || '—') + ' · checked:' + (entry.llmCheckOn || '—');
        return \`<tr>
          <td>\${rank}</td>
          <td><strong>\${entry.term}</strong></td>
          <td><span class="pill">\${entry.pos}</span></td>
          <td>\${def}\${concerns}</td>
          <td style="color:#9fb0c8;font-size:12px;">\${meta}\${lemma}</td>
        </tr>\`;
      }).join("");
    }

    q.addEventListener("input", render);
    pos.addEventListener("change", render);
    status.addEventListener("change", render);
    concernsSel.addEventListener("change", render);
    refreshBtn.addEventListener("click", load);

    load();
  </script>
</body>
</html>`;

const serveDefinitions = async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/api/definitions") {
    const data = await loadDefinitions();
    return Response.json(data);
  }

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};

const port = Number(Bun.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: serveDefinitions,
});

console.log(`Definitions server running at http://localhost:${port}`);
