"""
ZenBuy Impulse Risk Scoring (IRS) Engine - First Principles Implementation
Mathematical model based on behavioral economics:
- Taxonomy Score: Luxury expenditure fraction above functional category baseline.
- Financial Salience: Linear labor hours commitment normalized to 16h horizon (2 workdays = 100).
- Wage-Dependent Dynamic Weights: Prioritizes intrinsic necessity/labor as wage decreases.
"""

from typing import Dict, Any, Tuple


def calculate_taxonomy_score(price: float, baseline_price: float, is_hedonic_fad: bool = False) -> int:
    """
    Computes Taxonomy Score (0-100) based on luxury markup over commodity baseline.
    If item has no functional substitute (pure fad/novelty), score is 85-100.
    If price <= baseline_price, luxury markup is 0% -> score is 0.
    """
    if is_hedonic_fad or baseline_price <= 0:
        return 95

    if price <= baseline_price:
        return 0

    # LuxuryFraction: portion of money spent purely on luxury above functional utility
    luxury_fraction = 1.0 - (baseline_price / price)
    return round(min(100.0, max(0.0, luxury_fraction * 100.0)))


def calculate_financial_score(price: float, wage: float, is_bnpl_active: bool = False, horizon_hours: float = 12.0) -> int:
    """
    Computes Financial Salience (0-100) as a direct function of labor hours.
    horizon_hours: Benchmark for 100% financial strain (default: 12 hours = 1.5 full workdays).
    """
    effective_wage = wage if wage > 0 else 30.0
    labor_hours = price / effective_wage

    # Linear normalization against 12-hour labor horizon (1.5 workdays)
    score = (labor_hours / horizon_hours) * 100.0

    if is_bnpl_active:
        score += 15.0  # Installment trap hazard

    return round(min(100.0, max(0.0, score)))


def calculate_circadian_score(hour: int) -> int:
    """Circadian cognitive depletion curve."""
    if hour in [23, 0, 1, 2, 3, 4]:
        return 100  # Peak depletion / late night
    if hour in [21, 22, 5]:
        return 60   # Evening fatigue
    if hour in [18, 19, 20]:
        return 20   # Post-work transition
    return 0        # Daytime baseline


def calculate_velocity_score(velocity: Dict[str, Any]) -> int:
    """Browsing impulsivity velocity score."""
    score = 50.0
    if velocity.get("isSocialReferrer"):
        score += 25.0
    if velocity.get("isDirectSearch"):
        score -= 25.0

    dwell = velocity.get("dwellTimeSeconds", 60)
    if dwell < 30:
        score += 25.0
    elif dwell > 180:
        score -= 25.0

    return round(min(100.0, max(0.0, score)))


def calculate_dark_pattern_score(dark_patterns: Dict[str, Any]) -> int:
    """Aggregates psychological pressure tactics detected on page."""
    if not dark_patterns:
        return 0
    score = 0.0
    if dark_patterns.get("deceptiveUrgency"):
        score += 40.0
    if dark_patterns.get("fabricatedSocialProof"):
        score += 30.0
    if dark_patterns.get("lowStockAmbiguity"):
        score += 30.0
    if dark_patterns.get("preselection"):
        score += 25.0
    return round(min(100.0, score))


def get_dynamic_weights(wage: float) -> Dict[str, float]:
    """
    Returns normalized weights based on user hourly wage.
    The lower the wage, the more weight given to Taxonomy and Financial Salience.
    Taxonomy has the highest weight because utility/luxury is the core purchase criterion.
    """
    if wage <= 20.0:
        # Low wage: Intrinsic utility and wage preservation dominate (85% intrinsic)
        return {"taxonomy": 0.55, "financial": 0.30, "velocity": 0.05, "circadian": 0.05, "darkPattern": 0.05}
    elif wage <= 45.0:
        # Standard wage ($21-$45/h, e.g. $30/h): Intrinsic product signals dominate (80% intrinsic)
        return {"taxonomy": 0.50, "financial": 0.30, "velocity": 0.10, "circadian": 0.05, "darkPattern": 0.05}
    elif wage <= 80.0:
        # Upper-middle wage ($46-$80/h): 70% intrinsic, 30% contextual
        return {"taxonomy": 0.45, "financial": 0.25, "velocity": 0.12, "circadian": 0.09, "darkPattern": 0.09}
    else:
        # High wage (> $80/h): 60% intrinsic, 40% contextual
        return {"taxonomy": 0.40, "financial": 0.20, "velocity": 0.15, "circadian": 0.15, "darkPattern": 0.10}


def evaluate_irs(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main evaluation pipeline.
    Pure linear combination of normalized first-principles scores.
    """
    price = float(item.get("price", 0.0))
    baseline_price = float(item.get("categoryBaselinePrice", 0.0))
    wage = float(item.get("hourlyWage", 30.0))
    is_bnpl = bool(item.get("isBnplActive", False))
    hour = int(item.get("localHour", 14))
    velocity = item.get("velocity") or {}
    dark_patterns = item.get("darkPatterns") or {}

    # Compute subscores
    s_taxonomy = calculate_taxonomy_score(price, baseline_price, item.get("isHedonicFad", False))
    s_financial = calculate_financial_score(price, wage, is_bnpl)
    s_velocity = calculate_velocity_score(velocity)
    s_circadian = calculate_circadian_score(hour)
    s_dark = calculate_dark_pattern_score(dark_patterns)

    # Dynamic weights
    weights = get_dynamic_weights(wage)

    # Clean linear weighted sum (Sum(w_i * S_i))
    raw_score = (
        (weights["taxonomy"] * s_taxonomy) +
        (weights["financial"] * s_financial) +
        (weights["velocity"] * s_velocity) +
        (weights["circadian"] * s_circadian) +
        (weights["darkPattern"] * s_dark)
    )

    irs_score = round(min(100.0, max(0.0, raw_score)))

    tier = "TIER_0"
    if irs_score >= 65:
        tier = "TIER_2"
    elif irs_score >= 30:
        tier = "TIER_1"

    return {
        "score": irs_score,
        "tier": tier,
        "weights": weights,
        "subScores": {
            "taxonomy": s_taxonomy,
            "financial": s_financial,
            "velocity": s_velocity,
            "circadian": s_circadian,
            "darkPattern": s_dark
        }
    }
