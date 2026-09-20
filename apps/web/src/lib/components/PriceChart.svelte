<script lang="ts">
  import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
  import StateMessage from "./StateMessage.svelte";
  import type { CandleDto } from "../api/types.js";

  interface Props {
    contract: string;
    interval: string;
    candles: readonly CandleDto[];
    loading: boolean;
    error: string | null;
  }
  let { contract, interval, candles, loading, error }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Candlestick"> | null = null;

  /**
   * Chart dibuat SEKALI dan dipertahankan; pembaruan candle hanya memanggil
   * `update()`/`setData()`. Membuat ulang chart pada setiap tick akan mematikan
   * performa dan posisi scroll pengguna.
   */
  $effect(() => {
    if (container === undefined) {
      return;
    }
    const created = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-secondary"),
        fontFamily: "Inter, system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: cssVar("--surface-sunken") },
        horzLines: { color: cssVar("--surface-sunken") },
      },
      rightPriceScale: { borderColor: cssVar("--border") },
      timeScale: { borderColor: cssVar("--border"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    chart = created;
    series = created.addSeries(CandlestickSeries, {
      upColor: cssVar("--positive"),
      downColor: cssVar("--negative"),
      borderUpColor: cssVar("--positive"),
      borderDownColor: cssVar("--negative"),
      wickUpColor: cssVar("--positive"),
      wickDownColor: cssVar("--negative"),
    });
    return () => {
      created.remove();
      chart = null;
      series = null;
    };
  });

  // Data candle: setData saat kontrak/interval berubah, update saat candle terakhir berubah.
  let lastKey = "";
  $effect(() => {
    if (series === null) {
      return;
    }
    const key = `${contract}|${interval}`;
    const points = candles.map((candle) => ({
      time: candle.openTime as unknown as number,
      open: toNumberForChart(candle.open),
      high: toNumberForChart(candle.high),
      low: toNumberForChart(candle.low),
      close: toNumberForChart(candle.close),
    }));
    if (key !== lastKey) {
      lastKey = key;
      series.setData(points as never);
      chart?.timeScale().fitContent();
      return;
    }
    const last = points.at(-1);
    if (last !== undefined) {
      // Hanya candle terakhir yang diperbarui (live candle).
      series.update(last as never);
    }
  });
</script>

<section class="chart surface">
  <div class="head">
    <span>{contract}</span>
    <span class="muted">{interval}</span>
    <span class="muted">candlestick · mark price menggerakkan risiko</span>
  </div>
  <div class="body">
    <div class="canvas" bind:this={container} aria-label={`Chart ${contract} ${interval}`} role="img"></div>
    {#if loading && candles.length === 0}
      <div class="overlay"><StateMessage kind="loading" message="Memuat candle…" /></div>
    {:else if error !== null}
      <div class="overlay"><StateMessage kind="error" message="Gagal memuat candle" detail={error} /></div>
    {:else if candles.length === 0}
      <div class="overlay"><StateMessage kind="empty" message="Belum ada candle tersimpan" detail="Riwayat candle diisi saat feed pasar berjalan." /></div>
    {/if}
  </div>
</section>

<style>
  .chart { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .head { display: flex; gap: 10px; align-items: baseline; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; }
  .muted { color: var(--text-muted); font-weight: 400; font-size: 11px; }
  .body { position: relative; flex: 1; min-height: 0; }
  .canvas { position: absolute; inset: 0; }
  .overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--surface) 80%, transparent); }
</style>

<script lang="ts" module>
  /**
   * Chart memerlukan angka JS. Nilai di sini hanya untuk PENGGAMBARAN dan tidak
   * pernah dikirim kembali ke API (yang selalu memakai string asli).
   */
  export function toNumberForChart(value: string): number {
    return Number(value);
  }
  function cssVar(name: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value === "" ? "#888" : value;
  }
</script>
