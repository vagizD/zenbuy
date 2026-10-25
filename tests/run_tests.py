#!/usr/bin/env python3
"""
ZenBuy IRS Regression & Validation Test Suite
Loads test catalog, runs the IRS Engine, asserts scores against expected ranges,
and outputs a diagnostic report.
"""

import json
import os
import sys
from irs_engine import evaluate_irs

def main():
    catalog_path = os.path.join(os.path.dirname(__file__), "test_catalog.json")
    if not os.path.exists(catalog_path):
        print(f"Error: {catalog_path} not found.")
        sys.exit(1)

    with open(catalog_path, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    print("=" * 110)
    print(" ZENBUY IMPULSE RISK SCORE (IRS) BENCHMARK & REGRESSION TEST SUITE")
    print("=" * 110)
    header = f"{'Test Case':30} | {'Price':7} | {'Wage':6} | {'Tax':4} | {'Fin':4} | {'Vel':4} | {'Circ':4} | {'Dark':4} | {'IRS':4} | {'Target':9} | {'Status':6}"
    print(header)
    print("-" * 110)

    passed_count = 0
    failed_count = 0

    for item in catalog:
        result = evaluate_irs(item)
        score = result["score"]
        subs = result["subScores"]
        weights = result["weights"]
        target_range = item["expectedIrsRange"]

        passed = target_range[0] <= score <= target_range[1]
        status = "PASS" if passed else "FAIL"

        if passed:
            passed_count += 1
        else:
            failed_count += 1

        title_short = (item["title"][:27] + "...") if len(item["title"]) > 30 else item["title"]
        price_str = f"${item['price']:.2f}"
        wage_str = f"${item['hourlyWage']:.0f}/h"
        target_str = f"[{target_range[0]}-{target_range[1]}]"

        row = (
            f"{title_short:30} | "
            f"{price_str:>7} | "
            f"{wage_str:>6} | "
            f"{subs['taxonomy']:>4} | "
            f"{subs['financial']:>4} | "
            f"{subs['velocity']:>4} | "
            f"{subs['circadian']:>4} | "
            f"{subs['darkPattern']:>4} | "
            f"{score:>4} | "
            f"{target_str:>9} | "
            f"{status:>6}"
        )
        print(row)

    print("=" * 110)
    print(f"Total Tests: {len(catalog)} | Passed: {passed_count} | Failed: {failed_count}")
    print("=" * 110)

    if failed_count > 0:
        print("\n[!] Regression failures detected. Review target ranges or engine parameters.")
        sys.exit(1)
    else:
        print("\n[✓] All benchmark test cases successfully evaluated within target IRS bounds!")
        sys.exit(0)

if __name__ == "__main__":
    main()
