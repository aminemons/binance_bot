'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config');

const SYSTEM_PROMPT = `You are a risk-aware crypto scalping signal reviewer for a Binance Spot Testnet bot.

You will receive:
- A list of pending trade signals produced by three strategies (momentum/RSI+volume, order-book imbalance, breakout-retest).
- The bot's current open positions.
- A snapshot of last price and 1-minute percent change per pair.

For each pending signal, decide whether to APPROVE or REJECT it, and assign a calibrated confidence between 0 and 1.

Rules:
1. Reject any signal that conflicts with an already-open position in the same pair (same pair, opposite side, or duplicate).
2. Be skeptical of imbalance signals when the 1m percent move is already extended in the same direction (chasing risk).
3. Prefer signals where strategy raw_confidence is high AND the 1m move is consistent with the signal side.
4. Reject signals whose raw_confidence is below 0.5 unless market context strongly supports them.
5. Only approve signals you would be willing to risk -0.25% on.

Respond ONLY by calling the approve_signals tool. Do not produce any other text.`;

const TOOL_DEF = {
  name: 'approve_signals',
  description: 'Submit approval/rejection decisions for each pending signal.',
  input_schema: {
    type: 'object',
    properties: {
      approvals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            signal_id: { type: 'integer' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            note: { type: 'string' },
          },
          required: ['signal_id', 'decision', 'confidence', 'note'],
        },
      },
    },
    required: ['approvals'],
  },
};

class Ranker {
  constructor({ apiKey, runner, openPositionsFn, stateSnapshotFn }) {
    if (!apiKey) throw new Error('Ranker: missing ANTHROPIC_API_KEY');
    this.client = new Anthropic({ apiKey });
    this.runner = runner;
    this.openPositionsFn = openPositionsFn;
    this.stateSnapshotFn = stateSnapshotFn;
    this.timer = null;
    this.onApproved = null;
    this.lastResult = null;
  }

  start(onApproved) {
    this.onApproved = onApproved;
    console.log('[ranker] first run in 30s');
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[ranker]', e.message)), config.ranker.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    const signals = this.runner.drain();
    if (signals.length === 0) return;

    const open = this.openPositionsFn();
    const market = this.stateSnapshotFn();
    const userPayload = {
      pending_signals: signals.map((s) => ({
        signal_id: s.id, pair: s.pair, strategy: s.strategy, side: s.side,
        raw_confidence: s.confidence, entry: s.entry, reason: s.reason,
        age_ms: Date.now() - s.ts,
      })),
      open_positions: open.map((t) => ({
        pair: t.pair, side: t.side, entry: t.entry_price, qty: t.qty, strategy: t.strategy,
      })),
      market,
    };

    const resp = await this.client.messages.create({
      model: config.ranker.model,
      max_tokens: config.ranker.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: 'approve_signals' },
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    });

    const block = resp.content.find((b) => b.type === 'tool_use' && b.name === 'approve_signals');
    if (!block) {
      console.warn('[ranker] no tool_use block in response');
      return;
    }
    const approvals = block.input.approvals || [];
    this.lastResult = { ts: Date.now(), approvals, signals };

    const sigMap = new Map(signals.map((s) => [s.id, s]));
    const approved = [];
    for (const a of approvals) {
      const sig = sigMap.get(a.signal_id);
      if (!sig) continue;
      sig.claude = { decision: a.decision, confidence: a.confidence, note: a.note };
      if (a.decision === 'approve' && a.confidence >= config.ranker.minConfidence) {
        approved.push(sig);
      }
    }
    console.log(`[ranker] ${signals.length} signals -> ${approved.length} approved (conf>=${config.ranker.minConfidence})`);
    if (this.onApproved && approved.length) this.onApproved(approved, signals);
    else if (this.onApproved) this.onApproved([], signals);
  }
}

module.exports = Ranker;
