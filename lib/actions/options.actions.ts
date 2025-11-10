'use server';

import { fetchJSON } from '@/lib/actions/finnhub.actions';
import { priceMultipleModels } from '@/lib/finance/optionPricing';
import type {
  OptionPricingRequestPayload,
  OptionPricingResponsePayload,
  OptionContractSummary,
  OptionPricingModel,
  OptionPricingResult,
  OptionType,
  PricingGreekSet,
} from '@/types/options';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const TOKEN = process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_API_KEY ?? '';

const ensureToken = () => {
  if (!TOKEN) {
    throw new Error('FINNHUB API key is not configured');
  }
  return TOKEN;
};

const PDE_MODEL_LABEL = 'PDE (Crank-Nicolson)';

type PdeServiceGreeks = Partial<Record<'delta' | 'gamma' | 'theta' | 'vega' | 'rho', number | null>>;

type PdeServiceDiagnostics = {
  grid_points: number;
  time_steps: number;
  residual_norm: number;
  runtime_ms?: number | null;
  boundary_spread: number;
  s_max: number;
};

type PdeServiceResponse = {
  symbol: string;
  option_type: OptionType;
  fair_value: number;
  price: number;
  quantity: number;
  greeks?: PdeServiceGreeks | null;
  diagnostics: PdeServiceDiagnostics;
  warnings?: string[];
};

type FinnhubQuoteResponse = {
  c?: number;
  pc?: number;
};

type FinnhubProfileResponse = {
  shareOutstanding?: number;
  dividendYield?: number;
};

type FinnhubEconomicResponse = {
  data?: Array<{ value: number; date: string }>;
};

type FinnhubOptionContract = {
  type?: string;
  optionType?: string;
  side?: string;
  class?: string;
  strike?: number;
  strikePrice?: number;
  lastPrice?: number;
  bid?: number;
  ask?: number;
  impliedVolatility?: number;
  volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
};

type FinnhubOptionExpirationSlice = {
  expirationDate?: string;
  expiration?: string;
  options?: FinnhubOptionContract[];
  calls?: FinnhubOptionContract[];
  puts?: FinnhubOptionContract[];
};

type FinnhubOptionChainResponse = {
  data?: FinnhubOptionExpirationSlice[];
  optionChain?: FinnhubOptionExpirationSlice[];
  lastTradeDate?: string;
};

const normalizeOptionContract = (
  raw: FinnhubOptionContract,
  optionType: OptionType,
  symbol: string,
  expiration: string
): OptionContractSummary => {
  const strike =
    raw.strike ??
    raw.strikePrice ??
    (() => {
      throw new Error('Option contract is missing strike price');
    })();

  const impliedVol =
    raw.impliedVolatility !== undefined
      ? normalizeVol(raw.impliedVolatility)
      : raw.volatility !== undefined
        ? normalizeVol(raw.volatility)
        : undefined;

  return {
    symbol,
    expirationDate: expiration,
    strikePrice: strike,
    optionType,
    impliedVolatility: impliedVol,
    lastPrice: raw.lastPrice,
    bid: raw.bid,
    ask: raw.ask,
    delta: raw.delta,
    gamma: raw.gamma,
    theta: raw.theta,
    vega: raw.vega,
    rho: raw.rho,
  };
};

const normalizeVol = (input: number) => {
  if (!Number.isFinite(input)) return undefined;
  return input > 1 ? input / 100 : input;
};

const findOptionContract = (
  chain: FinnhubOptionChainResponse,
  optionType: OptionType,
  strike: number,
  expiration: string,
  symbol: string
): OptionContractSummary | undefined => {
  const slices = chain.data ?? chain.optionChain ?? [];
  const targetSlice = slices.find((slice) => {
    const exp = slice.expirationDate ?? slice.expiration;
    return exp ? exp.substring(0, 10) === expiration.substring(0, 10) : false;
  });
  if (!targetSlice) return undefined;

  const contracts =
    optionType === 'call'
      ? targetSlice.calls ?? targetSlice.options?.filter((c) => (c.type ?? c.optionType) === 'CALL')
      : targetSlice.puts ?? targetSlice.options?.filter((c) => (c.type ?? c.optionType) === 'PUT');

  if (!contracts?.length) return undefined;

  const match = contracts.reduce<FinnhubOptionContract | undefined>((best, current) => {
    const strikeValue = current.strike ?? current.strikePrice;
    if (typeof strikeValue !== 'number' || !Number.isFinite(strikeValue)) return best;
    if (!best) return current;
    const bestStrike = best.strike ?? best.strikePrice ?? 0;
    return Math.abs(strikeValue - strike) < Math.abs(bestStrike - strike) ? current : best;
  }, undefined);

  if (!match) return undefined;

  return normalizeOptionContract(match, optionType, symbol, expiration);
};

