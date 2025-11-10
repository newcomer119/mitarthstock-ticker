"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatPrice } from "@/lib/utils";
import type {
  OptionPricingModel,
  OptionPricingResponsePayload,
} from "@/types/options";

type FormState = {
  symbol: string;
  optionType: "call" | "put";
  strike: string;
  expiration: string;
  quantity: string;
  models: OptionPricingModel[];
  binomialSteps: string;
  monteCarloPaths: string;
  monteCarloSeed: string;
  volatilityOverride: string;
  riskFreeRateOverride: string;
  dividendYieldOverride: string;
};

const DEFAULT_FORM_STATE: FormState = {
  symbol: "",
  optionType: "call",
  strike: "",
  expiration: "",
  quantity: "1",
  models: ["blackScholes", "binomial", "monteCarlo"],
  binomialSteps: "200",
  monteCarloPaths: "25000",
  monteCarloSeed: "",
  volatilityOverride: "",
  riskFreeRateOverride: "",
  dividendYieldOverride: "",
};

const MODEL_LABELS: Record<OptionPricingModel, string> = {
  blackScholes: "Black-Scholes",
  binomial: "Binomial Tree",
  monteCarlo: "Monte Carlo",
};

const formatPercent = (value: number) =>
  `${(value * 100).toFixed(2)}%`;

const formatNumber = (value: number, fractionDigits = 2) =>
  Number.isFinite(value) ? value.toFixed(fractionDigits) : "—";

