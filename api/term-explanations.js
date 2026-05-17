const DEFAULT_MODEL = "gpt-5.4-nano";
const MAX_SELECTED_TEXT_LENGTH = 1000;
const MAX_TERMS = 8;

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: "missing_api_key" });
    return;
  }

  const payload = await readBody(req);
  const selectedText = normalizeInput(payload?.selectedText);
  if (!selectedText) {
    res.status(400).json({ error: "missing_selected_text" });
    return;
  }

  if (selectedText.length > MAX_SELECTED_TEXT_LENGTH) {
    res.status(400).json({ error: "selected_text_too_long" });
    return;
  }

  try {
    const terms = await fetchTermExplanations({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      selectedText
    });

    res.status(200).json({ terms });
  } catch (error) {
    console.error("Failed to generate term explanations", error);
    res.status(502).json({ error: "generation_failed" });
  }
};

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return parseJson(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function fetchTermExplanations({ apiKey, model, selectedText }) {
  const endpoint = "https://api.openai.com/v1/chat/completions";
  const prompt = buildPrompt(selectedText);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      top_p: 0.8,
      max_completion_tokens: 512,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "term_explanations",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              terms: {
                type: "array",
                maxItems: MAX_TERMS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    term: { type: "string" },
                    explanation: { type: "string" }
                  },
                  required: ["term", "explanation"]
                }
              }
            },
            required: ["terms"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API returned ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  const parsed = parseJsonResponse(text);
  return normalizeTerms(parsed?.terms);
}

function buildPrompt(selectedText) {
  return [
    "あなたは日本語の記事を読む初心者向けの用語解説者です。",
    "次の1文に含まれる、初心者がつまずきやすい専門用語だけを抽出し、短く説明してください。",
    "一般的すぎる語や、文脈なしでは説明対象にならない語は除外してください。",
    "説明は本文の主張を広げすぎず、1用語につき40〜90字程度にしてください。",
    "専門用語がない場合は terms を空配列にしてください。",
    "必ず次のJSON形式だけで返してください。",
    '{"terms":[{"term":"用語","explanation":"説明"}]}',
    "",
    "対象の文:",
    selectedText
  ].join("\n");
}

function extractResponseText(data) {
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function parseJsonResponse(text) {
  if (!text) return { terms: [] };
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function normalizeTerms(terms) {
  if (!Array.isArray(terms)) return [];

  return terms
    .map(item => ({
      term: normalizeInput(item?.term),
      explanation: normalizeInput(item?.explanation)
    }))
    .filter(item => item.term && item.explanation)
    .slice(0, MAX_TERMS);
}

function normalizeInput(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
