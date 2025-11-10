import { normCdf, normPdf } from './math';
import type {
  OptionPricingModel,
  OptionPricingResult,
  PricingGreekSet,
  OptionType,
} from '@/types/options';

export type PricingContext = {
  spotPrice: number;
  strikePrice: number;
  timeToExpiration: number; // in years
  riskFreeRate: number; // annualized, as decimal (e.g., 0.05)
  volatility: number; // annualized, as decimal (e.g., 0.2)
  dividendYield?: number; // continuous dividend yield, decimal
  quantity?: number;
};

export type BinomialConfig = {
  steps?: number;
};

export type MonteCarloConfig = {
  paths?: number;
  seed?: number;
};

const clampVolatility = (vol: number) => {
  if (!Number.isFinite(vol) || vol <= 0) return 0.0001;
  return Math.min(Math.max(vol, 0.0001), 5);
};

const clampTime = (t: number) => {
  if (!Number.isFinite(t) || t <= 0) return 1 / 365; // minimum 1 day
  return Math.min(t, 10); // cap at 10 years to avoid overflows
};

export const priceOption = (
  model: OptionPricingModel,
  optionType: OptionType,
  context: PricingContext,
  config?: BinomialConfig | MonteCarloConfig
): OptionPricingResult => {
  switch (model) {
    case 'blackScholes':
      return priceBlackScholes(optionType, context);
    case 'binomial':
      return priceBinomial(optionType, context, config as BinomialConfig);
    case 'monteCarlo':
      return priceMonteCarlo(optionType, context, config as MonteCarloConfig);
    default:
      throw new Error(`Unsupported pricing model: ${model satisfies never}`);
  }
};

const adjustForQuantity = (value: number, quantity: number) =>
  Number.isFinite(quantity) ? value * quantity : value;

const buildGreeksMetadata = (greeks: PricingGreekSet | undefined) =>
  greeks
    ? {
        delta: Number.isFinite(greeks.delta) ? greeks.delta : 0,
        gamma: Number.isFinite(greeks.gamma) ? greeks.gamma : 0,
        theta: Number.isFinite(greeks.theta) ? greeks.theta : 0,
        vega: Number.isFinite(greeks.vega) ? greeks.vega : 0,
        rho: Number.isFinite(greeks.rho) ? greeks.rho : 0,
      }
    : undefined;

const priceBlackScholes = (
  optionType: OptionType,
  context: PricingContext
): OptionPricingResult => {
  const start = performance.now();
  const {
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    volatility,
    dividendYield = 0,
    quantity = 1,
  } = context;

  const t = clampTime(timeToExpiration);
  const sigma = clampVolatility(volatility);
  const d1 =
    (Math.log(spotPrice / strikePrice) + (riskFreeRate - dividendYield + 0.5 * sigma * sigma) * t) /
    (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);

  const Nd1 = normCdf(optionType === 'call' ? d1 : -d1);
  const Nd2 = normCdf(optionType === 'call' ? d2 : -d2);

  const discountedSpot = spotPrice * Math.exp(-dividendYield * t);
  const discountedStrike = strikePrice * Math.exp(-riskFreeRate * t);

  const fairValue =
    optionType === 'call'
      ? discountedSpot * normCdf(d1) - discountedStrike * normCdf(d2)
      : discountedStrike * normCdf(-d2) - discountedSpot * normCdf(-d1);

  const optionPrice = adjustForQuantity(fairValue, quantity);

  const greeks: PricingGreekSet = {
    delta:
      optionType === 'call'
        ? Math.exp(-dividendYield * t) * normCdf(d1)
        : Math.exp(-dividendYield * t) * (normCdf(d1) - 1),
    gamma: (Math.exp(-dividendYield * t) * normPdf(d1)) / (spotPrice * sigma * Math.sqrt(t)),
    theta:
      ((-spotPrice * normPdf(d1) * sigma * Math.exp(-dividendYield * t)) / (2 * Math.sqrt(t)) -
        (optionType === 'call'
          ? riskFreeRate * strikePrice * Math.exp(-riskFreeRate * t) * normCdf(d2)
          : -riskFreeRate * strikePrice * Math.exp(-riskFreeRate * t) * normCdf(-d2)) +
        dividendYield * spotPrice * Math.exp(-dividendYield * t) * (optionType === 'call' ? normCdf(d1) : normCdf(d1) - 1)) /
      365,
    vega: (spotPrice * Math.exp(-dividendYield * t) * normPdf(d1) * Math.sqrt(t)) / 100,
    rho:
      ((optionType === 'call' ? strikePrice : -strikePrice) *
        Math.exp(-riskFreeRate * t) *
        normCdf(optionType === 'call' ? d2 : -d2) *
        t) /
      100,
  };

  const breakeven = optionType === 'call' ? strikePrice + fairValue : strikePrice - fairValue;

  return {
    model: 'blackScholes',
    price: optionPrice,
    fairValue,
    breakevenPrice: breakeven,
    greeks: buildGreeksMetadata(greeks),
    metadata: {
      label: 'Black-Scholes',
      computationTimeMs: performance.now() - start,
      parameters: {
        sigma,
        t,
      },
    },
  };
};

