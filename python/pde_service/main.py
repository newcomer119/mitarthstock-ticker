from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field, validator


OptionType = Literal["call", "put"]


@dataclass(slots=True)
class SolverConfig:
    n_space: int
    n_time: int
    s_max_multiplier: float = 5.0


class PDERequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    option_type: OptionType
    spot: float = Field(..., gt=0)
    strike: float = Field(..., gt=0)
    expiry: float = Field(..., gt=0)  # in years
    volatility: float = Field(..., gt=0)
    risk_free_rate: float
    dividend_yield: float = 0.0
    quantity: int = Field(1, gt=0)
    grid_size: int | None = Field(None, ge=50, le=2000)
    time_steps: int | None = Field(None, ge=50, le=4000)
    s_max_multiplier: float | None = Field(None, gt=2.0, le=20.0)

    @validator("option_type")
    def validate_option_type(cls, value: str) -> str:
        value_lower = value.lower()
        if value_lower not in {"call", "put"}:
            raise ValueError("option_type must be 'call' or 'put'")
        return value_lower


class GreekPayload(BaseModel):
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    rho: float | None = None


class DiagnosticsPayload(BaseModel):
    grid_points: int
    time_steps: int
    residual_norm: float
    runtime_ms: float | None = None
    boundary_spread: float
    s_max: float


class PDEOutput(BaseModel):
    symbol: str
    option_type: OptionType
    fair_value: float
    price: float
    quantity: int
    greeks: GreekPayload
    diagnostics: DiagnosticsPayload
    warnings: list[str]