const getFinnhubQuote = async (symbol: string) => {
  const token = ensureToken();
  const url = `${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`;
  const data = await fetchJSON<FinnhubQuoteResponse>(url, 30);
  const price = data?.c ?? data?.pc;
  if (!price || !Number.isFinite(price)) {
    throw new Error('Unable to fetch current price for symbol');
  }
  return price;
};

const getDividendYield = async (symbol: string) => {
  const token = ensureToken();
  const url = `${FINNHUB_BASE_URL}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${token}`;
  const profile = await fetchJSON<FinnhubProfileResponse>(url, 3600);
  if (Number.isFinite(profile?.dividendYield ?? NaN)) {
    const yieldValue = profile!.dividendYield!;
    return yieldValue > 1 ? yieldValue / 100 : yieldValue;
  }
  return 0;
};

const getRiskFreeRate = async () => {
  const token = ensureToken();
  const url = `${FINNHUB_BASE_URL}/economic?symbol=FRED/DGS3MO&token=${token}`;
  try {
    const data = await fetchJSON<FinnhubEconomicResponse>(url, 10800);
    const values = data?.data ?? [];
    const latest = values.at(-1) ?? values.at(0);
    if (latest && Number.isFinite(latest.value)) {
      return latest.value > 1 ? latest.value / 100 : latest.value;
    }
  } catch (error) {
    console.warn('Unable to fetch risk-free rate, falling back to default 5%:', error);
  }
  return 0.05;
};

const getOptionChainSlice = async (symbol: string, expiration: string) => {
  const token = ensureToken();
  const url = `${FINNHUB_BASE_URL}/stock/option-chain?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&token=${token}`;
  return fetchJSON<FinnhubOptionChainResponse>(url, 600);
};

const computeTimeToExpiration = (expiration: string) => {
  const expiry = new Date(expiration);
  if (Number.isNaN(expiry.getTime())) {
    throw new Error('Invalid expiration date');
  }
  const now = new Date();
  const diff = expiry.getTime() - now.getTime();
  const yearMs = 365.25 * 24 * 60 * 60 * 1000;
  return Math.max(diff / yearMs, 1 / 365);
};

const getPdeEndpoint = () => {
  const base = process.env.PDE_SERVICE_URL ?? 'http://localhost:8001';
  return `${base.replace(/\/$/, '')}/pde/price`;
};

const callPdeService = async (input: {
  symbol: string;
  optionType: OptionType;
  spot: number;
  strike: number;
  expiry: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield: number;
  quantity: number;
}): Promise<PdeServiceResponse> => {
  const endpoint = getPdeEndpoint();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      symbol: input.symbol,
      option_type: input.optionType,
      spot: input.spot,
      strike: input.strike,
      expiry: input.expiry,
      volatility: input.volatility,
      risk_free_rate: input.riskFreeRate,
      dividend_yield: input.dividendYield,
      quantity: input.quantity,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail ? `PDE service error (${response.status}): ${detail}` : `PDE service error (${response.status})`,
    );
  }

  return (await response.json()) as PdeServiceResponse;
};

const toPricingGreekSet = (greeks?: PdeServiceGreeks | null): PricingGreekSet | undefined => {
  if (!greeks) return undefined;
  const hasValue = Object.values(greeks).some((value) => typeof value === 'number' && Number.isFinite(value));
  if (!hasValue) return undefined;
  return {
    delta: Number.isFinite(greeks.delta ?? NaN) ? (greeks.delta as number) : 0,
    gamma: Number.isFinite(greeks.gamma ?? NaN) ? (greeks.gamma as number) : 0,
    theta: Number.isFinite(greeks.theta ?? NaN) ? (greeks.theta as number) : 0,
    vega: Number.isFinite(greeks.vega ?? NaN) ? (greeks.vega as number) : 0,
    rho: Number.isFinite(greeks.rho ?? NaN) ? (greeks.rho as number) : 0,
  };
};

