// Gemini (Google AI Studio) provider with structured output, one validation retry,
// and model fallbacks for 429/503.
import { AIUnavailable, type JsonRequest, type JsonResult, type LLMProvider } from "./provider.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiProvider implements LLMProvider {
  name = "gemini";
  constructor(
    private key = process.env.GEMINI_API_KEY ?? "",
    private models = [process.env.GEMINI_MODEL ?? "gemini-3.5-flash", ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.1-flash-lite").split(",")]
      .map((m) => m.trim())
      .filter(Boolean),
  ) {}

  private async call(model: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${model} ${res.status} ${body?.error?.status ?? ""}`);
      (err as any).retryable = [429, 500, 503, 504].includes(res.status) || res.status === 404;
      throw err;
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (!text) throw Object.assign(new Error(`${model} returned no text (${body?.candidates?.[0]?.finishReason ?? "?"})`), { retryable: true });
    return text;
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    if (!this.key) throw new AIUnavailable("GEMINI_API_KEY is not set");
    const errors: string[] = [];
    for (const model of this.models) {
      let prompt = req.prompt;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let text: string;
        try {
          text = await this.call(model, req.system, prompt, req.schema);
        } catch (e: any) {
          errors.push(e.message);
          if (e.retryable) break; // next model
          throw e;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          prompt = `${req.prompt}\n\nYour previous reply was not valid JSON. Reply with JSON only.`;
          errors.push(`${model}: invalid JSON`);
          continue;
        }
        const v = req.validate.safeParse(parsed);
        if (v.success) return { value: v.data, model, attempts: attempt };
        errors.push(`${model}: schema ${v.error.issues[0]?.path.join(".")} ${v.error.issues[0]?.message}`);
        prompt = `${req.prompt}\n\nYour previous reply failed validation: ${v.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}. Fix it and reply again.`;
      }
    }
    throw new AIUnavailable(`AI unavailable: ${errors.join(" / ")}`);
  }
}
