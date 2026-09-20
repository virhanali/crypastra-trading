import {
  DEFAULT_RISK_POLICY,
  buildDecisionDigest,
  decide,
  deriveAccount,
  unrealizedPnlFor,
  type AccountRiskState,
  type ContractSpec,
  type Decision,
  type DecisionInput,
  type RiskPolicy,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { AccountRepository } from "../repositories/account-repository.js";
import { LedgerRepository } from "../repositories/ledger-repository.js";
import { PositionRepository } from "../repositories/position-repository.js";
import { DecisionRepository } from "../repositories/decision-repository.js";

export interface DecisionCounters {
  decisionsEvaluated: number;
  approved: number;
  skipped: number;
  longApproved: number;
  shortApproved: number;
  sizeCapped: number;
  marginRejected: number;
  positionLimitRejected: number;
  persisted: number;
  errors: number;
  skipByReason: Record<string, number>;
}

export interface DecisionDiagnostic {
  readonly type: "decision.trade" | "decision.skip" | "decision.error";
  readonly contract: string;
  readonly detail: string;
}

export interface DecisionServiceOptions {
  readonly connection: DatabaseConnection;
  /** Waktu untuk metadata persistensi; TIDAK masuk hash keputusan. */
  readonly clock: { nowMs(): number };
  readonly policy?: RiskPolicy;
  readonly persist?: boolean;
  readonly onDiagnostic?: (event: DecisionDiagnostic) => void;
}

/**
 * DecisionService — pembungkus tipis dan OBSERVASIONAL atas engine murni.
 *
 * Tugasnya hanya: panggil `decide()`, catat counter, persist Keputusan
 * (termasuk SKIP). TIDAK memanggil OrderService dan tidak menyentuh
 * orders/fills/positions/ledger (§23, §30). Tidak pernah melempar keluar:
 * kegagalan keputusan tidak boleh menghentikan ingest pasar atau trading manual.
 */
export class DecisionService {
  readonly #pol: RiskPolicy | undefined;
  readonly #persist: boolean;
  readonly #onDiagnostic: ((event: DecisionDiagnostic) => void) | undefined;
  readonly #repository: DecisionRepository;
  readonly #clock: { nowMs(): number };
  readonly #decisions: Decision[] = [];
  #counters: DecisionCounters = blankCounters();

  constructor(options: DecisionServiceOptions) {
    this.#pol = options.policy;
    this.#persist = options.persist ?? true;
    this.#onDiagnostic = options.onDiagnostic;
    this.#repository = new DecisionRepository(options.connection);
    this.#clock = options.clock;
  }

  /** Evaluasi satu kandidat. Tidak pernah melempar. */
  evaluate(input: Omit<DecisionInput, "policy">): Decision | null {
    try {
      const policy = this.#pol ?? DEFAULT_RISK_POLICY;
      const decision = decide({ ...input, policy });
      this.#record(decision);
      if (this.#persist) {
        const inserted = this.#repository.insertIfAbsent({
          decision,
          riskJson: JSON.stringify(input.account),
          createdAtMs: this.#clock.nowMs(),
        });
        if (inserted) {
          this.#counters.persisted += 1;
        }
      }
      return decision;
    } catch (error) {
      this.#counters.errors += 1;
      this.#onDiagnostic?.({ type: "decision.error", contract: input.contract, detail: String(error) });
      return null;
    }
  }

  #record(decision: Decision): void {
    this.#decisions.push(decision);
    this.#counters.decisionsEvaluated += 1;
    if (decision.action === "trade") {
      this.#counters.approved += 1;
      if (decision.direction === "long") this.#counters.longApproved += 1;
      if (decision.direction === "short") this.#counters.shortApproved += 1;
    } else {
      this.#counters.skipped += 1;
    }
    for (const code of decision.reasons) {
      this.#counters.skipByReason[code] = (this.#counters.skipByReason[code] ?? 0) + 1;
    }
    if (decision.reasons.includes("SIZE_CAPPED_NOTIONAL") || decision.reasons.includes("SIZE_CAPPED_CONTRACT_MAX")) {
      this.#counters.sizeCapped += 1;
    }
    if (
      decision.reasons.includes("INSUFFICIENT_AVAILABLE_BALANCE") ||
      decision.reasons.includes("TOTAL_MARGIN_LIMIT")
    ) {
      this.#counters.marginRejected += 1;
    }
    if (
      decision.reasons.includes("MAX_OPEN_POSITIONS") ||
      decision.reasons.includes("CONTRACT_POSITION_LIMIT") ||
      decision.reasons.includes("EXISTING_CONTRACT_POSITION")
    ) {
      this.#counters.positionLimitRejected += 1;
    }
    this.#onDiagnostic?.({
      type: decision.action === "trade" ? "decision.trade" : "decision.skip",
      contract: decision.contract,
      detail: decision.action === "trade"
        ? `${decision.direction} size=${decision.tradePlan?.size} [${decision.reasons.join(",")}]`
        : `[${decision.reasons.join(",")}]`,
    });
  }

  counters(): DecisionCounters {
    return { ...this.#counters, skipByReason: { ...this.#counters.skipByReason } };
  }

  decisions(): readonly Decision[] {
    return [...this.#decisions];
  }

  /** Sidik jari deterministik deret keputusan (dipakai uji replay). */
  digest(): ReturnType<typeof buildDecisionDigest> {
    return buildDecisionDigest(this.#decisions);
  }

  persistedCount(): number {
    return this.#repository.count();
  }

  resetCounters(): void {
    this.#counters = blankCounters();
  }
}

function blankCounters(): DecisionCounters {
  return {
    decisionsEvaluated: 0,
    approved: 0,
    skipped: 0,
    longApproved: 0,
    shortApproved: 0,
    sizeCapped: 0,
    marginRejected: 0,
    positionLimitRejected: 0,
    persisted: 0,
    errors: 0,
    skipByReason: {},
  };
}

/**
 * Bangun proyeksi risiko akun dari DB + mark.
 *
 * Ini SATU-SATUNYA tempat baris DB berubah menjadi `AccountRiskState`; engine
 * murni tidak pernah melihat repository.
 */
export function buildAccountRiskState(input: {
  connection: DatabaseConnection;
  accountId: string;
  contracts: { require(contract: string): ContractSpec };
  marks: ReadonlyMap<string, { markPrice: string; stale: boolean }>;
}): AccountRiskState {
  const account = new AccountRepository(input.connection).require(input.accountId);
  const balances = new LedgerRepository(input.connection).balances(input.accountId);
  const positions = new PositionRepository(input.connection).listOpen(input.accountId);

  let unrealized = deriveAccount(
    { walletBalance: balances.walletBalance, usedMargin: balances.usedMargin, reservedMargin: balances.reservedMargin },
    0,
  ).unrealizedPnl;

  const openPositions = positions.map((position) => {
    const observed = input.marks.get(position.contract);
    if (observed === undefined) {
      return {
        contract: position.contract,
        side: position.direction,
        size: position.size,
        entryPrice: String(position.entryPrice),
        initialMargin: String(position.initialMargin),
        unrealizedPnl: "0",
      };
    }
    const spec = input.contracts.require(position.contract);
    const pnl = unrealizedPnlFor(spec, position.direction, position.size, position.entryPrice, observed.markPrice);
    unrealized = unrealized.plus(pnl);
    return {
      contract: position.contract,
      side: position.direction,
      size: position.size,
      entryPrice: String(position.entryPrice),
      initialMargin: String(position.initialMargin),
      unrealizedPnl: pnl.toString(),
    };
  });

  const valuation = deriveAccount(
    { walletBalance: balances.walletBalance, usedMargin: balances.usedMargin, reservedMargin: balances.reservedMargin },
    unrealized,
  );

  return {
    accountId: account.id,
    walletBalance: valuation.walletBalance.toString(),
    equity: valuation.equity.toString(),
    availableBalance: valuation.availableBalance.toString(),
    positionMargin: balances.usedMargin.toString(),
    reservedMargin: balances.reservedMargin.toString(),
    openPositionCount: openPositions.length,
    openPositions,
  };
}