def crank_nicolson_price(
    *,
    option_type: OptionType,
    spot: float,
    strike: float,
    expiry: float,
    risk_free_rate: float,
    dividend_yield: float,
    volatility: float,
    config: SolverConfig,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    n_space = config.n_space
    n_time = config.n_time
    s_max_multiplier = config.s_max_multiplier

    s_max_seed = max(spot, strike, 1.0)
    s_max = s_max_multiplier * s_max_seed
    d_s = s_max / n_space
    d_tau = expiry / n_time

    s_grid = np.linspace(0.0, s_max, n_space + 1)

    if option_type == "call":
        payoff = np.maximum(s_grid - strike, 0.0)
    else:
        payoff = np.maximum(strike - s_grid, 0.0)

    v_curr = payoff.copy()
    v_next = np.empty_like(v_curr)

    sigma_sq = volatility * volatility
    r = risk_free_rate
    q = dividend_yield

    i_vals = np.arange(1, n_space)
    s_vals = i_vals * d_s

    alpha = 0.25 * d_tau * (
        sigma_sq * (s_vals ** 2) / (d_s ** 2)
        - (r - q) * s_vals / d_s
    )
    beta = -0.5 * d_tau * (
        sigma_sq * (s_vals ** 2) / (d_s ** 2)
        + r
    )
    gamma = 0.25 * d_tau * (
        sigma_sq * (s_vals ** 2) / (d_s ** 2)
        + (r - q) * s_vals / d_s
    )

    A = -alpha
    B = 1.0 - beta
    C = -gamma

    D = alpha
    E = 1.0 + beta
    F = gamma

    lower = np.zeros(n_space - 1)
    lower[1:] = A[1:]
    diag = B.copy()
    upper = np.zeros(n_space - 1)
    upper[:-1] = C[:-1]

    rhs = np.zeros(n_space - 1)
    residual_norm = 0.0
    first_step_values = None

    for step in range(n_time):
        tau = step * d_tau
        tau_next = tau + d_tau

        if option_type == "call":
            v_curr[0] = 0.0
            v_curr[-1] = s_max * np.exp(-q * tau) - strike * np.exp(-r * tau)
            lower_bc_next = 0.0
            upper_bc_next = s_max * np.exp(-q * tau_next) - strike * np.exp(-r * tau_next)
        else:
            v_curr[0] = strike * np.exp(-r * tau)
            v_curr[-1] = 0.0
            lower_bc_next = strike * np.exp(-r * tau_next)
            upper_bc_next = 0.0

        rhs[:] = (
            D * v_curr[:-2]
            + E * v_curr[1:-1]
            + F * v_curr[2:]
        )

        rhs[0] -= A[0] * lower_bc_next
        rhs[-1] -= C[-1] * upper_bc_next

        rhs_vector = rhs.copy()

        v_next[0] = lower_bc_next
        v_next[-1] = upper_bc_next

        v_next_interiors = solve_tridiagonal(lower, diag, upper, rhs_vector)
        v_next[1:-1] = v_next_interiors

        if first_step_values is None:
            first_step_values = v_next.copy()

        lhs = (
            A * v_next[:-2]
            + B * v_next[1:-1]
            + C * v_next[2:]
        )
        residual_norm = max(
            residual_norm,
            float(np.linalg.norm(lhs - rhs_vector, ord=np.inf)),
        )

        v_curr, v_next = v_next, v_curr  # swap references for next iteration

    # After loop, v_curr holds solution at tau = expiry (i.e., t = 0)
    solution = v_curr
    first_step = first_step_values if first_step_values is not None else solution.copy()

    boundary_spread = float(np.abs(solution[0]) + np.abs(solution[-1]))

    return s_grid, solution, first_step, residual_norm, boundary_spread


def solve_tridiagonal(
    lower: np.ndarray,
    diag: np.ndarray,
    upper: np.ndarray,
    rhs: np.ndarray,
) -> np.ndarray:
    """Solve tridiagonal system via Thomas algorithm."""
    n = diag.shape[0]
    if n == 0:
        return np.array([])

    c_prime = np.zeros(n)
    d_prime = np.zeros(n)
    solution = np.zeros(n)

    denom = diag[0]
    if abs(denom) < 1e-12:
        denom = 1e-12 if denom >= 0 else -1e-12
    d_prime[0] = rhs[0] / denom
    if n > 1:
        c_prime[0] = upper[0] / denom

    for i in range(1, n):
        denom = diag[i] - lower[i] * c_prime[i - 1]
        if abs(denom) < 1e-12:
            denom = 1e-12 if denom >= 0 else -1e-12
        if i < n - 1:
            c_prime[i] = upper[i] / denom
        d_prime[i] = (rhs[i] - lower[i] * d_prime[i - 1]) / denom

    solution[-1] = d_prime[-1]
    for i in range(n - 2, -1, -1):
        solution[i] = d_prime[i] - c_prime[i] * solution[i + 1]

    return solution


def interpolate_value(s_grid: np.ndarray, values: np.ndarray, spot: float) -> float:
    return float(np.interp(spot, s_grid, values))


def finite_difference(
    values: np.ndarray,
    grid: np.ndarray,
    spot: float,
    order: int,
) -> float | None:
    if values.size < 3:
        return None

    idx = int(np.searchsorted(grid, spot))
    idx = int(np.clip(idx, 1, values.size - 2))

    v_m = values[idx - 1]
    v_0 = values[idx]
    v_p = values[idx + 1]

    d_s = grid[1] - grid[0]

    if order == 1:
        return float((v_p - v_m) / (2.0 * d_s))
    if order == 2:
        return float((v_p - 2.0 * v_0 + v_m) / (d_s * d_s))
    raise ValueError("order must be 1 or 2")


def bump_and_price(
    *,
    option_type: OptionType,
    spot: float,
    strike: float,
    expiry: float,
    risk_free_rate: float,
    dividend_yield: float,
    volatility: float,
    config: SolverConfig,
    bump_sigma: float | None = None,
    bump_rate: float | None = None,
) -> float:
    sigma = volatility + (bump_sigma or 0.0)
    sigma = max(sigma, 1e-4)
    rate = risk_free_rate + (bump_rate or 0.0)

    s_grid, solution, _, _, _ = crank_nicolson_price(
        option_type=option_type,
        spot=spot,
        strike=strike,
        expiry=expiry,
        risk_free_rate=rate,
        dividend_yield=dividend_yield,
        volatility=sigma,
        config=config,
    )
    return interpolate_value(s_grid, solution, spot)


def solve_black_scholes_pde(request: PDERequest) -> PDEOutput:
    grid_points = request.grid_size or 400
    time_steps = request.time_steps or 800
    s_max_multiplier = request.s_max_multiplier or 6.0

    config = SolverConfig(
        n_space=grid_points,
        n_time=time_steps,
        s_max_multiplier=s_max_multiplier,
    )

    (
        s_grid,
        solution,
        first_step,
        residual_norm,
        boundary_spread,
    ) = crank_nicolson_price(
        option_type=request.option_type,
        spot=request.spot,
        strike=request.strike,
        expiry=request.expiry,
        risk_free_rate=request.risk_free_rate,
        dividend_yield=request.dividend_yield,
        volatility=request.volatility,
        config=config,
    )

    fair_value = interpolate_value(s_grid, solution, request.spot)

    delta = finite_difference(solution, s_grid, request.spot, order=1)
    gamma = finite_difference(solution, s_grid, request.spot, order=2)

    theta = None
    if request.expiry > 1e-6:
        value_tau_dt = interpolate_value(s_grid, first_step, request.spot)
        dt = request.expiry / config.n_time
        theta = float(-(value_tau_dt - fair_value) / dt)

    bump_size_sigma = max(1e-4, 0.01 * request.volatility)
    bump_size_rate = 1e-4

    vega = None
    rho = None

    try:
        price_up = bump_and_price(
            option_type=request.option_type,
            spot=request.spot,
            strike=request.strike,
            expiry=request.expiry,
            risk_free_rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            volatility=request.volatility,
            config=config,
            bump_sigma=bump_size_sigma,
        )
        price_down = bump_and_price(
            option_type=request.option_type,
            spot=request.spot,
            strike=request.strike,
            expiry=request.expiry,
            risk_free_rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            volatility=request.volatility,
            config=config,
            bump_sigma=-bump_size_sigma,
        )
        vega = float((price_up - price_down) / (2.0 * bump_size_sigma))
    except Exception:
        vega = None

    try:
        price_up = bump_and_price(
            option_type=request.option_type,
            spot=request.spot,
            strike=request.strike,
            expiry=request.expiry,
            risk_free_rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            volatility=request.volatility,
            config=config,
            bump_rate=bump_size_rate,
        )
        price_down = bump_and_price(
            option_type=request.option_type,
            spot=request.spot,
            strike=request.strike,
            expiry=request.expiry,
            risk_free_rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            volatility=request.volatility,
            config=config,
            bump_rate=-bump_size_rate,
        )
        rho = float((price_up - price_down) / (2.0 * bump_size_rate))
    except Exception:
        rho = None

    diagnostics = DiagnosticsPayload(
        grid_points=config.n_space,
        time_steps=config.n_time,
        residual_norm=residual_norm,
        runtime_ms=None,
        boundary_spread=boundary_spread,
        s_max=float(s_grid[-1]),
    )

    warnings: list[str] = []

    if residual_norm > 1e-3:
        warnings.append(
            f"High residual norm detected ({residual_norm:.2e}); consider increasing grid resolution.",
        )
    if boundary_spread > max(1.0, 0.05 * fair_value):
        warnings.append(
            "Boundary spread is large; increase s_max_multiplier or check inputs.",
        )

    price = fair_value * request.quantity if request.quantity else fair_value

    return PDEOutput(
        symbol=request.symbol.upper(),
        option_type=request.option_type,
        fair_value=fair_value,
        price=price,
        quantity=request.quantity,
        greeks=GreekPayload(
            delta=delta,
            gamma=gamma,
            theta=theta,
            vega=vega,
            rho=rho,
        ),
        diagnostics=diagnostics,
        warnings=warnings,
    )


app = FastAPI(title="PDE Option Pricing Service", version="0.1.0")


@app.post("/pde/price", response_model=PDEOutput)
def price_option(request: PDERequest) -> PDEOutput:
    return solve_black_scholes_pde(request)


