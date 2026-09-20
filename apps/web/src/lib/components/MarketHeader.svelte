<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { ContractDto } from "../api/types.js";
  import type { MarketStateView } from "../stores/terminal.svelte.js";
  import { formatAge, formatPrice, formatPercent, formatTime, stripTrailingZeros } from "../format.js";

  interface Props {
    contract: string;
    spec: ContractDto | null;
    state: MarketStateView | null;
    nowMs: number;
    stale: boolean;
    loading: boolean;
  }
  let { contract, spec, state, nowMs, stale, loading }: Props = $props();

  const markAge = $derived(
    state?.markSourceTimestampMs == null ? null : nowMs - state.markSourceTimestampMs,
  );
  const spread = $derived.by(() => {
    if (state?.bestBid == null || state?.bestAsk == null) {
      return null;
    }
    return { bid: state.bestBid, ask: state.bestAsk };
  });
</script>

<section class="market-header surface">
  <div class="title">
    <h1>{contract}</h1>
    {#if spec}<span class="muted">max {stripTrailingZeros(spec.leverageMax)}× · tick {spec.priceTick} · fee {spec.takerFeeRate} (taker)</span>{/if}
  </div>

  {#if loading && state === null}
    <StateMessage kind="loading" message="Menunggu data pasar…" />
  {:else if state === null || (state.markPrice === null && state.lastPrice === null)}
    <StateMessage kind="disconnected" message="Belum ada data pasar untuk kontrak ini" detail="Pilih kontrak lain atau tunggu feed." />
  {:else}
    <dl class="grid" data-stale={stale}>
      <!-- MARK dibedakan karena ia yang menggerakkan UPnL, likuidasi, dan TP/SL. -->
      <div class="cell mark">
        <dt>Mark <span class="hint" title="Mark price menggerakkan unrealized PnL, likuidasi, dan trigger TP/SL.">ⓘ</span></dt>
        <dd class="tabular" style:color={stale ? "var(--warning)" : "var(--text-primary)"}>
          {formatPrice(state.markPrice)}
        </dd>
        <span class="age">{stale ? "BASI · " : ""}age {formatAge(markAge)}</span>
      </div>
      <div class="cell">
        <dt>Last</dt>
        <dd class="tabular">{formatPrice(state.lastPrice)}</dd>
      </div>
      <div class="cell">
        <dt>Index</dt>
        <dd class="tabular">{formatPrice(state.indexPrice)}</dd>
      </div>
      <div class="cell">
        <dt>Funding</dt>
        <dd class="tabular">{formatPercent(state.fundingRate, 4)}</dd>
        <span class="age">next {formatTime(state.fundingNextApplyMs, true)}</span>
      </div>
      <div class="cell">
        <dt>Best Bid</dt>
        <dd class="tabular positive">{formatPrice(spread?.bid ?? null)}</dd>
        <span class="age">size {state.bestBidSize ?? "—"}</span>
      </div>
      <div class="cell">
        <dt>Best Ask</dt>
        <dd class="tabular negative">{formatPrice(spread?.ask ?? null)}</dd>
        <span class="age">size {state.bestAskSize ?? "—"}</span>
      </div>
    </dl>
    {#if stale}
      <StateMessage kind="stale" message="Harga pasar sudah basi — nilai tidak ditampilkan sebagai terkini." />
    {/if}
  {/if}
</section>

<style>
  .market-header { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { font-size: 15px; margin: 0; letter-spacing: 0.01em; }
  .muted { color: var(--text-muted); font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(6, minmax(90px, 1fr)); gap: 8px; margin: 0; }
  .cell { display: flex; flex-direction: column; gap: 1px; }
  dt { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  dd { margin: 0; font-size: 13px; }
  .age { color: var(--text-muted); font-size: 10px; }
  .mark dt { color: var(--text-secondary); }
  .hint { cursor: help; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
</style>