const priceBinomial = (
  optionType: OptionType,
  context: PricingContext,
  config?: BinomialConfig
): OptionPricingResult => {
  const start = performance.now();
  const {
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    volatility,
    dividendYield = 0,
    quantity = 1,
  } = context;

  const steps = Math.max(10, Math.min(config?.steps ?? 100, 1000));
  const sigma = clampVolatility(volatility);
  const optionValue = binomialPrice(
    optionType,
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    sigma,
    dividendYield,
    steps
  );
  const optionPrice = adjustForQuantity(optionValue, quantity);

  const greeks = estimateGreeksFromBinomial(optionType, {
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    volatility: sigma,
    dividendYield,
  });

  const breakeven = optionType === 'call' ? strikePrice + optionValue : strikePrice - optionValue;

  return {
    model: 'binomial',
    price: optionPrice,
    fairValue: optionValue,
    breakevenPrice: breakeven,
    greeks: buildGreeksMetadata(greeks),
    metadata: {
      label: 'Binomial Tree',
      computationTimeMs: performance.now() - start,
      parameters: {
        steps,
        sigma,
      },
    },
  };
};

const estimateGreeksFromBinomial = (
  optionType: OptionType,
  context: Omit<PricingContext, 'quantity'>
): PricingGreekSet => {
  const {
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    volatility,
    dividendYield = 0,
  } = context;

  const steps = 100;
  const sigma = clampVolatility(volatility);

  const price = (params: {
    spot?: number;
    time?: number;
    vol?: number;
    rate?: number;
  }) =>
    binomialPrice(
      optionType,
      params.spot ?? spotPrice,
      strikePrice,
      params.time ?? timeToExpiration,
      params.rate ?? riskFreeRate,
      params.vol ?? sigma,
      dividendYield,
      steps
    );

  const epsilonSpot = spotPrice * 0.01 || 1;
  const epsilonVol = 0.01;
  const epsilonRate = 0.01;
  const epsilonTime = Math.max(timeToExpiration / 365, 1 / 365);

  const basePrice = price({});
  const priceUpSpot = price({ spot: spotPrice + epsilonSpot });
  const priceDownSpot = price({ spot: Math.max(spotPrice - epsilonSpot, 0.0001) });

  const delta = (priceUpSpot - priceDownSpot) / (2 * epsilonSpot);
  const gamma =
    (priceUpSpot - 2 * basePrice + priceDownSpot) / (epsilonSpot * epsilonSpot);

  const priceThetaForward = price({ time: Math.max(timeToExpiration - epsilonTime, 1 / 365) });
  const theta = (priceThetaForward - basePrice) / epsilonTime / 365;

  const priceVegaUp = price({ vol: sigma + epsilonVol });
  const priceVegaDown = price({ vol: Math.max(sigma - epsilonVol, 0.0001) });
  const vega = (priceVegaUp - priceVegaDown) / (2 * epsilonVol) / 100;

  const priceRhoUp = price({ rate: riskFreeRate + epsilonRate });
  const priceRhoDown = price({ rate: riskFreeRate - epsilonRate });
  const rho = (priceRhoUp - priceRhoDown) / (2 * epsilonRate) / 100;

  return {
    delta,
    gamma,
    theta,
    vega,
    rho,
  };
};

