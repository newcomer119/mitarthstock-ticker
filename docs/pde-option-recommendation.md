    ## PDE-Based Option Pricing & Recommendation

    ### Overview
    - **Goal**: add a partial differential equation (PDE) engine that produces a bespoke fair value and risk metrics for the `OptionPricingWorkspace`.
    - **Scope**: European equity options (calls & puts) with continuous dividend yield under Black–Scholes dynamics.
    - **Output**: model price, per-contract premium, Greeks, and diagnostics that feed a lightweight recommendation layer (e.g., flagging mispricings against Finnhub quotes).

    ### Model Formulation
    - Underlying price process follows geometric Brownian motion:
    - \( \mathrm{d}S_t = (r - q) S_t \, \mathrm{d}t + \sigma S_t \, \mathrm{d}W_t \)
    - \( r \) risk-free rate, \( q \) dividend yield, \( \sigma \) volatility (either implied or override).
    - European option value \( V(S, t) \) solves the backward Black–Scholes PDE:
    - \( \frac{\partial V}{\partial t} + \frac{1}{2} \sigma^2 S^2 \frac{\partial^2 V}{\partial S^2} + (r - q) S \frac{\partial V}{\partial S} - r V = 0 \)
    - Transform expiry \( T \) to time variable \( \tau = T - t \) to evolve from maturity back to present.

    ### Terminal Payoff (Initial Condition)
    - At \( \tau = 0 \) (i.e., \( t = T \)):
    - Call: \( V(S, 0) = \max(S - K, 0) \)
    - Put: \( V(S, 0) = \max(K - S, 0) \)

    ### Boundary Conditions
    - **Lower boundary** \( S = 0 \):
    - Call: \( V(0, \tau) = 0 \)
    - Put: \( V(0, \tau) = K e^{-r \tau} \)
    - **Upper boundary** \( S \rightarrow S_{\max} \):
    - Call: \( V(S_{\max}, \tau) = S_{\max} e^{-q \tau} - K e^{-r \tau} \)
    - Put: \( V(S_{\max}, \tau) = 0 \)
    - Choose \( S_{\max} \) large enough (e.g., \( 4\text{–}6 \times \max(S_0, K) \)) to suppress truncation error.

    ### Numerical Scheme
    - Use a Crank–Nicolson finite-difference grid for stability and second-order accuracy in time and space.
    - Discretize price grid: \( S_i = i \cdot \Delta S \) for \( i = 0,\dots,N_S \).
    - Discretize time grid: \( \tau_j = j \cdot \Delta \tau \) for \( j = 0,\dots,N_T \).
    - Semi-implicit update per timestep:
    - Solve tridiagonal linear system \( A V^{j+1} = B V^{j} + b \) via Thomas algorithm.
    - Incorporate boundary conditions in vectors \( b \) and matrix edges.
    - Diagnostics:
    - Track residual norms \( \|A V^{j+1} - (B V^{j} + b)\| \).
    - Estimate truncation error by halving grid spacing and comparing (Richardson extrapolation).

    ### Greeks Extraction
    - Recover sensitivities from the grid near spot \( S_0 \):
    - \( \Delta \approx \frac{V_{i+1} - V_{i-1}}{2 \Delta S} \)
    - \( \Gamma \approx \frac{V_{i+1} - 2 V_i + V_{i-1}}{(\Delta S)^2} \)
    - Theta from temporal differencing: \( \Theta \approx \frac{V^{j+1}_i - V^j_i}{\Delta \tau} \).
    - Vega and Rho via bump-and-revalue (reuse solver with perturbed \( \sigma \) or \( r \)).

    ### Recommendation Logic
    - **Fair value gap**: compare PDE price against Finnhub mid-price; flag if deviation exceeds configurable threshold.
    - **Model consensus**: rank disagreement between PDE, closed-form Black–Scholes, Binomial, Monte Carlo.
    - **Distribution cues**: for calls/puts, use PDE greeks to annotate convexity (e.g., highlight high gamma zones).
    - Provide textual insights (e.g., “PDE price $X is 7% below market ask $Y; consider selling premium”).

    ### Computational Budget
    - Suggested defaults: \( N_S = 400\text{–}800 \), \( N_T = 500\text{–}1000 \).
    - Runtime target: < 100 ms per contract on server hardware; leverage caching keyed by `(symbol, K, T, σ, r, q, gridSpec)`.

    ### Integration Plan
    - Implement solver in Python (`FastAPI` or `Flask`) leveraging NumPy/SciPy.
    - Expose endpoint `/pde/price` accepting the contract descriptor (spot, strike, sigma, r, q, expiry, option type, quantity, grid overrides).
    - Return JSON payload with price, greeks, diagnostics, and warnings.
    - In Next.js API (`app/api/options/price/route.ts`):
    - Extend handler to `await` the Python service when `models` include `"pde"`.
    - Normalize data and merge into `OptionPricingResponsePayload`.
    - Frontend (`OptionPricingWorkspace.tsx`):
    - Add toggle for PDE model (default on/off per UX decision).
    - Render results via existing `ResultCard`.
    - Display diagnostics (residual, grid size, warnings) to build trust.

    ### Validation Strategy
    - Compare solver output against analytic Black–Scholes for European options; ensure relative error < 1e-3.
    - Cross-check with Monte Carlo results for sanity.
    - Regression tests on benchmark contracts (varying maturities, ITM/ATM/OTM).
    - Stress test grid for huge sigma and long maturities; ensure stability and manageable runtime.

    ### Future Enhancements
    - Early-exercise (American) adjustment via projected SOR.
    - Local/stochastic volatility (Dupire, Heston) with operator splitting.
    - Sensitivity-based recommendation scoring (risk-adjusted ROI, probability of profit estimates).


