<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import PaperBadge from "./PaperBadge.svelte";
  import type { AccountDto, AccountSummaryDto } from "../api/types.js";
  import { financialTone, formatMoney, formatPercent } from "../format.js";

  interface Props {
    account: AccountDto | null;
    summary: AccountSummaryDto | null;
    accounts: readonly AccountDto[];
    loading: boolean;
    error: string | null;
    busy: boolean;
    notice: string | null;
    onSelectAccount: (accountId: string) => void;
    onCreate: (initialBalance: string) => void;
    onDeposit: (amount: string) => void;
    onWithdraw: (amount: string) => void;
    onReset: (balance: string) => void;
  }
  let { account, summary, accounts, loading, error, busy, notice, onSelectAccount, onCreate, onDeposit, onWithdraw, onReset }: Props = $props();

  let amount = $state("1000");

  function toneClass(value: string | null | undefined): string {
    const tone = financialTone(value ?? null);
    return tone === "positive" ? "positive" : tone === "negative" ? "negative" : "";
  }
</script>

<section class="account surface">
  <header>
    <h2>Paper Account <PaperBadge size="sm" /></h2>
    {#if accounts.length > 1}
      <select value={account?.accountId ?? ""} onchange={(event) => onSelectAccount((event.currentTarget as HTMLSelectElement).value)} aria-label="Pilih akun paper">
        {#each accounts as entry (entry.accountId)}
          <option value={entry.accountId}>{entry.name}</option>
        {/each}
      </select>
    {/if}
  </header>

  {#if loading && summary === null}
    <StateMessage kind="loading" message="Memuat akun…" />
  {:else if error !== null}
    <StateMessage kind="error" message="Gagal memuat akun" detail={error} onAction={account === null ? () => onCreate("10000") : undefined} actionLabel={account === null ? "Buat akun paper" : undefined} />
  {:else if account === null || summary === null}
    <StateMessage kind="empty" message="Belum ada akun paper" detail="Buat akun untuk mulai dogfooding (uang virtual)." />
    <button class="primary" type="button" disabled={busy} onclick={() => onCreate("10000")}>Buat akun paper (10 000 USDT virtual)</button>
  {:else}
    <dl class="grid">
      <div class="row"><dt>Wallet Balance</dt><dd class="tabular">{formatMoney(summary.walletBalance, 8)}</dd></div>
      <div class="row"><dt>Equity</dt><dd class="tabular">{formatMoney(summary.equity, 8)}</dd></div>
      <div class="row"><dt>Available</dt><dd class="tabular">{formatMoney(summary.availableBalance, 8)}</dd></div>
      <div class="row"><dt>Unrealized PnL</dt><dd class="tabular {toneClass(summary.unrealizedPnl)}">{formatMoney(summary.unrealizedPnl, 8)}</dd></div>
      <div class="row"><dt>Position Margin</dt><dd class="tabular">{formatMoney(summary.positionMargin, 8)}</dd></div>
      <div class="row"><dt>Reserved Margin</dt><dd class="tabular">{formatMoney(summary.reservedMargin, 8)}</dd></div>
      <div class="row"><dt>Margin Ratio</dt><dd class="tabular">{summary.marginRatio === null ? "—" : formatPercent(summary.marginRatio, 2)}</dd></div>
      <div class="row"><dt>Open Positions / Orders</dt><dd class="tabular">{summary.openPositionCount} / {summary.openOrderCount}</dd></div>
    </dl>

    {#if summary.valuationStatus !== "fresh"}
      <StateMessage
        kind="stale"
        message={`Valuasi: ${summary.valuationStatus}`}
        detail={summary.unvaluedContracts.length > 0 ? `Tanpa mark: ${summary.unvaluedContracts.join(", ")}` : "Harga pasar belum segar."}
      />
    {/if}

    <div class="actions">
      <label>
        Jumlah (USDT)
        <input class="tabular" bind:value={amount} inputmode="decimal" aria-label="Jumlah USDT" />
      </label>
      <button type="button" disabled={busy} onclick={() => onDeposit(amount)}>Deposit</button>
      <button type="button" disabled={busy} onclick={() => onWithdraw(amount)}>Withdraw</button>
      <button type="button" disabled={busy} onclick={() => onReset(amount)}>Reset</button>
    </div>
    <p class="hint">VIRTUAL FUNDS — bukan saldo exchange nyata.</p>
    {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  {/if}
</section>

<style>
  .account { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
  header { display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  select { margin-left: auto; background: var(--surface-sunken); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 11px; padding: 2px 4px; }
  .grid { margin: 0; display: flex; flex-direction: column; gap: 3px; }
  .row { display: flex; justify-content: space-between; gap: 10px; }
  dt { color: var(--text-muted); font-size: 11px; }
  dd { margin: 0; font-size: 12px; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: end; border-top: 1px solid var(--border); padding-top: 8px; }
  label { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-muted); }
  input { width: 100px; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); padding: 4px 6px; font-size: 12px; }
  button { background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 4px 9px; font-size: 11px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--border-strong); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { width: 100%; padding: 7px; background: var(--accent-soft); border-color: var(--accent); }
  .hint { margin: 0; font-size: 10px; color: var(--warning); letter-spacing: 0.04em; }
  .notice { margin: 0; font-size: 11px; color: var(--text-secondary); }
</style>
