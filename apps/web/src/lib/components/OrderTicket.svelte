<script lang="ts">
  import PaperBadge from "./PaperBadge.svelte";
  import StateMessage from "./StateMessage.svelte";
  import type { ContractDto } from "../api/types.js";
  import type { MarketStateView } from "../stores/terminal.svelte.js";
  import { buildOrderPreview, clampLeverage, type TicketSide, type TicketType } from "../trade/preview.js";
  import { decimalPlaces, isDecimal } from "../trade/decimal.js";
  import { formatMoney, formatPrice, toApiDecimal } from "../format.js";
  import { isBusy, statusText, type TicketState } from "../trade/ticket.js";

  interface Props {
    contract: string;
    spec: ContractDto | null;
    market: MarketStateView | null;
    availableBalance: string | null;
    ticket: TicketState;
    /** Dinaikkan setelah submit sukses: bersihkan field spesifik order saja. */
    resetToken?: number;
    onSubmit: (input: {
      side: TicketSide;
      type: TicketType;
      size: string;
      leverage: string;
      limitPrice: string | null;
      takeProfitPrice: string | null;
      stopLossPrice: string | null;
    }) => void;
    onRetryPending: () => void;
    onAbandonPending: () => void;
  }
  let { contract, spec, market, availableBalance, ticket, resetToken = 0, onSubmit, onRetryPending, onAbandonPending }: Props = $props();

  // Nilai input disimpan sebagai STRING MENTAH (tidak pernah Number).
  let side = $state<TicketSide>("buy");
  let type = $state<TicketType>("market");
  let size = $state("1");
  let leverage = $state("10");
  let limitPrice = $state("");
  let tpPrice = $state("");
  let slPrice = $state("");

  // Kontrak berubah → field spesifik kontrak direset agar tidak membawa harga
  // kontrak sebelumnya.
  // Nilai awal saja (disengaja): dipakai mendeteksi PERGANTIAN kontrak.
  // svelte-ignore state_referenced_locally
  let lastContract = $state(contract);
  $effect(() => {
    if (contract !== lastContract) {
      lastContract = contract;
      limitPrice = "";
      tpPrice = "";
      slPrice = "";
      size = spec !== null && !spec.enableDecimal ? String(spec.orderSizeMin || 1) : "0.001";
      leverage = spec === null ? "10" : clampLeverage(spec, leverage);
    }
  });

  // Setelah sukses: kosongkan size & TP/SL, pertahankan arah/tipe/leverage.
  let lastReset = $state(0);
  $effect(() => {
    if (resetToken !== lastReset) {
      lastReset = resetToken;
      tpPrice = "";
      slPrice = "";
      size = spec !== null && !spec.enableDecimal ? String(spec.orderSizeMin || 1) : "0.001";
    }
  });

  const quote = $derived({
    bestBid: market?.bestBid ?? null,
    bestAsk: market?.bestAsk ?? null,
    bestBidSize: market?.bestBidSize ?? null,
    bestAskSize: market?.bestAskSize ?? null,
    markPrice: market?.markPrice ?? null,
  });

  const preview = $derived(
    buildOrderPreview({
      spec,
      side,
      type,
      size,
      leverage,
      limitPrice: type === "limit" ? (limitPrice === "" ? null : limitPrice) : null,
      takeProfitPrice: tpPrice === "" ? null : tpPrice,
      stopLossPrice: slPrice === "" ? null : slPrice,
      market: quote,
      availableBalance,
    }),
  );

  const hasQuote = $derived(quote.bestBid !== null || quote.bestAsk !== null);
  const pending = $derived(isBusy(ticket));
  const canSubmit = $derived(preview.valid && !pending && (type === "limit" || hasQuote));

  function submit(): void {
    if (!canSubmit) {
      return;
    }
    // Nilai MENTAH yang dikirim — bukan hasil format tampilan.
    onSubmit({
      side,
      type,
      size: toApiDecimal(size),
      leverage: toApiDecimal(leverage),
      limitPrice: type === "limit" ? toApiDecimal(limitPrice) : null,
      takeProfitPrice: tpPrice === "" ? null : toApiDecimal(tpPrice),
      stopLossPrice: slPrice === "" ? null : toApiDecimal(slPrice),
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    // Enter hanya mengirim dari dalam form tiket, tidak dari panel lain.
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const sizeHint = $derived.by(() => {
    if (spec === null || !isDecimal(size)) {
      return null;
    }
    return {
      step: spec.enableDecimal ? undefined : 1,
      tick: spec.priceTick,
      tickDp: decimalPlaces(spec.priceTick),
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="ticket surface" aria-label="Order ticket PAPER" tabindex="-1" onkeydown={onKeydown}>
  <header>
    <h2>Trade <PaperBadge size="sm" /></h2>
    <span class="contract">{contract}</span>
  </header>

  <!-- Sisi: teks + ikon, bukan hanya warna. -->
  <div class="sides" role="group" aria-label="Arah posisi">
    <button
      type="button"
      class="side long"
      aria-pressed={side === "buy"}
      onclick={() => (side = "buy")}
    >▲ LONG</button>
    <button
      type="button"
      class="side short"
      aria-pressed={side === "sell"}
      onclick={() => (side = "sell")}
    >▼ SHORT</button>
  </div>

  <div class="types" role="group" aria-label="Tipe order">
    <button type="button" aria-pressed={type === "market"} onclick={() => (type = "market")}>MARKET</button>
    <button type="button" aria-pressed={type === "limit"} onclick={() => (type = "limit")}>LIMIT</button>
  </div>

  <div class="quote">
    <span>Bid <b class="tabular">{formatPrice(quote.bestBid)}</b></span>
    <span>Ask <b class="tabular">{formatPrice(quote.bestAsk)}</b></span>
    <span>Mark <b class="tabular">{formatPrice(quote.markPrice)}</b></span>
  </div>

  <div class="fields">
    <label>
      Size (kontrak)
      <input
        class="tabular"
        inputmode="decimal"
        bind:value={size}
        aria-describedby="size-hint"
        aria-invalid={preview.errors.some((error) => error.startsWith("Size"))}
      />
      <span id="size-hint" class="hint">
        {#if preview.baseQuantity !== null && preview.notional !== null}
          {size} kontrak ≈ {preview.baseQuantity} {spec?.base ?? ""} ≈ {formatPrice(preview.notional)} USDT
        {:else if sizeHint !== null}
          min {spec?.orderSizeMin} · maks {spec?.orderSizeMax}{sizeHint.step === 1 ? " · hanya bulat" : ""}
        {/if}
      </span>
    </label>

    <label>
      Leverage
      <div class="lev">
        <input class="tabular" inputmode="decimal" bind:value={leverage} aria-label="Leverage" />
        <input
          type="range"
          min={spec?.leverageMin ?? "1"}
          max={spec?.leverageMax ?? "100"}
          step="1"
          value={isDecimal(leverage) ? leverage : "1"}
          oninput={(event) => (leverage = (event.currentTarget as HTMLInputElement).value)}
          aria-label="Slider leverage"
        />
        <span class="tabular">{leverage}×</span>
      </div>
    </label>

    {#if type === "limit"}
      <label>
        Limit Price (tick {spec?.priceTick ?? "—"})
        <input class="tabular" inputmode="decimal" bind:value={limitPrice} aria-label="Harga limit" />
      </label>
    {/if}

    <label>
      Take Profit <span class="opt">opsional</span>
      <input class="tabular" inputmode="decimal" bind:value={tpPrice} aria-label="Take profit" />
    </label>
    <label>
      Stop Loss <span class="opt">opsional</span>
      <input class="tabular" inputmode="decimal" bind:value={slPrice} aria-label="Stop loss" />
    </label>
  </div>

  <p class="trigger-note">TP/SL dipicu oleh <b>MARK</b>; harga eksekusi dapat berbeda, terutama saat gap.</p>

  <!-- Ringkasan konfirmasi: tiket sendiri adalah permukaan konfirmasi. -->
  <dl class="summary">
    <div><dt>Tipe</dt><dd>{type === "market" ? "MARKET" : "LIMIT"}</dd></div>
    <div><dt>Estimasi Entry</dt><dd class="tabular">{formatPrice(preview.estimatedEntry)}</dd></div>
    <div><dt>Notional</dt><dd class="tabular">{preview.notional === null ? "—" : `~${formatPrice(preview.notional)} USDT`}</dd></div>
    <div><dt>Est. Margin</dt><dd class="tabular">{preview.estimatedMargin === null ? "—" : `~${formatMoney(preview.estimatedMargin, 8)}`}</dd></div>
    <div><dt>Est. Fee ({preview.liquidity ?? "—"})</dt><dd class="tabular">{preview.estimatedFee === null ? "—" : `~${formatMoney(preview.estimatedFee, 8)}`}</dd></div>
    {#if preview.estimatedReservation !== null}
      <div><dt>Reservasi Margin</dt><dd class="tabular">~{formatMoney(preview.estimatedReservation, 8)}</dd></div>
    {/if}
    <div><dt>Available</dt><dd class="tabular">{formatMoney(availableBalance, 2)}</dd></div>
  </dl>

  {#if preview.errors.length > 0}
    <ul class="errors" role="alert">
      {#each preview.errors as error (error)}<li>{error}</li>{/each}
    </ul>
  {/if}
  {#if preview.warnings.length > 0}
    <ul class="warnings">
      {#each preview.warnings as warning (warning)}<li>{warning}</li>{/each}
    </ul>
  {/if}
  {#if !hasQuote && type === "market"}
    <StateMessage kind="stale" message="Menunggu kutipan eksekusi…" detail="Order market memerlukan bid/ask yang dapat dieksekusi." />
  {/if}

  <div class="submit">
    <button
      type="button"
      class={side === "buy" ? "primary long" : "primary short"}
      disabled={!canSubmit}
      aria-busy={pending}
      onclick={submit}
    >
      {side === "buy" ? "OPEN LONG" : "OPEN SHORT"} · PAPER
    </button>
  </div>

  {#if pending}
    <div class="pending" role="status">
      <p>{statusText(ticket)}</p>
      {#if ticket.state === "outcome_uncertain"}
        <div class="pending-actions">
          <button type="button" onclick={onRetryPending}>Cek ulang (commandId sama)</button>
          <button type="button" onclick={onAbandonPending}>Batalkan aksi</button>
        </div>
        <span class="hint">Payload dibekukan; penyuntingan tidak mengubah perintah yang dipending.</span>
      {/if}
    </div>
  {:else if ticket.state === "definitively_failed" && ticket.message !== null}
    <p class="failed" role="alert">
      {ticket.message}
      {#if ticket.errorCode !== null}<span class="code">{ticket.errorCode}</span>{/if}
    </p>
  {:else if ticket.state === "succeeded"}
    <p class="ok" role="status">Order PAPER diterima — menunggu pembaruan dari backend.</p>
  {/if}

  <p class="paper-note">
    PAPER · VIRTUAL FUNDS — order dieksekusi terhadap data pasar (LIVE MARKET), bukan ke exchange.
  </p>
</section>

<style>
  .ticket { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; }
  header { display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  .contract { margin-left: auto; font-size: 12px; font-weight: 600; }
  .sides, .types { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .side, .types button {
    padding: 6px 8px; font-size: 11px; font-weight: 600; cursor: pointer;
    background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-secondary);
    border-radius: var(--radius-sm);
  }
  .sides .long[aria-pressed="true"] { background: var(--positive-soft); border-color: var(--positive); color: var(--positive); }
  .sides .short[aria-pressed="true"] { background: var(--negative-soft); border-color: var(--negative); color: var(--negative); }
  .types button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--text-primary); }
  .quote { display: flex; gap: 10px; font-size: 11px; color: var(--text-muted); }
  .quote b { color: var(--text-primary); }
  .fields { display: flex; flex-direction: column; gap: 6px; }
  label { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .opt { text-transform: none; color: var(--text-muted); }
  input {
    background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary);
    border-radius: var(--radius-sm); padding: 4px 6px; font-size: 12px; width: 100%;
  }
  input[aria-invalid="true"] { border-color: var(--negative); }
  .lev { display: grid; grid-template-columns: 62px 1fr 42px; align-items: center; gap: 6px; }
  .lev span { text-align: right; font-size: 11px; }
  .hint { font-size: 10px; color: var(--text-muted); text-transform: none; letter-spacing: 0; }
  .trigger-note { margin: 0; font-size: 10px; color: var(--text-muted); }
  .summary { margin: 0; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 6px; }
  .summary div { display: flex; justify-content: space-between; gap: 8px; }
  .summary dt { color: var(--text-muted); font-size: 10px; }
  .summary dd { margin: 0; font-size: 11px; }
  .errors, .warnings { margin: 0; padding-left: 16px; font-size: 10px; }
  .errors { color: var(--negative); }
  .warnings { color: var(--warning); }
  .submit button {
    width: 100%; padding: 8px; font-size: 12px; font-weight: 700; cursor: pointer;
    border-radius: var(--radius-sm); border: 1px solid;
  }
  .primary.long { background: var(--positive-soft); border-color: var(--positive); color: var(--positive); }
  .primary.short { background: var(--negative-soft); border-color: var(--negative); color: var(--negative); }
  .primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .pending { font-size: 11px; color: var(--text-secondary); }
  .pending p { margin: 0 0 4px; }
  .pending-actions { display: flex; gap: 6px; }
  .pending-actions button { background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 3px 8px; font-size: 10px; cursor: pointer; }
  .failed { color: var(--negative); font-size: 11px; margin: 0; }
  .code { margin-left: 6px; color: var(--text-muted); font-size: 10px; }
  .ok { color: var(--positive); font-size: 11px; margin: 0; }
  .paper-note { margin: 0; font-size: 10px; color: var(--warning); }
</style>
