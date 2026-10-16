"""Regression cases for evidence that must not become a confirmed finding."""

from contextlib import redirect_stdout
import gzip
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import report
from verify import grounded


class GroundingIntegrity(unittest.TestCase):
    def test_added_capacity_is_not_grounded_by_matching_company_words(self):
        self.assertFalse(grounded("Azure Power India Pvt Ltd 999 MW", "Developer: Azure Power India Pvt Ltd"))

    def test_methodology_prefix_is_not_the_same_code(self):
        self.assertFalse(grounded("ACM0002", "Methodology: ACM00020"))

    def test_source_phrase_tolerates_case_and_punctuation(self):
        self.assertTrue(grounded("AZURE POWER INDIA PVT LTD", "Developer: Azure Power India Pvt. Ltd."))

    def test_reason_number_must_match_a_complete_number(self):
        reason = "Both projects have 2 MW capacity."
        kept, from_model = report.checked_reason(reason, [], {"year": 2020}, {"year": 2020})
        self.assertFalse(from_model)
        self.assertNotEqual(kept, reason)


class ReportIntegrity(unittest.TestCase):
    @staticmethod
    def project(project_id, registry):
        return {
            "Project ID": project_id, "Voluntary Registry": registry,
            "Project Name": "Azure Solar Project", "Project Developer": "Azure Power India Pvt Ltd",
            "Country": "India", "State": None, "Project Site Location": None,
            "Scope": "Energy", "Type": "Solar", "Methodology / Protocol": "ACM00020",
            "Voluntary Status": "Registered", "Total Credits Issued": 100,
            "Total Credits Retired": 0, "issued_by_vintage": [0] * 23 + [100] + [0] * 7,
        }

    def build_report(self, verdict="yes", facts=None):
        if facts is None:
            facts = [
                {"field": "Country", "value_a": "India", "value_b": "India"},
                {"field": "Developer", "value_a": "Azure Power India Pvt Ltd", "value_b": "Azure Power India Pvt Ltd"},
            ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, output = root / "data", root / "out"
            data.mkdir()
            with gzip.open(data / "projects.json.gz", "wt") as stream:
                json.dump([self.project("A", "Gold Standard"), self.project("B", "Verra")], stream)
            candidate = {
                "a": "A", "b": "B", "registry_a": "Gold Standard", "registry_b": "Verra",
                "country": "India", "screen_score": 0.9, "name_sim": 1.0,
                "overlap_vintages": [2019], "overlap_volume": 100,
            }
            (data / "candidates.json").write_text(json.dumps({"summary": {}, "candidates": [candidate]}))
            (data / "verdicts.jsonl").write_text(json.dumps({"a": "A", "b": "B", "same_asset": verdict}) + "\n")
            cached = {
                "a": "A", "b": "B", "first_pass": "yes", "second_pass": "yes",
                "grounded_facts": facts, "differences": [], "reason": "Shared source details.",
                "dropped_facts": 0, "confirmed": True,
            }
            (data / "evidence.jsonl").write_text(json.dumps(cached) + "\n")
            with patch.object(report, "DATA", data), patch.object(report, "OUT", output), redirect_stdout(io.StringIO()):
                report.main()
            return json.loads((output / "findings.json").read_text())

    def test_current_no_verdict_overrides_old_confirmed_cache(self):
        self.assertEqual(self.build_report(verdict="no")["findings"], [])

    def test_current_source_rejects_an_unsupported_cached_fact(self):
        facts = [
            {"field": "Country", "value_a": "India", "value_b": "India"},
            {"field": "Developer", "value_a": "Azure Power India Pvt Ltd 999 MW", "value_b": "Azure Power India Pvt Ltd 999 MW"},
        ]
        self.assertEqual(self.build_report(facts=facts)["findings"], [])

    def test_repeating_one_fact_does_not_meet_the_two_fact_requirement(self):
        fact = {"field": "Country", "value_a": "India", "value_b": "India"}
        self.assertEqual(self.build_report(facts=[fact, dict(fact)])["findings"], [])

    def test_two_current_grounded_facts_keep_a_confirmed_finding(self):
        result = self.build_report()
        self.assertEqual(len(result["findings"]), 1)
        self.assertEqual(result["summary"]["same_asset_with_overlap"], 1)


if __name__ == "__main__":
    unittest.main()
