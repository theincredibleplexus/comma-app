// ─── AI Provider — direct browser-to-API streaming ───────────────────────────
// Supports: Anthropic (Claude), OpenAI (ChatGPT), Google (Gemini)
// No proxy, no server, no middleware.

const SYSTEM_PROMPT = `You are a financial insights assistant for Comma, an Australian personal finance dashboard. The user has uploaded their bank transaction data and you have access to a summary of their finances.

Guidelines:
- All amounts are in Australian dollars (AUD)
- Be specific and reference actual numbers from their data
- Give actionable advice, not generic tips
- Be direct and concise — no fluff
- If you spot concerning patterns (high spending in a category, declining savings), mention them constructively
- You can suggest categories for uncategorised transactions if asked
- Never ask for bank credentials, passwords, or personal identification
- You are not a licensed financial adviser — note this if giving investment-related opinions`;

// ─── SSE stream reader ────────────────────────────────────────────────────────
async function readSSEStream(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      onLine(line);
    }
  }
  // flush any remainder
  if (buf) onLine(buf);
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Stream a chat completion from the selected AI provider.
 *
 * @param {string}   provider  'anthropic' | 'openai' | 'google'
 * @param {string}   apiKey
 * @param {string}   model     e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'gemini-2.0-flash'
 * @param {Array}    messages  [{role:'user'|'assistant', content:string}]
 * @param {Function} onChunk   (text: string) => void
 * @param {Function} onDone    () => void
 * @param {Function} onError   (error: Error) => void
 */
export async function streamChat(provider, apiKey, model, messages, onChunk, onDone, onError) {
  try {
    if (provider === 'anthropic') {
      await streamAnthropic(apiKey, model, messages, onChunk);
    } else if (provider === 'openai') {
      await streamOpenAI(apiKey, model, messages, onChunk);
    } else if (provider === 'google') {
      await streamGoogle(apiKey, model, messages, onChunk);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
    onDone();
  } catch (err) {
    onError(err);
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────
async function streamAnthropic(apiKey, model, messages, onChunk) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message || `Anthropic error ${res.status}`);
  }

  await readSSEStream(res, line => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
      const ev = JSON.parse(data);
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        onChunk(ev.delta.text);
      }
    } catch {}
  });
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────
async function streamOpenAI(apiKey, model, messages, onChunk) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message || `OpenAI error ${res.status}`);
  }

  await readSSEStream(res, line => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
      const text = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (text) onChunk(text);
    } catch {}
  });
}

// ─── Google Gemini ────────────────────────────────────────────────────────────
async function streamGoogle(apiKey, model, messages, onChunk) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
    }),
  });

  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message || `Gemini error ${res.status}`);
  }

  await readSSEStream(res, line => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    try {
      const text = JSON.parse(data)?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) onChunk(text);
    } catch {}
  });
}

// ─── Financial context builder ────────────────────────────────────────────────
/**
 * Build a concise financial context string from dashboard state.
 * Prepend this to the user's first message in a conversation.
 *
 * @param {Object} dashboardData
 * @param {Array}  dashboardData.pnl              [{m, i, s, n}]
 * @param {Array}  dashboardData.hcats            [{n, t}]  (spending categories)
 * @param {Array}  dashboardData.goals            [{name, targetAmount, savedSoFar}]
 * @param {number} dashboardData.netWorth         current net worth in $
 * @param {number} dashboardData.uncatCount       uncategorised transaction count
 * @param {boolean} dashboardData.isLiveData      whether live bank data is loaded
 * @param {number}  dashboardData.bankTxCount     total transactions loaded
 * @returns {string}
 */
export function buildFinancialContext(dashboardData) {
  const { pnl = [], hcats = [], goals = [], netWorth, uncatCount = 0, isLiveData = false, bankTxCount = 0 } = dashboardData;

  const lines = [];

  // Data source
  lines.push(isLiveData
    ? `[Live bank data: ${bankTxCount} transactions]`
    : '[Demo data — user has not uploaded bank transactions]');

  // Monthly averages
  if (pnl.length > 0) {
    const avgIncome = Math.round(pnl.reduce((s, r) => s + r.i, 0) / pnl.length);
    const avgSpend  = Math.round(pnl.reduce((s, r) => s + r.s, 0) / pnl.length);
    const avgNet    = Math.round(pnl.reduce((s, r) => s + r.n, 0) / pnl.length);
    const savingsRate = avgIncome > 0 ? ((avgNet / avgIncome) * 100).toFixed(1) : '0.0';
    lines.push(`Monthly averages (${pnl.length} months): income $${avgIncome.toLocaleString()}, spending $${avgSpend.toLocaleString()}, net $${avgNet >= 0 ? '+' : ''}${avgNet.toLocaleString()}`);
    lines.push(`Savings rate: ${savingsRate}%`);

    // Month-by-month for context
    const recent = pnl.slice(-3);
    if (recent.length > 0) {
      const summary = recent.map(m => `${m.m}: income $${m.i.toLocaleString()}, spend $${m.s.toLocaleString()}, net ${m.n >= 0 ? '+' : ''}$${Math.abs(m.n).toLocaleString()}`).join(' | ');
      lines.push(`Recent months: ${summary}`);
    }
  }

  // Net worth
  if (netWorth != null) {
    lines.push(`Net worth: $${Math.round(netWorth).toLocaleString()}`);
  }

  // Top spending categories
  if (hcats.length > 0) {
    const sorted = [...hcats].sort((a, b) => b.t - a.t).slice(0, 5);
    const catSummary = sorted.map(c => `${c.n} $${c.t.toLocaleString()}`).join(', ');
    lines.push(`Top spending categories: ${catSummary}`);
  }

  // Goals
  if (goals.length > 0) {
    const goalSummary = goals.map(g => {
      const pct = g.targetAmount > 0 ? Math.round((g.savedSoFar / g.targetAmount) * 100) : 0;
      return `${g.name} ($${(g.savedSoFar || 0).toLocaleString()} of $${(g.targetAmount || 0).toLocaleString()}, ${pct}%)`;
    }).join('; ');
    lines.push(`Goals: ${goalSummary}`);
  }

  // Uncategorised
  if (uncatCount > 0) {
    lines.push(`Uncategorised transactions: ${uncatCount}`);
  }

  return `--- Financial Context ---\n${lines.join('\n')}\n--- End Context ---\n\n`;
}
