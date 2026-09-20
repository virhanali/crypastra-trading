<script lang="ts">
  import StateMessage from "./StateMessage.svelte";
  import type { OrderDto } from "../api/types.js";
  import { formatInteger, formatPrice, formatTime } from "../format.js";

  interface Props {
    orders: readonly OrderDto[];
    loading: boolean;
    error: string | null;
    /** Aksi cancel; hanya untuk order yang masih hidup. */
    pendingOrderId?: string | null;
    actionError?: string | null;
    onCancel?: (order: OrderDto) => void;
  }
  let { orders, loading, error, pendingOrderId = null, actionError = null, onCancel }: Props = $props();

  /** Hanya order resting yang bisa dibatalkan (bukan hasil tebakan dari fill). */
  function cancellable(order: OrderDto): boolean {
    return order.status === "open" || order.status === "partially_filled";
  }

  /** Status datang dari BACKEND; tidak disimpulkan dari fill. */
  function statusTone(status: string): string {
    if (status === "filled") return "positive";
    if (status === "rejected" || status === "cancelled" || status === "expired") return "negative";
    if (status === "partially_filled") return "warning";
    return "";
  }
</script>

{#if loading && orders.length === 0}
  <StateMessage kind="loading" message="Memuat order…" />
{:else if error !== null}
  <StateMessage kind="error" message="Gagal memuat order" detail={error} />
{:else if orders.length === 0}
  <StateMessage kind="empty" message="No resting orders" detail="Order paper akan tampil di sini." />
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">Created</th><th scope="col">Contract</th><th scope="col">Side</th><th scope="col">Type</th>
          <th scope="col" class="num">Price</th><th scope="col" class="num">Size</th><th scope="col" class="num">Filled</th>
          <th scope="col" class="num">Remaining</th><th scope="col" class="num">Lev</th><th scope="col">Status</th><th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each orders as order (order.id)}
          <tr>
            <td class="tabular">{formatTime(order.createdAt, true)}</td>
            <td>{order.contract}</td>
            <td class={order.side === "buy" ? "positive" : "negative"}>{order.side === "buy" ? "▲ BUY" : "▼ SELL"}</td>
            <td class="muted">{order.type} · {order.timeInForce}{order.reduceOnly ? " · reduce-only" : ""}</td>
            <td class="num tabular">{order.type === "market" ? "MARKET" : formatPrice(order.price)}</td>
            <td class="num tabular">{formatInteger(order.size)}</td>
            <td class="num tabular">{formatInteger(order.filledSize)}</td>
            <td class="num tabular">{formatInteger(order.remainingSize)}</td>
            <td class="num tabular">{formatInteger(order.leverage)}×</td>
            <td class={statusTone(order.status)} title={order.rejectReason ?? ""}>{order.status}</td>
            <td>
              {#if cancellable(order) && onCancel}
                <button
                  type="button"
                  class="action"
                  disabled={pendingOrderId === order.id}
                  aria-busy={pendingOrderId === order.id}
                  onclick={() => onCancel(order)}
                >
                  {pendingOrderId === order.id ? "Membatalkan…" : "Cancel"}
                </button>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if actionError !== null}<p class="action-error" role="alert">{actionError}</p>{/if}
{/if}

<style>
  .scroll { overflow: auto; max-height: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; background: var(--surface-raised); color: var(--text-muted); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--surface-sunken); white-space: nowrap; }
  .num { text-align: right; }
  .positive { color: var(--positive); }
  .negative { color: var(--negative); }
  .warning { color: var(--warning); }
  .muted { color: var(--text-muted); font-size: 11px; }
  .action {
    background: var(--surface-sunken); border: 1px solid var(--border); color: var(--text-primary);
    border-radius: var(--radius-sm); padding: 2px 7px; font-size: 10px; cursor: pointer;
  }
  .action:hover:not(:disabled) { border-color: var(--border-strong); }
  .action:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-error { margin: 4px 8px; font-size: 10px; color: var(--negative); }
</style>
