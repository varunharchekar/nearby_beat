/**
 * Claude Messages API researcher: server-side web search and web fetch, streamed so progress can be shown.
 * Docs: platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool and .../web-fetch-tool
 */
import type { Progress, ResearchRequest, ResearchResult, Researcher, Usage } from './types.ts';
import { parseReport, RECORD_DOMAINS, systemPrompt, userPrompt } from './prompt.ts';

/** USD per million tokens [input, output]. Unknown models fall back to Sonnet pricing. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5],
};
const SEARCH_USD = 0.01;
export const costOf = (model: string, u: Omit<Usage, 'costUsd'>) => {
  const [i, o] = PRICES[model] ?? PRICES['claude-sonnet-5-5'];
  return (u.inputTokens * i + u.outputTokens * o) / 1e6 + u.searches * SEARCH_USD;
};

interface Block { type: string; [k: string]: any }
export interface StreamedMessage { content: Block[]; stopReason: string | null; usage: { input: number; output: number; searches: number } }

/** Parse an Anthropic SSE stream into a message, calling onBlock as each content block completes. */
export async function readStream(body: ReadableStream<Uint8Array>, onBlock: (b: Block) => void): Promise<StreamedMessage> {
  const msg: StreamedMessage = { content: [], stopReason: null, usage: { input: 0, output: 0, searches: 0 } };
  const partial = new Map<number, string>();
  const dec = new TextDecoder();
  let buf = '';
  const handle = (event: string, data: any) => {
    switch (event) {
      case 'message_start': {
        const u = data.message?.usage ?? {};
        msg.usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        msg.usage.output = u.output_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const b = structuredClone(data.content_block);
        if (b.type === 'text') { b.text = b.text ?? ''; if (b.citations === null) delete b.citations; }
        if (b.type === 'server_tool_use' || b.type === 'tool_use') partial.set(data.index, '');
        msg.content[data.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = msg.content[data.index];
        const d = data.delta;
        if (!b) break;
        if (d.type === 'text_delta') b.text += d.text;
        else if (d.type === 'input_json_delta') partial.set(data.index, (partial.get(data.index) ?? '') + d.partial_json);
        else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        break;
      }
      case 'content_block_stop': {
        const b = msg.content[data.index];
        if (!b) break;
        if (partial.has(data.index)) { const s = partial.get(data.index)!; try { b.input = s ? JSON.parse(s) : (b.input ?? {}); } catch { b.input = {}; } partial.delete(data.index); }
        onBlock(b);
        break;
      }
      case 'message_delta': {
        msg.stopReason = data.delta?.stop_reason ?? msg.stopReason;
        const u = data.usage ?? {};
        if (u.output_tokens != null) msg.usage.output = u.output_tokens;
        if (u.input_tokens != null) msg.usage.input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (u.server_tool_use?.web_search_requests != null) msg.usage.searches = u.server_tool_use.web_search_requests;
        break;
      }
      case 'error': throw new Error(`Research API error: ${data.error?.type ?? 'unknown'}: ${data.error?.message ?? ''}`);
    }
  };
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message', data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) handle(event, JSON.parse(data));
    }
  }
  msg.content = msg.content.filter(Boolean);
  return msg;
}

export class AnthropicResearcher implements Researcher {
  name = 'anthropic';
  private key: string; private model: string; private f: typeof fetch; private base: string;
  constructor(o: { apiKey: string; model: string; fetch?: typeof fetch; base?: string }) {
    this.key = o.apiKey; this.model = o.model; this.f = o.fetch ?? fetch; this.base = o.base ?? 'https://api.anthropic.com';
  }

  private async call(body: unknown, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.f(`${this.base}/v1/messages`, {
        method: 'POST', signal,
        headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok && r.body) return r;
      const retryable = r.status === 429 || r.status === 529 || r.status >= 500;
      if (!retryable || attempt >= 3) {
        const t = await r.text().catch(() => '');
        let msg = t.slice(0, 300);
        try { msg = JSON.parse(t).error?.message ?? msg; } catch { /* keep text */ }
        throw new Error(`Research API returned ${r.status}: ${msg}`);
      }
      const wait = Number(r.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      await new Promise((res) => setTimeout(res, Math.min(wait, 20_000)));
    }
  }

  async run(req: ResearchRequest, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<ResearchResult> {
    const seenUrls: ResearchResult['seenUrls'] = new Map(req.records.map((r) => [r.url, { title: r.title }]));
    const progress: Progress = { stage: 'searching', queries: [], fetched: [] };
    onProgress({ ...progress });
    const articles = req.sources === 'articles';
    const blocked = articles ? { blocked_domains: RECORD_DOMAINS } : {};
    const tools = [
      { type: 'web_search_20250305', name: 'web_search', max_uses: req.maxSearches, user_location: { type: 'approximate', city: req.city.split(',')[0], country: 'US' }, ...blocked },
      ...(req.maxFetches > 0 ? [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: req.maxFetches, max_content_tokens: req.fetchMaxTokens, ...blocked }] : []),
    ];
    const messages: { role: 'user' | 'assistant'; content: any }[] = [{ role: 'user', content: userPrompt(req) }];
    const usage = { input: 0, output: 0, searches: 0 };
    let text = '';
    const onBlock = (b: Block) => {
      if (b.type === 'server_tool_use' && b.name === 'web_search' && b.input?.query) { progress.queries.push(String(b.input.query)); onProgress({ ...progress, queries: [...progress.queries] }); }
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) seenUrls.set(r.url, { title: r.title ?? r.url, pageAge: r.page_age ?? null });
      if (b.type === 'web_fetch_tool_result' && b.content?.url) {
        seenUrls.set(b.content.url, { title: b.content.content?.title ?? b.content.url });
        progress.fetched.push(b.content.url);
        onProgress({ ...progress, fetched: [...progress.fetched] });
      }
      if (b.type === 'text' && Array.isArray(b.citations)) for (const c of b.citations) if (c.url && !seenUrls.has(c.url)) seenUrls.set(c.url, { title: c.title ?? c.url });
    };
    for (let turn = 0; turn < 12; turn++) {
      const r = await this.call({ model: this.model, max_tokens: 16_000, system: systemPrompt(req.sources), messages, tools, stream: true }, signal);
      const m = await readStream(r.body!, onBlock);
      usage.input += m.usage.input; usage.output += m.usage.output; usage.searches += m.usage.searches;
      text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (m.stopReason === 'pause_turn') {
        // Long server-side research paused: send the partial assistant turn back unchanged to continue.
        messages.push({ role: 'assistant', content: m.content });
        continue;
      }
      if (m.stopReason === 'max_tokens' && !/<\/report>/.test(text)) throw new Error('The research ran out of room before writing the report.');
      break;
    }
    onProgress({ ...progress, stage: 'checking' });
    const report = parseReport(text);
    const u = { searches: usage.searches || progress.queries.length, inputTokens: usage.input, outputTokens: usage.output };
    return { report, seenUrls, usage: { ...u, costUsd: costOf(this.model, u) } };
  }
}