const binomialPrice = (
  optionType: OptionType,
  spotPrice: number,
  strikePrice: number,
  timeToExpiration: number,
  riskFreeRate: number,
  volatility: number,
  dividendYield = 0,
  steps = 100
): number => {
  const t = clampTime(timeToExpiration);
  const dt = t / steps;
  const sigma = clampVolatility(volatility);
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const growth = Math.exp((riskFreeRate - dividendYield) * dt);
  const p = (growth - d) / (u - d);
  const disc = Math.exp(-riskFreeRate * dt);

  const optionValues = new Array<number>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const ST = spotPrice * u ** (steps - i) * d ** i;
    optionValues[i] =
      optionType === 'call' ? Math.max(0, ST - strikePrice) : Math.max(0, strikePrice - ST);
  }

  for (let step = steps - 1; step >= 0; step--) {
    for (let i = 0; i <= step; i++) {
      const continuation = disc * (p * optionValues[i] + (1 - p) * optionValues[i + 1]);
      const ST = spotPrice * u ** (step - i) * d ** i;
      const intrinsic =
        optionType === 'call' ? Math.max(0, ST - strikePrice) : Math.max(0, strikePrice - ST);
      optionValues[i] = Math.max(continuation, intrinsic);
    }
  }

  return optionValues[0];
};

const priceMonteCarlo = (
  optionType: OptionType,
  context: PricingContext,
  config?: MonteCarloConfig
): OptionPricingResult => {
  const start = performance.now();
  const {
    spotPrice,
    strikePrice,
    timeToExpiration,
    riskFreeRate,
    volatility,
    dividendYield = 0,
    quantity = 1,
  } = context;

  const paths = Math.max(1_000, Math.min(config?.paths ?? 20_000, 200_000));
  const sigma = clampVolatility(volatility);
  const t = clampTime(timeToExpiration);

  const random = createRandomGenerator(config?.seed);
  const dt = t / 252; // daily steps
  const steps = Math.max(1, Math.round(t / dt));

  const payoffs: number[] = [];
  const payoffSeries: Array<{ underlying: number; payoff: number }> = [];

  for (let path = 0; path < paths; path++) {
    let s = spotPrice;
    for (let step = 0; step < steps; step++) {
      const z = random();
      s *= Math.exp(
        (riskFreeRate - dividendYield - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z
      );
    }
    const payoff =
      optionType === 'call' ? Math.max(0, s - strikePrice) : Math.max(0, strikePrice - s);
    payoffs.push(payoff);
    if (path < 1000) {
      payoffSeries.push({ underlying: s, payoff });
    }
  }

  const discountFactor = Math.exp(-riskFreeRate * t);
  const meanPayoff = payoffs.reduce((acc, val) => acc + val, 0) / paths;
  const discountedPrice = discountFactor * meanPayoff;
  const optionPrice = adjustForQuantity(discountedPrice, quantity);

  const stdev =
    payoffs.reduce((acc, val) => acc + (val - meanPayoff) ** 2, 0) / (paths - 1 || 1);
  const stddev = Math.sqrt(stdev);

  const distribution = buildMonteCarloDistribution(payoffs, meanPayoff, stddev);

  const breakeven =
    optionType === 'call' ? strikePrice + discountedPrice : strikePrice - discountedPrice;

  return {
    model: 'monteCarlo',
    price: optionPrice,
    fairValue: discountedPrice,
    breakevenPrice: breakeven,
    payoffSeries,
    monteCarloDistribution: distribution,
    metadata: {
      label: 'Monte Carlo',
      computationTimeMs: performance.now() - start,
      parameters: {
        paths,
        sigma,
        steps,
      },
      warnings: paths < 5000 ? ['Increase path count for more stable estimates'] : undefined,
    },
  };
};

const createRandomGenerator = (seed = Date.now()): (() => number) => {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;

  const next = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };

  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };
};

const buildMonteCarloDistribution = (
  payoffs: number[],
  mean: number,
  stddev: number
) => {
  const sorted = [...payoffs].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[index];
  };

  return {
    mean,
    standardDeviation: stddev,
    percentiles: {
      p05: percentile(0.05),
      p25: percentile(0.25),
      p50: percentile(0.5),
      p75: percentile(0.75),
      p95: percentile(0.95),
    },
  };
};

export const priceMultipleModels = (
  models: OptionPricingModel[],
  optionType: OptionType,
  context: PricingContext,
  configs?: {
    binomial?: BinomialConfig;
    monteCarlo?: MonteCarloConfig;
  }
): OptionPricingResult[] => {
  const results: OptionPricingResult[] = [];
  for (const model of models) {
    if (model === 'binomial') {
      results.push(priceOption(model, optionType, context, configs?.binomial));
    } else if (model === 'monteCarlo') {
      results.push(priceOption(model, optionType, context, configs?.monteCarlo));
    } else {
      results.push(priceOption(model, optionType, context));
    }
  }
  return results;
};


