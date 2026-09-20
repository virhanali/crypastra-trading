import {
  Decimal,
  FeeResult,
  markFreshness,
  OrderIntentSchema,
  parseMarkSnapshot,
  type BookSnapshot,
  type ExecutionQuote,
  type OrderIntent,
} from "@crypastra/core";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { integrityReport } from "../repositories/integrity.js";
import { CandleRepository } from "../repositories/candle-repository.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { DomainEventRepository } from "../repositories/domain-event-repository.js";
import { FillRepository } from "../repositories/fill-repository.js";
import { LedgerRepository } from "../repositories/ledger-repository.js";
import { OrderRepository } from "../repositories/order-repository.js";
import { PositionRepository } from "../repositories/position-repository.js";
import {
  executionQuoteFrom,
  type MarketSnapshotProvider,
} from "../market/market-snapshot-provider.js";
import { AccountService } from "../services/account-service.js";
import { MarkToMarketService } from "../services/mark-to-market-service.js";
import { OrderService } from "../services/order-service.js";
import { PositionService } from "../services/position-service.js";
import { toApiError, validationFailed } from "./errors.js";
import {
  AccountIdParam,
  AmendProtectionRequestSchema,
  CancelOrderRequestSchema,
  ClosePositionRequestSchema,
  CreateAccountRequestSchema,
  DepositRequestSchema,
  EvaluateOrderRequestSchema,
  ListQuerySchema,
  IdPaginationQuerySchema,
  SeqPaginationQuerySchema,
  ResetRequestSchema,
  SimulationMarketRequestSchema,
  SubmitOrderRequestSchema,
  WithdrawRequestSchema,
  paginate,
  serializeAccount,
  serializeContract,
  serializeDomainEvent,
  serializeFill,
  serializeLedgerEntry,
  serializeMark,
  serializeOrder,
  serializePosition,
  serializeValuation,
} from "./dto.js";

export type ServerMode = "simulation" | "live";

export interface AppOptions {
  readonly connection: DatabaseConnection;
  readonly market: MarketSnapshotProvider;
  readonly now?: () => number;
  /**
   * Mode runtime. `live` memakai feed pasar nyata: endpoint simulasi dimatikan
   * secara default dan readiness ikut mempertimbangkan kesehatan feed.
   */
  readonly mode?: ServerMode;
  /** Endpoint simulasi. Default: aktif hanya di mode `simulation`. */
  readonly enableSimulation?: boolean;
  /** Runtime pasar live (diisi di mode live) untuk health/readiness. */
  readonly feedHealth?: () => FeedHealthView;
  /**
   * Detail pasar lengkap per kontrak (hanya tersedia bila runtime pasar aktif).
   * Bila tidak ada, endpoint pasar menyajikan bidang yang dapat diturunkan dari
   * provider dan `null` untuk sisanya — tidak pernah dikarang.
   */
  readonly marketDetail?: (contract: string) => MarketDetailView | null;
  readonly corsOrigin?: string | false;
  readonly logger?: boolean;
}

/** Bidang pasar yang disajikan ke UI. Yang tidak tersedia tetap null. */
export interface MarketDetailView {
  readonly contract: string;
  readonly markPrice: string | null;
  readonly markSourceTimestampMs: number | null;
  readonly markStatus: "fresh" | "stale" | "missing";
  readonly lastPrice: string | null;
  readonly indexPrice: string | null;
  readonly fundingRate: string | null;
  readonly fundingNextApplyMs: number | null;
  readonly bestBid: string | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: string | null;
  readonly bestAskSize: number | null;
  readonly depthStatus: "syncing" | "synced" | "unsynced" | null;
}

export interface FeedHealthView {
  readonly state: string;
  readonly ready: boolean;
  readonly [key: string]: unknown;
}

export interface AppContext {
  readonly app: FastifyInstance;
  readonly mode: ServerMode;
  readonly simulationEnabled: boolean;
  readonly services: {
    readonly accounts: AccountService;
    readonly orders: OrderService;
    readonly positions: PositionService;
    readonly market: MarkToMarketService;
  };
  readonly market: MarketSnapshotProvider;
}

