const DEFAULT_MODEL = "gemini-3.1-flash-lite";
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

  if (!process.env.GEMINI_API_KEY) {
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
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const prompt = buildPrompt(selectedText);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingLevel: "minimal"
        }
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API returned ${response.status}: ${detail}`);
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
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(part => part?.text || "").join("").trim();
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
