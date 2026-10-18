"""
Configuration management for the Speech-to-Text Processor
All parameters are adjustable here
"""

import json
import os
from pathlib import Path

CONFIG_FILE = "config.json"

DEFAULT_CONFIG = {
    "input_folder": "Transcribed Text Files",
    "transcriber_input_folder": "Input Audio/Channel 1",
    "transcriber_input_folder_2": "Input Audio/Channel 2",
    "transcriber_mirror_source_folder": "",
    "transcriber_mirror_source_folder_2": "",
    "transcriber_mirror_auto_start": True,
    "transcriber_output_folder": "Transcribed Text Files",
    "transcriber_auto_start_on_launch": True,
    "transcriber_use_date_range": False,
    "transcriber_date_from": "",
    "transcriber_date_to": "",
    "processed_show_no_speech_entries": False,
    "scan_interval": 2,  # seconds
    "database_path": "transcriptions.db",
    "raw_table": "raw_transcriptions",
    "processed_table": "processed_transcriptions",
    "file_pattern": "*.txt",
    "raw_file_min_age_seconds": 0.5,
    "auto_delete_raw": False,  # Keep source files unless explicitly enabled
    "gui_window_width": 1000,
    "gui_window_height": 700,
    "gui_font_size": 10,
    "debug_mode": False,
    "ai_model_name": "",
    "ai_model_path": "models",
    "ai_device": "gpu",
    "ai_context_size": 8192,
    "ai_merge_gap_minutes": 5,
    "ai_max_tokens": 512,
    "ai_summary_max_tokens": 768,
    "ai_report_row_max_tokens": 256,
    "ai_temperature": 0.3,
    "ai_vision_url": "http://127.0.0.1:11434",
    "ai_vision_model": "qwen2.5vl:3b",
    "ai_vision_max_tokens": 512,
    "ai_rag_top_k": 8,
    "ai_rag_max_logs": 200,
    "prevent_sleep_while_transcribing": True,
    "transcriber_scan_interval_sec": 1.0,
    "transcriber_unchanged_dir_rescan_sec": 2.0,
    "transcriber_idle_backoff_max_sec": 2.0,
    "transcriber_max_files_per_loop": 2,
    "transcriber_max_new_files_per_scan": 4,
    "transcriber_full_sweep_interval_scans": 6,
    "transcriber_fast_folder_rescan_sec": 0.5,
    "transcriber_slow_folder_rescan_sec": 30.0,
    "transcriber_folder_scan_timeout_sec": 2.0,
    "transcriber_pad_front_sec": 2.0,
    "transcriber_pad_end_sec": 2.0,
    "transcriber_mirror_scan_interval_sec": 0.5,
    "transcriber_mirror_stable_checks_required": 2,
    "transcriber_archive_audio_async": True,
    "transcriber_file_stable_timeout_sec": 15.0,
    "transcriber_file_stable_check_interval_sec": 0.4,
    "transcriber_file_stable_checks_required": 4,
    "transcriber_file_min_age_seconds": 1.0,
    "transcriber_strict_wav_ready_check": False,
    "transcriber_fast_wav_header_ready_check": True,
    "transcriber_immediate_start_on_ready": True,
    "transcriber_no_speech_threshold": 0.85,
    "transcriber_log_prob_threshold": -0.3,
    "transcriber_compression_ratio_threshold": 1.15,
    "transcriber_segment_no_speech_prob_max": 0.65,
    "transcriber_segment_avg_logprob_min": -0.6,
    "transcriber_segment_min_duration_sec": 0.35,
    "transcriber_use_custom_prompt": True,
    "transcriber_apply_code_name_map": True,
    "transcriber_use_phonetic_prompt_correction": True,
    "transcriber_perf_logging": False,
    "transcriber_literal_mode": False,
    "transcriber_transcribe_by_words": False,
    "transcriber_literal_allow_code_name_map": True,
    "transcriber_best_of": 1,
    "transcriber_condition_on_previous_text": False,
    "phone_router_silence_rms_threshold": 450,
    "phone_router_end_silence_seconds": 0.45,
    "phone_router_low_latency_mode": True,
    "phone_router_device_1": "",
    "phone_router_device_2": "",
    "phone_router_channel_1": "Left",
    "phone_router_channel_2": "Right",
    "transcriber_gpu_keep_warm": True,
    "transcriber_gpu_keep_warm_interval_sec": 4.0,
}


class Config:
    def __init__(self):
        self.config = self.load_config()
    
    def load_config(self):
        """Load configuration from file or create default"""
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    config = json.load(f)
                # Merge with defaults to ensure all keys exist
                merged = DEFAULT_CONFIG.copy()
                merged.update(config)
                return merged
            except Exception as e:
                print(f"Error loading config: {e}. Using defaults.")
                return DEFAULT_CONFIG.copy()
        else:
            self.save_config(DEFAULT_CONFIG)
            return DEFAULT_CONFIG.copy()
    
    def save_config(self, config=None):
        """Save configuration to file"""
        if config is None:
            config = self.config
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(config, f, indent=4)
            print(f"Configuration saved to {CONFIG_FILE}")
        except Exception as e:
            print(f"Error saving config: {e}")
    
    def get(self, key, default=None):
        """Get a configuration value"""
        return self.config.get(key, default)
    
    def set(self, key, value):
        """Set a configuration value"""
        self.config[key] = value
        self.save_config()
    
    def get_all(self):
        """Get all configuration"""
        return self.config.copy()


# Global config instance
config = Config()