const API = "/api/v1";

/** Helper validasi: melempar ApiError VALIDATION_ERROR yang stabil. */
function parse<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationFailed(`${label} tidak valid`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function createApp(options: AppOptions): AppContext {
  const { connection, market } = options;
  const mode: ServerMode = options.mode ?? "simulation";
  const simulationEnabled = options.enableSimulation ?? mode === "simulation";
  const clock = { nowMs: options.now ?? (() => Date.now()) };

  const accounts = new AccountService({ connection, clock });
  const orders = new OrderService({ connection });
  const positions = new PositionService({ connection });
  const markToMarket = new MarkToMarketService({ connection });

  const contracts = new ContractRepository(connection);
  const orderRepo = new OrderRepository(connection);
  const fillRepo = new FillRepository(connection);
  const ledgerRepo = new LedgerRepository(connection);
  const positionRepo = new PositionRepository(connection);
  const domainEvents = new DomainEventRepository(connection);

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
  });

  if (options.corsOrigin !== false) {
    app.addHook("onRequest", async (request, reply) => {
      reply.header("access-control-allow-origin", options.corsOrigin ?? "*");
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
      if (request.method === "OPTIONS") {
        await reply.code(204).send();
      }
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const apiError = toApiError(error);
    void reply.code(apiError.statusCode).send(apiError.toBody());
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Rute tidak ditemukan", details: {} } });
  });

  // ── health ──────────────────────────────────────────────────────

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    let databaseReady = true;
    try {
      connection.sqlite.query("SELECT 1").get();
    } catch {
      databaseReady = false;
    }
    const feed = options.feedHealth?.() ?? null;
    // Di mode live, feed pasar yang tidak sehat berarti TIDAK ready.
    const feedReady = mode === "live" ? feed?.ready === true : true;
    const ready = databaseReady && feedReady;
    if (!ready) {
      return reply.code(503).send({
        status: "not_ready",
        checks: { database: databaseReady, marketFeed: feedReady },
        feed,
      });
    }
    return { status: "ready", checks: { database: true, marketFeed: feedReady }, mode };
  });

  // ── market read models (Phase 7A) ───────────────────────────────

  const candleRepo = new CandleRepository(connection);

  app.get(`${API}/market/candles`, async (request, reply) => {
    const query = parse(
      z
        .object({
          contract: z.string().trim().min(1),
          interval: z.string().trim().min(1).default("5m"),
          limit: z.coerce.number().int().min(1).max(1000).default(300),
        })
        .strict(),
      request.query,
      "query",
    );
    const candles = candleRepo.listLatest(query.contract, query.interval, query.limit);
    return reply.send({
      contract: query.contract,
      interval: query.interval,
      candles: candles.map((candle) => ({
        openTime: candle.openTimeSeconds,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: String(candle.v),
        closed: candle.windowClosed,
      })),
    });
  });

  app.get(`${API}/market/state`, async (request, reply) => {
    const query = parse(
      z.object({ contracts: z.string().trim().min(1) }).strict(),
      request.query,
      "query",
    );
    const contracts = query.contracts
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 50);
    if (contracts.length === 0) {
      throw validationFailed("contracts wajib diisi");
    }
    return reply.send({
      mode,
      asOf: clock.nowMs(),
      contracts: contracts.map((contract) => marketDetailFor(contract)),
    });
  });

  app.get(`${API}/market/health`, async () => {
    const feed = options.feedHealth?.() ?? null;
    return {
      mode,
      feed,
      markStatus: feed === null ? [] : (feed.markStatus as unknown) ?? [],
    };
  });

  app.get(`${API}/health/integrity`, async (_request, reply) => {
    const report = integrityReport(connection);
    const healthy = report.mismatches.length === 0;
    if (!healthy) {
      return reply.code(503).send({
        status: "failed",
        tableCount: report.tableCount,
        accountCount: report.accountCount,
        ledgerCount: report.ledgerCount,
        mismatches: report.mismatches,
      });
    }
    return {
      status: "ok",
      tableCount: report.tableCount,
      accountCount: report.accountCount,
      ledgerCount: report.ledgerCount,
      mismatches: [],
    };
  });

  // ── contracts ───────────────────────────────────────────────────

  app.get(`${API}/contracts`, async () => ({
    contracts: contracts.listAll().map(serializeContract),
  }));

  app.get(`${API}/contracts/:contract`, async (request, reply) => {
    const { contract } = parse(z.object({ contract: z.string().min(1) }), request.params, "contract");
    const spec = contracts.find(contract);
    if (spec === null) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: `Kontrak tidak ditemukan: ${contract}`, details: {} },
      });
    }
    return serializeContract(spec);
  });

  // ── accounts ────────────────────────────────────────────────────

  app.post(`${API}/accounts`, async (request, reply) => {
    const body = parse(CreateAccountRequestSchema, request.body, "body");
    const outcome = accounts.create({
      commandId: body.commandId,
      name: body.name,
      mode: body.mode,
      baseCurrency: body.baseCurrency,
      initialBalance: body.initialBalance,
      nowMs: clock.nowMs(),
    });
    return reply.code(outcome.duplicate ? 200 : 201).send({
      account: serializeAccount(outcome.result),
      duplicate: outcome.duplicate,
    });
  });

  app.get(`${API}/accounts/:accountId`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const account = accounts.get(accountId);
    return reply.send({ account: serializeAccount(account) });
  });

  app.get(`${API}/accounts/:accountId/summary`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const summary = accounts.summary({ accountId, marks: markMapFor(accountId) });
    return reply.send({
      accountId: summary.accountId,
      name: summary.name,
      mode: summary.mode,
      baseCurrency: summary.baseCurrency,
      ...serializeValuation(summary.valuation),
      openPositionCount: summary.openPositionCount,
      openOrderCount: summary.openOrderCount,
      valuationStatus: summary.valuationStatus,
      unvaluedContracts: summary.unvaluedContracts,
      latestEventSeq: summary.latestEventSeq,
      asOf: summary.asOf,
    });
  });

  app.post(`${API}/accounts/:accountId/deposit`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const body = parse(DepositRequestSchema, request.body, "body");
    const outcome = accounts.deposit({
      accountId,
      commandId: body.commandId,
      amount: body.amount,
      note: body.note,
      nowMs: clock.nowMs(),
    });
    return reply.code(outcome.duplicate ? 200 : 201).send({
      account: serializeAccount(outcome.result),
      balances: serializeValuation(
        accounts.summary({ accountId, marks: new Map() }).valuation,
      ),
      duplicate: outcome.duplicate,
    });
  });

  app.post(`${API}/accounts/:accountId/withdraw`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const body = parse(WithdrawRequestSchema, request.body, "body");
    const outcome = accounts.withdraw({
      accountId,
      commandId: body.commandId,
      amount: body.amount,
      note: body.note,
      nowMs: clock.nowMs(),
    });
    return reply.code(outcome.duplicate ? 200 : 201).send({
      account: serializeAccount(outcome.result),
      balances: serializeValuation(accounts.summary({ accountId, marks: new Map() }).valuation),
      duplicate: outcome.duplicate,
    });
  });

  app.post(`${API}/accounts/:accountId/reset`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const body = parse(ResetRequestSchema, request.body, "body");
    const outcome = accounts.reset({
      accountId,
      commandId: body.commandId,
      balance: body.balance,
      note: body.note,
      nowMs: clock.nowMs(),
    });
    return reply.code(outcome.duplicate ? 200 : 201).send({
      account: serializeAccount(outcome.result),
      duplicate: outcome.duplicate,
    });
  });

  // ── orders ──────────────────────────────────────────────────────

  app.post(`${API}/accounts/:accountId/orders`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const body = parse(SubmitOrderRequestSchema, request.body, "body");
    const intent = toIntent(body.contract, body);
    const book = requireBook(accountId, body.contract);
    const result = orders.submitOrder({
      commandId: body.commandId,
      accountId,
      intent,
      book,
      nowMs: clock.nowMs(),
    });
    return reply.code(result.duplicate ? 200 : 201).send(serializeOrderResult(result));
  });

  app.get(`${API}/accounts/:accountId/orders`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(ListQuerySchema, request.query, "query");
    const all = orderRepo.listByAccount(accountId, { limit: 500 });
    const filtered = query.status === undefined ? all : all.filter((order) => order.status === query.status);
    const page = paginate(filtered, query.limit, (order) => order.id);
    return reply.send({
      orders: page.items.map(serializeOrder),
      nextCursor: page.nextCursor,
    });
  });

  app.get(`${API}/accounts/:accountId/orders/:orderId`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { orderId } = parse(z.object({ orderId: z.string().min(1) }), request.params, "params");
    const order = orderRepo.find(orderId);
    if (order === null || order.accountId !== accountId) {
      throw new NotFoundError(`Order tidak ditemukan: ${orderId}`);
    }
    return reply.send({
      order: serializeOrder(order),
      events: orderRepo.events(orderId).map((event) => ({
        seq: event.seq,
        type: event.type,
        detail: event.detail,
        timestamp: event.tsMs,
      })),
    });
  });

  app.post(`${API}/accounts/:accountId/orders/:orderId/cancel`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { orderId } = parse(z.object({ orderId: z.string().min(1) }), request.params, "params");
    const body = parse(CancelOrderRequestSchema, request.body, "body");
    const order = orderRepo.find(orderId);
    if (order === null || order.accountId !== accountId) {
      throw new NotFoundError(`Order tidak ditemukan: ${orderId}`);
    }
    const result = orders.cancelOrder({
      commandId: body.commandId,
      orderId,
      nowMs: clock.nowMs(),
      reason: body.reason,
    });
    return reply.send(serializeOrderResult(result));
  });

  app.post(`${API}/accounts/:accountId/orders/:orderId/evaluate`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { orderId } = parse(z.object({ orderId: z.string().min(1) }), request.params, "params");
    const body = parse(EvaluateOrderRequestSchema, request.body, "body");
    const order = orderRepo.find(orderId);
    if (order === null || order.accountId !== accountId) {
      throw new NotFoundError(`Order tidak ditemukan: ${orderId}`);
    }
    const book =
      body.bidPrice !== undefined && body.askPrice !== undefined
        ? { contract: order.contract, updateId: 0, eventTsMs: clock.nowMs(), bids: [{ price: body.bidPrice, size: 10_000 }], asks: [{ price: body.askPrice, size: 10_000 }] }
        : requireBook(accountId, order.contract);
    const result = orders.evaluateOrder({
      commandId: body.commandId,
      orderId,
      book,
      nowMs: clock.nowMs(),
    });
    return reply.send(serializeOrderResult(result));
  });

  // ── positions ───────────────────────────────────────────────────

  app.get(`${API}/accounts/:accountId/positions`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(ListQuerySchema, request.query, "query");
    const open = query.status === "closed" ? [] : positions.listOpen(accountId);
    const rows = query.status === "closed" ? positionRepo.listByAccount(accountId).filter((p) => p.status !== "open") : open;
    const page = paginate(rows, query.limit, (position) => position.id);
    return reply.send({
      positions: page.items.map((position) => serializePositionRow(position, accountId)),
      nextCursor: page.nextCursor,
    });
  });

  app.get(`${API}/accounts/:accountId/positions/:positionId`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { positionId } = parse(z.object({ positionId: z.string().min(1) }), request.params, "params");
    const position = positions.get(positionId);
    if (position.accountId !== accountId) {
      throw new NotFoundError(`Posisi tidak ditemukan: ${positionId}`);
    }
    return reply.send({
      position: serializePositionRow(position, accountId),
      events: positionRepo.events(positionId).map((event) => ({
        seq: event.seq,
        type: event.type,
        detail: event.detail,
        timestamp: event.tsMs,
      })),
    });
  });

  app.post(`${API}/accounts/:accountId/positions/:positionId/close`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { positionId } = parse(z.object({ positionId: z.string().min(1) }), request.params, "params");
    const body = parse(ClosePositionRequestSchema, request.body, "body");
    const position = positions.get(positionId);
    if (position.accountId !== accountId) {
      throw new NotFoundError(`Posisi tidak ditemukan: ${positionId}`);
    }
    if (position.status !== "open") {
      throw new ValidationError(`Posisi ${positionId} sudah ${position.status}`);
    }
    const execution = resolveExecution(accountId, position.contract, body.bidPrice, body.askPrice);
    const action = markToMarket.closePosition({
      commandId: body.commandId,
      positionId,
      execution,
      nowMs: clock.nowMs(),
      reason: body.reason ?? "manual",
    });
    return reply.send({
      position: serializePositionRow(positionRepo.require(positionId), accountId),
      settlement: {
        reason: action.reason,
        fillId: action.fillId,
        closedSize: String(action.closedSize),
        executionPrice: action.executionPrice.toFixed(),
        realizedPnl: action.realizedPnl.toFixed(8),
        pnlAppliedToWallet: action.pnlAppliedToWallet.toFixed(8),
        deficit: action.deficit.toFixed(8),
        insolvent: action.insolvent,
        fee: action.fee.toFixed(8),
        releasedMargin: action.releasedMargin.toFixed(8),
      },
    });
  });

  app.patch(`${API}/accounts/:accountId/positions/:positionId/protection`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const { positionId } = parse(z.object({ positionId: z.string().min(1) }), request.params, "params");
    const body = parse(AmendProtectionRequestSchema, request.body, "body");
    const position = positions.get(positionId);
    if (position.accountId !== accountId) {
      throw new NotFoundError(`Posisi tidak ditemukan: ${positionId}`);
    }
    const outcome = positions.amendProtection({
      commandId: body.commandId,
      positionId,
      takeProfitPrice: body.takeProfitPrice,
      stopLossPrice: body.stopLossPrice,
      nowMs: clock.nowMs(),
    });
    return reply.send({
      position: serializePositionRow(outcome.position, accountId),
      duplicate: outcome.duplicate,
    });
  });

  // ── fills / history / ledger ────────────────────────────────────

  app.get(`${API}/accounts/:accountId/fills`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(IdPaginationQuerySchema, request.query, "query");
    const rows = fillRepo.listByAccount(accountId, { limit: 500 });
    const after = query.after;
    const filtered = after === undefined ? rows : rows.filter((fill) => fill.id > after);
    const page = paginate(filtered, query.limit, (fill) => fill.id);
    return reply.send({ fills: page.items.map(serializeFill), nextCursor: page.nextCursor });
  });

  app.get(`${API}/accounts/:accountId/history`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(IdPaginationQuerySchema, request.query, "query");
    const rows = positionRepo.listByAccount(accountId, { limit: 500 });
    const after = query.after;
    const filtered = after === undefined ? rows : rows.filter((position) => position.id > after);
    const page = paginate(filtered, query.limit, (position) => position.id);
    return reply.send({
      positions: page.items.map((position) => ({
        id: position.id,
        contract: position.contract,
        side: position.direction,
        status: position.status,
        size: String(position.size),
        entryPrice: position.entryPrice.toFixed(),
        realizedPnl: encodeMoney(position.realizedPnl),
        accumulatedFunding: encodeMoney(position.accumulatedFunding),
        feesPaid: encodeMoney(position.feesPaid),
        openReason: "order",
        closeReason: position.closeReason,
        openedAt: position.openedAtMs,
        closedAt: position.closedAtMs,
      })),
      nextCursor: page.nextCursor,
    });
  });

  app.get(`${API}/accounts/:accountId/ledger`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(SeqPaginationQuerySchema, request.query, "query");
    const afterSeq = query.after ?? 0;
    const rows = ledgerRepo.list(accountId, { afterSeq, limit: query.limit });
    const hasMore = rows.length === query.limit;
    return reply.send({
      entries: rows.map(serializeLedgerEntry),
      nextCursor: hasMore && rows.length > 0 ? String(rows[rows.length - 1]!.seq) : null,
    });
  });

  app.get(`${API}/accounts/:accountId/events`, async (request, reply) => {
    const { accountId } = parse(AccountIdParam, request.params, "params");
    const query = parse(SeqPaginationQuerySchema, request.query, "query");
    const events = domainEvents.listAfter(accountId, query.after ?? 0, query.limit);
    const latest = domainEvents.latestSeq(accountId);
    return reply.send({
      events: events.map(serializeDomainEvent),
      latestEventSeq: latest,
      hasMore: events.length === query.limit,
    });
  });

  // ── simulation-only market input ────────────────────────────────

  if (simulationEnabled) {
    app.post(`${API}/simulation/market`, async (request, reply) => {
      const body = parse(SimulationMarketRequestSchema, request.body, "body");
      if (!(market instanceof Object) || typeof (market as { set?: unknown }).set !== "function") {
        return reply.code(503).send({
          error: {
            code: "NOT_AVAILABLE",
            message: "Market snapshot provider tidak menerima input simulasi",
            details: {},
          },
        });
      }
      const nowMs = clock.nowMs();
      const book: BookSnapshot = {
        contract: body.contract,
        updateId: nowMs,
        eventTsMs: nowMs,
        bids: [{ price: body.bidPrice, size: 10_000 }],
        asks: [{ price: body.askPrice, size: 10_000 }],
      };
      const snapshot = (market as unknown as {
        set(input: { mark: unknown; book: BookSnapshot }): { mark: ReturnType<typeof parseMarkSnapshot> };
      }).set({
        mark: parseMarkSnapshot({
          contract: body.contract,
          markPrice: body.markPrice,
          observedAtMs: nowMs,
          sourceTimestampMs: body.sourceTimestampMs ?? nowMs,
          funding:
            body.fundingRate === undefined || body.fundingTimestampMs === undefined
              ? null
              : {
                  fundingRate: body.fundingRate,
                  fundingTimestampMs: body.fundingTimestampMs,
                  intervalSeconds: body.fundingIntervalSeconds ?? 28800,
                },
        }),
        book,
      });
      return reply.code(201).send({
        market: serializeMark(snapshot.mark),
        book: { bidPrice: body.bidPrice, askPrice: body.askPrice },
      });
    });

    /**
     * Memproses mark yang SUDAH ada di provider (bukan mark dari klien).
     * Klien memicu pemrosesan, tetapi nilai pasar tetap milik server.
     */
    app.post(`${API}/accounts/:accountId/process-mark/:contract`, async (request, reply) => {
      const { accountId } = parse(AccountIdParam, request.params, "params");
      const { contract } = parse(z.object({ contract: z.string().min(1) }), request.params, "params");
      const body = parse(z.object({ commandId: z.string().trim().min(1) }).strict(), request.body, "body");
      const snapshot = market.getMark(contract);
      if (snapshot === null) {
        throw new NotFoundError(`Belum ada mark untuk ${contract}`);
      }
      const execution = resolveExecution(accountId, contract, undefined, undefined);
      const result = markToMarket.processMark({
        commandId: body.commandId,
        accountId,
        mark: snapshot,
        execution,
        nowMs: clock.nowMs(),
      });
      return reply.send({
        contract: result.contract,
        stale: result.stale,
        markPrice: result.markPrice === null ? null : result.markPrice.toFixed(),
        actions: result.actions.map((action) => ({
          positionId: action.positionId,
          reason: action.reason,
          executionPrice: action.executionPrice.toFixed(),
          realizedPnl: action.realizedPnl.toFixed(8),
          deficit: action.deficit.toFixed(8),
          insolvent: action.insolvent,
        })),
        funding: result.funding.map((entry) => ({
          positionId: entry.positionId,
          fundingTimestamp: entry.fundingTimestampMs,
          rate: entry.rate.toFixed(),
          amount: entry.amount.toFixed(8),
          applied: entry.applied,
        })),
        duplicate: result.duplicate,
      });
    });
  }

  // ── openapi (kontrak tunggal, ditulis manual, bukan codegen) ─────

  app.get(`${API}/openapi.json`, async () => openApiDocument());

  // ── helpers ─────────────────────────────────────────────────────

  function serializeOrderResult(result: ReturnType<OrderService["submitOrder"]>) {
    return {
      order: serializeOrder(result.order),
      fills: result.fills.map((fill) => ({
        id: fill.fillId,
        size: String(fill.size),
        price: fill.price.toFixed(),
        liquidity: fill.liquidity,
        fee: fill.fee.toFixed(8),
        realizedPnl: fill.realizedPnl.toFixed(8),
      })),
      duplicate: result.duplicate,
    };
  }

  function serializePositionRow(
    position: ReturnType<PositionRepository["require"]>,
    accountId: string,
  ) {
    void accountId;
    // Posisi tertutup tidak punya eksposur: tidak ada yang bisa divaluasi, dan
    // memanggil valuasi dengan size 0 memang ditolak core. Laporkan apa adanya.
    if (position.status !== "open" || position.size <= 0) {
      return serializePosition(position, null, "unvalued");
    }
    const snapshot = market.getMark(position.contract);
    if (snapshot === null) {
      return serializePosition(position, null, "unvalued");
    }
    const freshness = markFreshness(snapshot, { maxStalenessMs: 5_000 });
    const valuation = markToMarket.valuatePositionForApi({
      position,
      markPrice: snapshot.markPrice,
    });
    return serializePosition(position, valuation, freshness.stale ? "stale" : "fresh");
  }

  /**
   * Detail pasar per kontrak. Memakai runtime pasar bila ada; jika tidak,
   * hanya bidang yang bisa diturunkan dari provider yang diisi, sisanya null.
   */
  function marketDetailFor(contract: string): MarketDetailView {
    const detailed = options.marketDetail?.(contract);
    if (detailed !== undefined && detailed !== null) {
      return detailed;
    }
    const mark = market.getMark(contract);
    const book = market.getBook(contract);
    const topBid = book?.bids[0] ?? null;
    const topAsk = book?.asks[0] ?? null;
    return {
      contract,
      markPrice: mark === null ? null : mark.markPrice,
      markSourceTimestampMs: mark === null ? null : mark.sourceTimestampMs,
      // Tanpa runtime kita tidak dapat menilai staleness terhadap jam exchange
      // selain dari selisih waktu sumber; ini tetap jujur (bukan "fresh" palsu).
      markStatus:
        mark === null
          ? "missing"
          : clock.nowMs() - mark.sourceTimestampMs > 5000
            ? "stale"
            : "fresh",
      lastPrice: null,
      indexPrice: null,
      fundingRate: mark?.funding?.fundingRate ?? null,
      fundingNextApplyMs: mark?.funding?.fundingTimestampMs ?? null,
      bestBid: topBid === null ? null : topBid.price,
      bestBidSize: topBid === null ? null : topBid.size,
      bestAsk: topAsk === null ? null : topAsk.price,
      bestAskSize: topAsk === null ? null : topAsk.size,
      depthStatus: null,
    };
  }

  function markMapFor(accountId: string) {
    const map = new Map<string, { markPrice: Decimal; stale: boolean }>();
    for (const position of positionRepo.listOpen(accountId)) {
      const snapshot = market.getMark(position.contract);
      if (snapshot === null) {
        continue;
      }
      map.set(position.contract, {
        markPrice: new Decimal(snapshot.markPrice),
        stale: markFreshness(snapshot, { maxStalenessMs: 5_000 }).stale,
      });
    }
    return map;
  }

  function requireBook(accountId: string, contract: string): BookSnapshot {
    void accountId;
    const book = market.getBook(contract);
    if (book === null) {
      throw new NotFoundError(
        `Belum ada buku pasar untuk ${contract}. Kirim simulasi pasar lebih dulu.`,
      );
    }
    return book;
  }

  function resolveExecution(
    accountId: string,
    contract: string,
    bidPrice: string | undefined,
    askPrice: string | undefined,
  ): ExecutionQuote {
    void accountId;
    if (bidPrice !== undefined && askPrice !== undefined) {
      return { contract, bidPrice, askPrice };
    }
    const quote = executionQuoteFrom(market.getBook(contract));
    if (quote === null) {
      throw new NotFoundError(`Belum ada kutipan eksekusi untuk ${contract}`);
    }
    return quote;
  }

  return {
    app,
    services: { accounts, orders, positions, market: markToMarket },
    market,
    mode,
    simulationEnabled,
  };
}