const mapPdeResponseToResult = (
  response: PdeServiceResponse,
  optionType: OptionType,
  strike: number,
  quantity: number,
): OptionPricingResult => {
  const fairValue = Number.isFinite(response.fair_value) ? response.fair_value : 0;
  const price = Number.isFinite(response.price) ? response.price : fairValue * quantity;
  const diagnostics = response.diagnostics;
  const warnings = response.warnings?.filter(Boolean) ?? [];

  const parameters: Record<string, number | string> = {
    gridPoints: diagnostics.grid_points,
    timeSteps: diagnostics.time_steps,
    residualNorm: diagnostics.residual_norm,
    boundarySpread: diagnostics.boundary_spread,
    sMax: diagnostics.s_max,
  };

  const computationTime = Number.isFinite(diagnostics.runtime_ms ?? NaN)
    ? (diagnostics.runtime_ms as number)
    : 0;

  const breakeven =
    optionType === 'call'
      ? strike + fairValue
      : strike - fairValue;

  return {
    model: 'pde',
    price,
    fairValue,
    breakevenPrice: breakeven,
    greeks: toPricingGreekSet(response.greeks),
    metadata: {
      label: PDE_MODEL_LABEL,
      computationTimeMs: computationTime,
      parameters,
      warnings: warnings.length ? warnings : undefined,
    },
  };
};

const createPdeFailureResult = (
  message: string,
  optionType: OptionType,
  strike: number,
  quantity: number,
): OptionPricingResult => {
  const fairValue = 0;
  const breakeven = optionType === 'call' ? strike + fairValue : strike - fairValue;
  return {
    model: 'pde',
    price: fairValue * quantity,
    fairValue,
    breakevenPrice: breakeven,
    metadata: {
      label: PDE_MODEL_LABEL,
      computationTimeMs: 0,
      warnings: [`PDE model unavailable: ${message}`],
    },
  };
};

export async function priceOptionContracts(
  payload: OptionPricingRequestPayload
): Promise<OptionPricingResponsePayload> {
  const {
    symbol,
    optionType,
    strike,
    expiration,
    quantity = 1,
    models,
    binomialSteps,
    monteCarloPaths,
    monteCarloSeed,
    volatilityOverride,
    riskFreeRateOverride,
    dividendYieldOverride,
  } = payload;

  if (!symbol?.trim()) throw new Error('Symbol is required');
  if (!models?.length) throw new Error('At least one pricing model must be selected');

  const normalizedSymbol = symbol.trim().toUpperCase();
  const timeToExpiration = computeTimeToExpiration(expiration);

  const [spotPrice, riskFreeRate, chain, dividendYield] = await Promise.all([
    getFinnhubQuote(normalizedSymbol),
    riskFreeRateOverride ?? getRiskFreeRate(),
    getOptionChainSlice(normalizedSymbol, expiration),
    dividendYieldOverride ?? getDividendYield(normalizedSymbol),
  ]);

  const contract =
    findOptionContract(chain, optionType, strike, expiration, normalizedSymbol) ?? undefined;

  const impliedVolatility =
    volatilityOverride ??
    contract?.impliedVolatility ??
    // fall back to historical assumption if needed
    0.3;

  const includePde = models.includes('pde');
  const coreModels = models.filter(
    (model): model is Exclude<OptionPricingModel, 'pde'> => model !== 'pde',
  );

  const results: OptionPricingResult[] = coreModels.length
    ? priceMultipleModels(
        coreModels,
        optionType,
        {
          spotPrice,
          strikePrice: strike,
          timeToExpiration,
          riskFreeRate,
          volatility: impliedVolatility,
          dividendYield,
          quantity,
        },
        {
          binomial: binomialSteps ? { steps: binomialSteps } : undefined,
          monteCarlo: monteCarloPaths
            ? { paths: monteCarloPaths, seed: monteCarloSeed }
            : monteCarloSeed
              ? { seed: monteCarloSeed }
              : undefined,
        },
      )
    : [];

  if (includePde) {
    try {
      const pdeResponse = await callPdeService({
        symbol: normalizedSymbol,
        optionType,
        spot: spotPrice,
        strike,
        expiry: timeToExpiration,
        volatility: impliedVolatility,
        riskFreeRate,
        dividendYield,
        quantity,
      });
      results.push(mapPdeResponseToResult(pdeResponse, optionType, strike, quantity));
    } catch (error) {
      console.error('PDE pricing error:', error);
      const message =
        error instanceof Error ? error.message : 'Unable to evaluate PDE model';
      results.push(createPdeFailureResult(message, optionType, strike, quantity));
    }
  }

  return {
    symbol: normalizedSymbol,
    optionType,
    strike,
    expiration,
    underlyingPrice: spotPrice,
    impliedVolatility,
    riskFreeRate,
    dividendYield,
    timeToExpiration,
    quantity,
    contract,
    results,
  };
}


