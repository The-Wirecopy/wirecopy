/**
 * Zero-dependency OpenAI Responses API (`/v1/responses`) & Anthropic Messages API client
 * for WireCopy's live multi-turn AI agent loop and Copy Chief chat.
 *
 * Uses pure `fetch` so the Worker needs zero external SDK bundles.
 */

export const providerOf = (env) => String(env.PROVIDER || "openai").toLowerCase();
export const hasModelKey = (env) =>
  Boolean(providerOf(env) === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Models that support `reasoning: { effort }` in /v1/responses
function supportsReasoningEffort(model) {
  return /^(gpt-5|gpt-6|o\d)/i.test(String(model || ""));
}

function openaiSession(env, { system, tools, user }) {
  const fetchImpl = env.__fetchImpl || fetch;
  const model = env.MODEL || "gpt-5.4";
  const base = {
    model,
    instructions: system,
    tools: tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    max_output_tokens: 12000,
    ...(env.EFFORT && supportsReasoningEffort(model) ? { reasoning: { effort: env.EFFORT } } : {}),
  };

  let previous = null;
  let pending = [{ role: "user", content: user }];

  return {
    async turn({ final = false } = {}) {
      let r;
      let j;
      for (let attempt = 0; ; attempt++) {
        r = await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...base,
            input: pending,
            ...(previous ? { previous_response_id: previous } : {}),
            ...(final ? { tool_choice: "none" } : {}),
          }),
        });
        j = await r.json().catch(() => ({}));
        if (r.ok) break;
        // Fallback once without reasoning param if user switches MODEL to gpt-4.1 / gpt-4o
        if (r.status === 400 && base.reasoning && /reasoning/i.test(j.error?.message || "")) {
          delete base.reasoning;
          continue;
        }
        if (attempt < 2 && (r.status === 429 || r.status >= 500)) {
          await sleep(1500 * 2 ** attempt);
          continue;
        }
        throw new Error(`OpenAI ${r.status}: ${j.error?.message || "request failed"}`);
      }

      previous = j.id;
      pending = [];
      const out = j.output || [];
      const parts = out.filter((o) => o.type === "message").flatMap((o) => o.content || []);
      if (parts.some((c) => c.type === "refusal")) {
        throw new Error("Model declined this dispatch");
      }

      return {
        text: parts
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n")
          .trim(),
        uses: out
          .filter((o) => o.type === "function_call")
          .map((c) => {
            let input = null;
            try {
              input = JSON.parse(c.arguments || "{}");
            } catch {}
            return { id: c.call_id, name: c.name, input, badArgs: input === null };
          }),
        paused: false,
        usage: { in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0 },
      };
    },
    reply(results, note) {
      pending = results.map((x) => ({
        type: "function_call_output",
        call_id: x.id,
        output: x.content,
      }));
      if (note) pending.push({ role: "user", content: note });
    },
  };
}

function anthropicSession(env, { system, tools, user }) {
  const fetchImpl = env.__fetchImpl || fetch;
  const model = env.MODEL || "claude-sonnet-4-5";
  const messages = [{ role: "user", content: user }];

  return {
    async turn({ final = false } = {}) {
      let r;
      let j;
      for (let attempt = 0; ; attempt++) {
        r = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            system,
            tools,
            messages,
            ...(final ? { tool_choice: { type: "none" } } : {}),
          }),
        });
        j = await r.json().catch(() => ({}));
        if (r.ok) break;
        if (attempt < 2 && (r.status === 429 || r.status >= 500)) {
          await sleep(1500 * 2 ** attempt);
          continue;
        }
        throw new Error(`Anthropic ${r.status}: ${j.error?.message || "request failed"}`);
      }

      const content = j.content || [];
      messages.push({ role: "assistant", content });
      const u = j.usage || {};
      return {
        text: content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim(),
        uses: content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
        paused: j.stop_reason === "pause_turn",
        usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 },
      };
    },
    reply(results, note) {
      const content = results.map((x) => ({
        type: "tool_result",
        tool_use_id: x.id,
        content: x.content,
        ...(x.error ? { is_error: true } : {}),
      }));
      if (note) content.push({ type: "text", text: note });
      messages.push({ role: "user", content });
    },
  };
}

export function startConversation(env, opts) {
  return providerOf(env) === "anthropic" ? anthropicSession(env, opts) : openaiSession(env, opts);
}
