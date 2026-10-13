import unittest
from modal_runner import choose, comparable_suite, model_cost, model_settings, summarize, trial_schedule

SUITE = {"failurePenaltySeconds": 900, "costWeightSecondsPerDollar": 30}


def result(task="a", solved=True, seconds=60, cost=0.1):
    return {"instance_id": task, "repeat": 0, "resolved": solved, "status": "completed",
            "metrics": {"elapsedSeconds": seconds,
                        "executive": {"costUsd": cost}, "system1": {"costUsd": 0.01, "errors": []}}}


class SelectionTests(unittest.TestCase):
    def test_executive_override_does_not_change_perception_model(self):
        settings = model_settings({"executiveModel": "openai/gpt-6-astra", "reasoning": "low"})
        self.assertEqual(settings, {"executive": "openai/gpt-6-astra", "system1": "typesafe-ai/jev", "reasoning": "low"})

    def test_default_model_fields_compare_with_older_suites(self):
        self.assertEqual(comparable_suite(SUITE), comparable_suite({**SUITE, "executiveModel": "openai/gpt-6-luna"}))
        self.assertNotEqual(comparable_suite(SUITE), comparable_suite({**SUITE, "executiveModel": "openai/gpt-6-astra"}))

    def test_interleaving_alternates_order_and_preserves_paired_tasks(self):
        schedule = list(trial_schedule(["control", "candidate"], ["a", "b"], 3, True))
        self.assertEqual(schedule[:2], [("control", 0, "a"), ("candidate", 0, "a")])
        self.assertEqual(schedule[4:6], [("candidate", 1, "a"), ("control", 1, "a")])
        self.assertEqual([(repeat, task) for profile, repeat, task in schedule if profile == "control"],
                         [(repeat, task) for profile, repeat, task in schedule if profile == "candidate"])

    def test_costs_include_failed_attempts_and_both_lanes(self):
        report = summarize([result(), result(task="b", solved=False)], SUITE)
        self.assertAlmostEqual(report["modelCostUsd"], 0.22)
        self.assertAlmostEqual(report["costPerSolveUsd"], 0.22)

    def test_unknown_cost_is_not_zero(self):
        row = result(cost=None)
        self.assertIsNone(model_cost(row))
        self.assertIsNone(summarize([row], SUITE)["modelCostUsd"])

    def test_faster_regression_is_rejected(self):
        self.assertFalse(choose([result()], [result(solved=False, seconds=1, cost=0)], SUITE)[0])

    def test_accepts_paired_improvement(self):
        self.assertTrue(choose([result(seconds=100)], [result(seconds=60)], SUITE)[0])
        self.assertFalse(choose([result(seconds=100)], [result(seconds=99)], SUITE)[0])

    def test_same_failures_do_not_hide_savings_on_solved_tasks(self):
        old = [result(seconds=100), result(task="hard", solved=False)]
        new = [result(seconds=60), result(task="hard", solved=False)]
        self.assertTrue(choose(old, new, SUITE)[0])

    def test_unpaired_and_broken_inference_are_rejected(self):
        self.assertFalse(choose([result()], [result(task="b")], SUITE)[0])
        candidate = result(seconds=1)
        candidate["metrics"]["system1"]["errors"] = ["model offline"]
        self.assertFalse(choose([result()], [candidate], SUITE)[0])

    def test_cost_coverage_cannot_disappear(self):
        self.assertFalse(choose([result()], [result(seconds=1, cost=None)], SUITE)[0])


if __name__ == "__main__":
    unittest.main()
