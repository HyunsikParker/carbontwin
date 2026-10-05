"""Unit tests for the screening and verification helpers (python3 -m unittest pipeline/test_pipeline.py)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from screen import capacities, clean, jaccard, screen_score  # noqa: E402
from verify import grounded  # noqa: E402


class ScreenHelpers(unittest.TestCase):
    def test_capacity_units_are_normalised_to_mw(self):
        self.assertEqual(capacities("19.2 MWp Solar Power Project"), {19.2})
        self.assertEqual(capacities("500 kW rooftop solar"), {0.5})
        self.assertEqual(capacities("Wind farm"), set())

    def test_generic_words_are_removed_before_matching(self):
        self.assertEqual(clean("Wind Power Project in Karnataka, India"), "wind karnataka")

    def test_jaccard(self):
        self.assertEqual(jaccard("azure power", "azure power india"), 2 / 3)
        self.assertEqual(jaccard("", "x"), 0.0)

    def test_capacity_conflict_lowers_the_pre_score(self):
        base = {"name_sim": 0.95, "dev_sim": 0.5, "loc_sim": 0.5, "same_type": True, "same_scope": True, "capacity_conflict": False}
        conflict = dict(base, capacity_conflict=True)
        self.assertGreater(screen_score(base), screen_score(conflict) + 0.3)


class Grounding(unittest.TestCase):
    record = "- Developer: Azure Power India Pvt ltd\n- Country / State / Site: India / None / None\n- Methodology: ACM0002"

    def test_value_present_in_record(self):
        self.assertTrue(grounded("Azure Power India Pvt ltd", self.record))
        self.assertTrue(grounded("ACM0002", self.record))

    def test_value_absent_from_record_is_dropped(self):
        self.assertFalse(grounded("330 MW solar in Rajasthan", self.record))
        self.assertFalse(grounded("", self.record))


if __name__ == "__main__":
    unittest.main()
