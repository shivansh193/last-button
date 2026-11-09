// Small LLM provider interface: structured JSON in, validated object out.
import type { ZodType } from "zod";

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  /** OpenAPI-subset schema passed to the model's structured-output mode. */
  schema: Record<string, unknown>;
  /** Validates the parsed output; on failure the provider retries once with the error. */
  validate: ZodType<T>;
}

export interface JsonResult<T> {
  value: T;
  model: string;
  attempts: number;
}

export interface LLMProvider {
  name: string;
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
}

export class AIUnavailable extends Error {}