export function OptionPricingWorkspace() {
  const [formState, setFormState] = useState<FormState>(DEFAULT_FORM_STATE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pricingData, setPricingData] =
    useState<OptionPricingResponsePayload | null>(null);

  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  };

  const handleModelToggle = (model: OptionPricingModel) => {
    setFormState((prev) => {
      const exists = prev.models.includes(model);
      const models = exists
        ? prev.models.filter((m) => m !== model)
        : [...prev.models, model];
      return { ...prev, models };
    });
  };

  const handleOptionTypeChange = (value: "call" | "put") => {
    setFormState((prev) => ({ ...prev, optionType: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const strike = Number.parseFloat(formState.strike);
    const quantity = Number.parseInt(formState.quantity, 10);
    if (!formState.symbol.trim()) {
      setError("Enter a valid underlying symbol.");
      return;
    }
    if (!Number.isFinite(strike) || strike <= 0) {
      setError("Enter a valid strike price.");
      return;
    }
    if (!formState.expiration) {
      setError("Select an expiration date.");
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Quantity must be a positive integer.");
      return;
    }
    if (formState.models.length === 0) {
      setError("Select at least one pricing model.");
      return;
    }

    const payload: Record<string, unknown> = {
      symbol: formState.symbol.trim().toUpperCase(),
      optionType: formState.optionType,
      strike,
      expiration: formState.expiration,
      quantity,
      models: formState.models,
    };

    const optionalNumber = (raw: string, parser: (v: string) => number) => {
      const parsed = parser(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    if (formState.binomialSteps) {
      const steps = optionalNumber(formState.binomialSteps, (v) =>
        Number.parseInt(v, 10)
      );
      if (steps) payload.binomialSteps = steps;
    }
    if (formState.monteCarloPaths) {
      const paths = optionalNumber(formState.monteCarloPaths, (v) =>
        Number.parseInt(v, 10)
      );
      if (paths) payload.monteCarloPaths = paths;
    }
    if (formState.monteCarloSeed) {
      const seed = optionalNumber(formState.monteCarloSeed, (v) =>
        Number.parseInt(v, 10)
      );
      if (seed) payload.monteCarloSeed = seed;
    }
    if (formState.volatilityOverride) {
      const vol = optionalNumber(formState.volatilityOverride, (v) =>
        Number.parseFloat(v)
      );
      if (vol !== undefined) payload.volatilityOverride = vol / 100;
    }
    if (formState.riskFreeRateOverride) {
      const rate = optionalNumber(formState.riskFreeRateOverride, (v) =>
        Number.parseFloat(v)
      );
      if (rate !== undefined) payload.riskFreeRateOverride = rate / 100;
    }
    if (formState.dividendYieldOverride) {
      const div = optionalNumber(formState.dividendYieldOverride, (v) =>
        Number.parseFloat(v)
      );
      if (div !== undefined) payload.dividendYieldOverride = div / 100;
    }

    try {
      setIsSubmitting(true);
      const response = await fetch("/api/options/price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data?.error || "Failed to fetch option pricing results."
        );
      }
      const data: OptionPricingResponsePayload = await response.json();
      setPricingData(data);
      toast.success("Pricing models evaluated successfully.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error occurred.";
      setError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setFormState(DEFAULT_FORM_STATE);
    setPricingData(null);
    setError(null);
  };

  const modelButtons = useMemo(
    () =>
      (Object.keys(MODEL_LABELS) as OptionPricingModel[]).map((model) => {
        const active = formState.models.includes(model);
        return (
          <Button
            key={model}
            type="button"
            variant={active ? "default" : "outline"}
            className={active ? "ring-2 ring-primary/50" : ""}
            onClick={() => handleModelToggle(model)}
          >
            {MODEL_LABELS[model]}
          </Button>
        );
      }),
    [formState.models]
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Options Pricing Lab</h1>
        <p className="text-muted-foreground">
          Compare Black-Scholes, Binomial, and Monte Carlo valuations with live
          Finnhub market data.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 gap-6 rounded-xl border border-border/60 bg-card/50 p-6 backdrop-blur lg:grid-cols-[minmax(0,380px),1fr]"
      >
        <section className="flex flex-col gap-5">
          <div className="space-y-1">
            <label className="text-sm font-medium">Underlying symbol</label>
            <Input
              name="symbol"
              placeholder="AAPL"
              value={formState.symbol}
              onChange={handleInputChange}
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Option type</label>
              <Select
                value={formState.optionType}
                onValueChange={(value: "call" | "put") =>
                  handleOptionTypeChange(value)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="put">Put</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Quantity</label>
              <Input
                name="quantity"
                type="number"
                min={1}
                value={formState.quantity}
                onChange={handleInputChange}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Strike price</label>
              <Input
                name="strike"
                type="number"
                min={0}
                step="0.01"
                value={formState.strike}
                onChange={handleInputChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Expiration date</label>
              <Input
                name="expiration"
                type="date"
                value={formState.expiration}
                onChange={handleInputChange}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Pricing models</label>
            <div className="flex flex-wrap gap-2">{modelButtons}</div>
          </div>

          <div className="space-y-4 rounded-lg border border-dashed border-border/70 p-4">
            <p className="text-sm font-medium">Advanced settings (optional)</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="Volatility override (%)"
                name="volatilityOverride"
                value={formState.volatilityOverride}
                onChange={handleInputChange}
                placeholder="e.g. 25"
              />
              <TextField
                label="Risk-free rate override (%)"
                name="riskFreeRateOverride"
                value={formState.riskFreeRateOverride}
                onChange={handleInputChange}
                placeholder="e.g. 4.75"
              />
              <TextField
                label="Dividend yield override (%)"
                name="dividendYieldOverride"
                value={formState.dividendYieldOverride}
                onChange={handleInputChange}
                placeholder="e.g. 0.65"
              />
              <TextField
                label="Binomial steps"
                name="binomialSteps"
                value={formState.binomialSteps}
                onChange={handleInputChange}
                placeholder="200"
              />
              <TextField
                label="Monte Carlo paths"
                name="monteCarloPaths"
                value={formState.monteCarloPaths}
                onChange={handleInputChange}
                placeholder="25000"
              />
              <TextField
                label="Monte Carlo seed"
                name="monteCarloSeed"
                value={formState.monteCarloSeed}
                onChange={handleInputChange}
                placeholder="(optional)"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Calculating..." : "Run models"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={resetForm}
              disabled={isSubmitting}
            >
              Reset form
            </Button>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="space-y-4">
          {!pricingData ? (
            <PlaceholderCard />
          ) : (
            <PricingResultsCard data={pricingData} />
          )}
        </section>
      </form>
    </div>
  );
}

type TextFieldProps = {
  label: string;
  name: keyof FormState;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
};

const TextField = ({
  label,
  name,
  value,
  onChange,
  placeholder,
}: TextFieldProps) => (
  <div className="space-y-1">
    <label className="text-sm font-medium">{label}</label>
    <Input
      name={name}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      autoComplete="off"
    />
  </div>
);

const PlaceholderCard = () => (
  <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/10 text-center">
    <p className="text-sm text-muted-foreground">
      Enter contract details and run the models to see pricing insights.
    </p>
  </div>
);

type PricingResultsCardProps = {
  data: OptionPricingResponsePayload;
};

const PricingResultsCard = ({ data }: PricingResultsCardProps) => {
  const {
    symbol,
    optionType,
    strike,
    underlyingPrice,
    impliedVolatility,
    riskFreeRate,
    dividendYield,
    timeToExpiration,
    results,
    contract,
    quantity,
  } = data;

  return (
    <div className="space-y-5 rounded-xl border border-border/70 bg-background/60 p-5">
      <div className="grid gap-3 md:grid-cols-2">
        <SummaryField label="Underlying" value={symbol} />
        <SummaryField label="Option type" value={optionType.toUpperCase()} />
        <SummaryField label="Strike" value={formatPrice(strike)} />
        <SummaryField label="Spot price" value={formatPrice(underlyingPrice)} />
        <SummaryField
          label="Quantity"
          value={quantity.toString()}
        />
        <SummaryField
          label="Time to expiry"
          value={`${(timeToExpiration * 365).toFixed(1)} days`}
        />
        <SummaryField
          label="Implied volatility"
          value={
            impliedVolatility
              ? formatPercent(impliedVolatility)
              : "Not available"
          }
        />
        <SummaryField
          label="Risk-free rate"
          value={formatPercent(riskFreeRate)}
        />
        <SummaryField
          label="Dividend yield"
          value={formatPercent(dividendYield)}
        />
      </div>

      {contract && (
        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 text-sm">
          <p className="font-medium">Closest Finnhub contract</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <SummaryField
              label="Bid / Ask"
              value={`${contract.bid ? formatPrice(contract.bid) : "—"} / ${
                contract.ask ? formatPrice(contract.ask) : "—"
              }`}
            />
            <SummaryField
              label="Last price"
              value={
                contract.lastPrice ? formatPrice(contract.lastPrice) : "—"
              }
            />
            <SummaryField
              label="Greeks (Finnhub)"
              value={`Δ ${formatNumber(contract.delta ?? NaN)} | Γ ${formatNumber(
                contract.gamma ?? NaN
              )} | Θ ${formatNumber(contract.theta ?? NaN)} | ν ${formatNumber(
                contract.vega ?? NaN
              )}`}
            />
          </div>
        </div>
      )}

      <div className="space-y-4">
        {results.map((result) => (
          <ResultCard key={result.model} result={result} />
        ))}
      </div>
    </div>
  );
};

type SummaryFieldProps = { label: string; value: string };
const SummaryField = ({ label, value }: SummaryFieldProps) => (
  <div className="flex flex-col gap-1 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

type ResultCardProps = {
  result: OptionPricingResponsePayload["results"][number];
};

const ResultCard = ({ result }: ResultCardProps) => {
  const {
    metadata,
    price,
    greeks,
    breakevenPrice,
    fairValue,
    monteCarloDistribution,
  } = result;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/5 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{metadata.label}</h3>
        <p className="text-sm text-muted-foreground">
          Runtime {metadata.computationTimeMs.toFixed(1)} ms
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SummaryField label="Model value" value={formatPrice(fairValue)} />
        <SummaryField label="Total premium" value={formatPrice(price)} />
        <SummaryField label="Breakeven" value={formatPrice(breakevenPrice)} />
      </div>

      {greeks && (
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <SummaryField
            label="Delta / Gamma"
            value={`${formatNumber(greeks.delta)} / ${formatNumber(
              greeks.gamma
            )}`}
          />
          <SummaryField
            label="Theta / Vega"
            value={`${formatNumber(greeks.theta)} / ${formatNumber(
              greeks.vega
            )}`}
          />
          <SummaryField
            label="Rho"
            value={formatNumber(greeks.rho)}
          />
        </div>
      )}

      {monteCarloDistribution && (
        <div className="mt-4 rounded border border-border/50 bg-background/60 p-3 text-sm">
          <p className="font-medium">Monte Carlo distribution</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <SummaryField
              label="Mean payoff"
              value={formatPrice(monteCarloDistribution.mean)}
            />
            <SummaryField
              label="Std. deviation"
              value={formatPrice(monteCarloDistribution.standardDeviation)}
            />
            <SummaryField
              label="P25 / P75"
              value={`${formatPrice(monteCarloDistribution.percentiles.p25)} / ${formatPrice(
                monteCarloDistribution.percentiles.p75
              )}`}
            />
            <SummaryField
              label="P05 / P95"
              value={`${formatPrice(monteCarloDistribution.percentiles.p05)} / ${formatPrice(
                monteCarloDistribution.percentiles.p95
              )}`}
            />
          </div>
        </div>
      )}

      {metadata.warnings && metadata.warnings.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-yellow-600 dark:text-yellow-400">
          {metadata.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
};


