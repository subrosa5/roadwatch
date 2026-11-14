"""Regression: one cold DNN call must not decide sustained streaming capacity."""
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'collector'))
entry=runpy.run_path(str(ROOT/'collector/botkeep/main.py'),run_name='preflight_tests')
profile=entry['tracking_profile']
admit=entry['admit_tracking_stream']

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
    def test_actual_hostrix_overload_selects_measured_three_fps_without_relaxing_budget(self):
        result=profile([1021,600]+[286.29095]*8,[16.09455]*8,67.413,5,208.723)
        self.assertTrue(result['resource_gate_passed'])
        self.assertEqual(result['requested_fps'],5)
        self.assertEqual(result['selected_fps'],3)
        self.assertTrue(result['fps_adapted'])
        self.assertLessEqual(result['estimated_inference_cpu_per_second'],.35)
        self.assertLessEqual(result['vehicle_detection_interval_seconds'],1)
    def test_adaptation_never_drops_below_two_fps_or_one_detector_call_per_second(self):
        result=profile([500,450]+[340]*8,[16]*8,67,4,208)
        self.assertFalse(result['resource_gate_passed'])
        self.assertEqual(result['selected_fps'],2)
        self.assertEqual(result['vehicle_detection_interval_seconds'],1)
    def test_real_throughput_retries_lower_cadence_and_saves_actual_selected_fps(self):
        seen=[]
        def load(config,model,**kwargs):
            seen.append(config['fps'])
            return {'throughput_gate_passed':config['fps']==3,'frames':50,'rss_upper_estimate_mib':300,'cgroup_memory_peak_mib':200}
        config={'fps':4}
        with patch.dict(admit.__globals__,tracking_load=load),redirect_stdout(StringIO()):result=admit(config,{})
        self.assertTrue(result['throughput_gate_passed']);self.assertEqual(seen,[4,3]);self.assertEqual(config['fps'],3)
    def test_real_admission_does_not_lower_memory_safety_or_retry_forever(self):
        for memory,frames,expected in [(400,50,[4]),(300,50,[4,3,2]),(300,0,[4])]:
            seen=[]
            def load(config,model,**kwargs):
                seen.append(config['fps'])
                return {'throughput_gate_passed':False,'frames':frames,'rss_upper_estimate_mib':memory,'cgroup_memory_peak_mib':200}
            with patch.dict(admit.__globals__,tracking_load=load),redirect_stdout(StringIO()):
                with self.assertRaisesRegex(RuntimeError,'throughput'):admit({'fps':4},{})
            self.assertEqual(seen,expected)

if __name__=='__main__':unittest.main(verbosity=2)