function toIntent(contract: string, body: z.infer<typeof SubmitOrderRequestSchema>): OrderIntent {
  return OrderIntentSchema.parse({
    contract,
    side: body.side,
    type: body.type,
    size: body.size,
    price: body.limitPrice ?? null,
    leverage: body.leverage,
    timeInForce: body.timeInForce ?? (body.type === "market" ? "ioc" : "gtc"),
    reduceOnly: body.reduceOnly ?? false,
    tpPrice: body.takeProfitPrice ?? null,
    slPrice: body.stopLossPrice ?? null,
  });
}

/** Dokumen OpenAPI ringkas: satu kontrak kanonik tanpa codegen. */
function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "crypastra paper exchange API",
      version: "1.0.0",
      description:
        "Paper trading API. SEMUA nilai finansial dikirim sebagai STRING desimal. Timestamp: epoch milidetik.",
    },
    servers: [{ url: "/api/v1" }],
    paths: {
      "/accounts": { post: { summary: "Buat akun paper (idempoten via commandId)" } },
      "/accounts/{accountId}": { get: { summary: "Baca akun" } },
      "/accounts/{accountId}/summary": {
        get: { summary: "Ringkasan akun siap-UI (termasuk latestEventSeq)" },
      },
      "/accounts/{accountId}/deposit": { post: { summary: "Deposit dana virtual" } },
      "/accounts/{accountId}/withdraw": { post: { summary: "Tarik dana virtual" } },
      "/accounts/{accountId}/reset": { post: { summary: "Reset saldo (ledger tetap utuh)" } },
      "/accounts/{accountId}/orders": {
        get: { summary: "Daftar order" },
        post: { summary: "Kirim order paper" },
      },
      "/accounts/{accountId}/orders/{orderId}": { get: { summary: "Detail order + event" } },
      "/accounts/{accountId}/orders/{orderId}/cancel": { post: { summary: "Batalkan order" } },
      "/accounts/{accountId}/orders/{orderId}/evaluate": { post: { summary: "Evaluasi order resting" } },
      "/accounts/{accountId}/positions": { get: { summary: "Daftar posisi (dengan valuasi mark)" } },
      "/accounts/{accountId}/positions/{positionId}": { get: { summary: "Detail posisi" } },
      "/accounts/{accountId}/positions/{positionId}/close": { post: { summary: "Tutup posisi (manual)" } },
      "/accounts/{accountId}/positions/{positionId}/protection": {
        patch: { summary: "Ubah TP/SL posisi terbuka" },
      },
      "/accounts/{accountId}/fills": { get: { summary: "Riwayat fill (paginasi kursor)" } },
      "/accounts/{accountId}/history": { get: { summary: "Riwayat posisi (paginasi kursor)" } },
      "/accounts/{accountId}/ledger": { get: { summary: "Ledger append-only (paginasi seq)" } },
      "/accounts/{accountId}/events": { get: { summary: "Event domain (outbox) untuk resume" } },
      "/contracts": { get: { summary: "Daftar kontrak (representasi internal)" } },
      "/contracts/{contract}": { get: { summary: "Detail kontrak" } },
      "/simulation/market": { post: { summary: "SIMULASI: suntik mark/bid/ask/funding" } },
      "/accounts/{accountId}/process-mark/{contract}": {
        post: { summary: "SIMULASI: proses mark yang tersedia di server" },
      },
      "/health/integrity": { get: { summary: "Integritas akuntansi (503 bila gagal)" } },
      "/market/health": { get: { summary: "Kesehatan feed pasar (mode, staleness, buku)" } },
      "/market/state": { get: { summary: "Detail pasar per kontrak (mark/last/index/funding/bid/ask)" } },
      "/market/candles": { get: { summary: "Riwayat candle tersimpan untuk chart" } },
    },
    components: {
      schemas: {
        Money: { type: "string", description: "Desimal kanonik 8 dp", example: "1000.00000000" },
        Price: { type: "string", description: "Desimal eksak", example: "80445.79" },
        Count: { type: "string", description: "Cacah kontrak bulat", example: "1" },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: { type: "object" },
              },
            },
          },
        },
      },
    },
  };
}

export type { FeeResult };
