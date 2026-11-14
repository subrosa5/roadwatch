"""Regression: one cold DNN call must not decide sustained streaming capacity."""
from pathlib import Path
import runpy
import sys
import unittest
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'collector'))
profile=runpy.run_path(str(ROOT/'collector/botkeep/main.py'),run_name='preflight_tests')['tracking_profile']

class AdmissionTests(unittest.TestCase):
    def test_cold_spike_is_reported_but_does_not_reject_fast_warm_detector(self):
        result=profile([364,180,70,72,71,70,69],[1,1,1],52,5,219)
        self.assertTrue(result['resource_gate_passed'])
        self.assertEqual(result['vehicle_detection_interval_seconds'],.5)
        self.assertEqual(result['vehicle_detector_warm_samples'],5)
    def test_slower_detector_gets_bounded_cadence_without_reducing_tracking_fps(self):
        result=profile([400,250,200,202,198],[2,2,2],50,5,220)
        self.assertTrue(result['resource_gate_passed'])
        self.assertGreater(result['vehicle_detection_interval_seconds'],.5)
        self.assertLessEqual(result['vehicle_detection_interval_seconds'],1)
        self.assertLessEqual(result['estimated_inference_cpu_per_second'],.35)
    def test_sustained_overload_is_rejected_instead_of_removing_gate(self):
        result=profile([500,450,400,410,390],[2,2],50,5,220)
        self.assertFalse(result['resource_gate_passed'])
        self.assertIn('sustained_inference_budget_exceeded',result['failure_reasons'])
    def test_memory_budget_still_fails_closed(self):
        self.assertFalse(profile([30]*6,[1]*10,50,5,400)['resource_gate_passed'])

if __name__=='__main__':unittest.main(verbosity=2)
