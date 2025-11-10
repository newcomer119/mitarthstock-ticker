export type OptionType = 'call' | 'put';

export type OptionPricingModel = 'blackScholes' | 'binomial' | 'monteCarlo' | 'pde';

export type OptionPricingModelConfig = {
  models: OptionPricingModel[];
  binomialSteps?: number;
  monteCarloPaths?: number;
  monteCarloSeed?: number;
};

export type OptionPricingRequestPayload = {
  symbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string; // ISO date string
  quantity?: number;
  volatilityOverride?: number;
  riskFreeRateOverride?: number;
  dividendYieldOverride?: number;
} & OptionPricingModelConfig;

export type PricingGreekSet = {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
};

export type PricingMetadata = {
  label: string;
  computationTimeMs: number;
  warnings?: string[];
  parameters?: Record<string, number | string>;
};

export type OptionPricingResult = {
  model: OptionPricingModel;
  price: number;
  fairValue: number;
  breakevenPrice: number;
  greeks?: PricingGreekSet;
  payoffSeries?: Array<{ underlying: number; payoff: number }>;
  monteCarloDistribution?: {
    mean: number;
    standardDeviation: number;
    percentiles: Record<'p05' | 'p25' | 'p50' | 'p75' | 'p95', number>;
  };
  metadata: PricingMetadata;
};

export type OptionPricingResponsePayload = {
  symbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  underlyingPrice: number;
  impliedVolatility?: number;
  riskFreeRate: number;
  dividendYield: number;
  timeToExpiration: number;
  quantity: number;
  contract?: OptionContractSummary;
  results: OptionPricingResult[];
};

export type OptionContractSummary = {
  symbol: string;
  expirationDate: string;
  strikePrice: number;
  optionType: OptionType;
  impliedVolatility?: number;
  lastPrice?: number;
  bid?: number;
  ask?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
};

