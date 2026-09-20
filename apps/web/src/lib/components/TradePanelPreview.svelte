<script lang="ts">
  import type { MarketStateView } from "../stores/terminal.svelte.js";
  import { formatMoney, formatPrice } from "../format.js";

  interface Props {
    contract: string;
    state: MarketStateView | null;
    availableBalance: string | null;
  }
  let { contract, state, availableBalance }: Props = $props();
</script>

<section class="trade surface" aria-label="Panel trading (belum aktif)">
  <header>
    <h2>Trade</h2>
    <span class="phase">Phase 7B</span>
  </header>
  <dl>
    <div class="row"><dt>Contract</dt><dd class="tabular">{contract}</dd></div>
    <div class="row"><dt>Bid</dt><dd class="tabular positive">{formatPrice(state?.bestBid ?? null)}</dd></div>
    <div class="row"><dt>Ask</dt><dd class="tabular negative">{formatPrice(state?.bestAsk ?? null)}</dd></div>
    <div class="row"><dt>Available</dt><dd class="tabular">{formatMoney(availableBalance, 2)}</dd></div>
  </dl>
  <div class="placeholder" aria-disabled="true">
    Trade Controls — Phase 7B
    <span>Order ticket, leverage, TP/SL, cancel, dan close belum diaktifkan.</span>
  </div>
</section>

<style>
  .trade { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
  header { display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
  .phase { margin-left: auto; font-size: 10px; color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 5px; }
  dl { margin: 0; display: flex; flex-direction: column; gap: 3px; }
  .row { display: flex; justify-content: space-between; gap: 10px; }
  dt { color: var(--text-muted); font-size: 11px; }
  dd { margin: 0; font-size: 12px; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
  .placeholder {
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    padding: 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
