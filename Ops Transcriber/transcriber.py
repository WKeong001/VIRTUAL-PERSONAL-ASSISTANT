"""
Audio Transcriber using Faster-Whisper
High accuracy offline speech recognition for walkie-talkie conversations
"""

import os
import re
import sys
import threading
import difflib
from pathlib import Path
from typing import Callable, Optional, List, Tuple, Dict
from datetime import datetime

# Optionally use a local faster_whisper checkout if present; otherwise the
# installed faster-whisper package is used.
LOCAL_FASTER_WHISPER_PATH = os.environ.get("FASTER_WHISPER_LOCAL_PATH", "")
if os.path.isdir(LOCAL_FASTER_WHISPER_PATH) and LOCAL_FASTER_WHISPER_PATH not in sys.path:
    sys.path.insert(0, LOCAL_FASTER_WHISPER_PATH)


def _enable_cuda_dll_search() -> None:
    """Make CUDA runtime DLLs (from the pip nvidia-* packages) discoverable.

    On Windows, CTranslate2/faster-whisper cannot find the cuBLAS/cuDNN DLLs
    that ship inside the ``nvidia-*-cu12`` wheels unless their ``bin`` folders
    are registered as DLL search directories. This is a no-op on other OSes or
    when the packages are not installed.
    """
    if os.name != "nt":
        return
    try:
        import importlib.util

        for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
            try:
                spec = importlib.util.find_spec(pkg)
            except (ImportError, ValueError):
                spec = None
            if not spec or not spec.submodule_search_locations:
                continue
            for base in spec.submodule_search_locations:
                bin_dir = os.path.join(base, "bin")
                if os.path.isdir(bin_dir):
                    try:
                        os.add_dll_directory(bin_dir)
                    except OSError:
                        pass
                    # CTranslate2 loads cuBLAS lazily via LoadLibrary, which
                    # ignores add_dll_directory and only searches PATH.
                    path_entries = os.environ.get("PATH", "").split(os.pathsep)
                    if bin_dir not in path_entries:
                        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        # Never let DLL-path setup break model loading; CPU fallback remains.
        pass


# Available Whisper models
WHISPER_MODELS = {
    "tiny": "Fastest, basic accuracy (~75MB)",
    "base": "Fast, good accuracy (~140MB)",
    "small": "Better accuracy, slower (~460MB)",
    "medium": "High accuracy, slow (~1.5GB)",
    "large-v2": "Very high accuracy (~3GB)",
    "large-v3": "Highest accuracy (~3GB)",
    "large-v3-turbo": "Fast + high accuracy (~1.6GB) - Recommended",
    "distil-large-v3": "Distilled, fast + good accuracy (~1.5GB)",
}

# Model name mapping for non-standard names that need full HuggingFace paths
MODEL_NAME_MAPPING = {
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
}

DEFAULT_MODEL = "large-v3-turbo"

# Initial prompt helps Whisper recognize domain-specific terms
# Edit this in config.json under "transcription_prompt"
DEFAULT_PROMPT = """Radio communication transcript. Call signs and code names: 
Roger, Copy, Over, Out, Bravo, Charlie, Delta, Alpha, Tango, Oscar, Sierra.
Test call, radio check, acknowledge, affirmative, negative.
"""

# Code name translations - maps what STT might hear to the actual code name
# Format: "heard_word": "correct_code_name"
# Configure in config.json under "code_names" section
CODE_NAME_TRANSLATIONS: Dict[str, str] = {}

# Cached compiled regex and metadata for optimized code name replacement
_cached_code_name_regex = None
_cached_code_name_map = None
_cached_code_name_lower_map = None
_cached_code_name_pattern_hash = None
# Cached compact-token lookup (built once per translations dict, not per file)
_cached_compact_map = None
_cached_compact_max_words = 1
_cached_prompt_terms_raw = None
_cached_prompt_terms = []
_PHONETIC_CANDIDATE_CACHE: Dict[str, object] = {
    "signature": None,
    "entries": [],
    "soundex_index": {},
}


def _normalize_phrase(value: str) -> str:
    """Normalize phrase for fuzzy/phonetic matching."""
    cleaned = re.sub(r"[^a-z0-9\s]", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _soundex_token(token: str) -> str:
    """Simple Soundex-like code for a token."""
    token = re.sub(r"[^a-z]", "", str(token or "").lower())
    if not token:
        return ""

    mapping = {
        "b": "1", "f": "1", "p": "1", "v": "1",
        "c": "2", "g": "2", "j": "2", "k": "2", "q": "2", "s": "2", "x": "2", "z": "2",
        "d": "3", "t": "3",
        "l": "4",
        "m": "5", "n": "5",
        "r": "6",
    }

    first = token[0].upper()
    encoded_digits = []
    last_digit = ""
    for char in token[1:]:
        digit = mapping.get(char, "")
        if digit and digit != last_digit:
            encoded_digits.append(digit)
        last_digit = digit

    code = first + "".join(encoded_digits)
    return (code + "000")[:4]


def _soundex_phrase(phrase: str) -> str:
    """Soundex signature for a multi-word phrase."""
    tokens = [tok for tok in re.findall(r"[a-z]+", phrase.lower()) if tok]
    if not tokens:
        return ""
    return " ".join(_soundex_token(tok) for tok in tokens)


def _get_prompt_terms_from_config() -> List[str]:
    """Parse comma-separated prompt terms from config with caching."""
    global _cached_prompt_terms_raw, _cached_prompt_terms
    try:
        from config import config
        prompt_raw = str(config.get("transcription_prompt", "") or "")
    except Exception:
        return []

    if _cached_prompt_terms_raw == prompt_raw:
        return list(_cached_prompt_terms)

    parsed = [term.strip() for term in prompt_raw.split(",") if term.strip()]
    _cached_prompt_terms_raw = prompt_raw
    _cached_prompt_terms = parsed
    return list(parsed)


def _build_phonetic_candidate_index(translations: Dict[str, str]):
    """Build and cache canonical candidates derived from prompt terms + code_name values."""
    try:
        from config import config
        max_terms = int(config.get("transcriber_phonetic_max_terms", 4000) or 4000)
    except Exception:
        max_terms = 4000
    max_terms = max(200, min(10000, max_terms))

    prompt_terms = _get_prompt_terms_from_config()
    canonical_terms = []
    canonical_terms.extend(str(v).strip() for v in (translations or {}).values() if str(v).strip())
    canonical_terms.extend(prompt_terms)

    # Keep cache-key computation lightweight; avoid rebuilding huge tuples/sorts
    # on every transcript while still invalidating when config content changes.
    translations_obj = translations or {}
    signature = (
        id(translations_obj),
        len(translations_obj),
        _cached_prompt_terms_raw,
        len(prompt_terms),
        max_terms,
    )
    if _PHONETIC_CANDIDATE_CACHE.get("signature") == signature:
        return _PHONETIC_CANDIDATE_CACHE.get("entries", []), _PHONETIC_CANDIDATE_CACHE.get("soundex_index", {})

    entries = []
    soundex_index: Dict[str, List[dict]] = {}
    seen_norm = set()

    for term in canonical_terms:
        norm = _normalize_phrase(term)
        if not norm or norm in seen_norm:
            continue
        seen_norm.add(norm)

        words = norm.split()
        if not words:
            continue
        if len(norm.replace(" ", "")) < 4:
            continue

        sx = _soundex_phrase(norm)
        if not sx:
            continue

        entry = {
            "canonical": term,
            "normalized": norm,
            "word_count": len(words),
            "soundex": sx,
        }
        entries.append(entry)
        soundex_index.setdefault(sx, []).append(entry)

        if len(entries) >= max_terms:
            break

    _PHONETIC_CANDIDATE_CACHE["signature"] = signature
    _PHONETIC_CANDIDATE_CACHE["entries"] = entries
    _PHONETIC_CANDIDATE_CACHE["soundex_index"] = soundex_index
    return entries, soundex_index


def _apply_phonetic_prompt_corrections(text: str, translations: Dict[str, str]) -> str:
    """Apply broad phonetic/fuzzy correction against prompt vocabulary."""
    if not text:
        return text

    try:
        from config import config
        enabled = bool(config.get("transcriber_use_phonetic_prompt_correction", True))
        max_ngram = int(config.get("transcriber_phonetic_max_ngram", 3) or 3)
        min_similarity = float(config.get("transcriber_phonetic_min_similarity", 0.82) or 0.82)
    except Exception:
        enabled = True
        max_ngram = 3
        min_similarity = 0.82

    if not enabled:
        return text

    max_ngram = max(1, min(4, max_ngram))
    min_similarity = max(0.70, min(0.95, min_similarity))

    _, soundex_index = _build_phonetic_candidate_index(translations)
    if not soundex_index:
        return text

    word_matches = list(re.finditer(r"\b[A-Za-z][A-Za-z0-9']*\b", text))
    if not word_matches:
        return text

    output_parts = []
    cursor = 0
    i = 0

    while i < len(word_matches):
        best = None
        max_n = min(max_ngram, len(word_matches) - i)

        for n in range(max_n, 0, -1):
            group = word_matches[i:i + n]
            start = group[0].start()
            end = group[-1].end()
            snippet = text[start:end]
            normalized = _normalize_phrase(snippet)

            if not normalized or len(normalized.replace(" ", "")) < 4:
                continue

            sx = _soundex_phrase(normalized)
            if not sx:
                continue

            candidates = soundex_index.get(sx, [])
            if not candidates:
                continue

            local_best = None
            for candidate in candidates:
                if candidate["word_count"] != n:
                    continue
                if normalized == candidate["normalized"]:
                    continue

                score = difflib.SequenceMatcher(None, normalized, candidate["normalized"]).ratio()
                if score < min_similarity:
                    continue
                if local_best is None or score > local_best["score"]:
                    local_best = {
                        "start": start,
                        "end": end,
                        "replace": candidate["canonical"],
                        "score": score,
                        "n": n,
                    }

            if local_best:
                best = local_best
                break

        if best is None:
            i += 1
            continue

        output_parts.append(text[cursor:best["start"]])
        output_parts.append(best["replace"])
        cursor = best["end"]
        i += best["n"]

    output_parts.append(text[cursor:])
    return "".join(output_parts)


def load_code_names_from_config() -> Dict[str, str]:
    """Load code name translations from config.json"""
    try:
        from config import config
        code_names = config.get("code_names", {})
        if isinstance(code_names, dict):
            return code_names
    except Exception:
        pass
    return {}


def _build_cached_code_name_regex(
    translations: Dict[str, str],
) -> Tuple[Optional[re.Pattern], Dict[str, str], Dict[str, str]]:
    """Build and cache a pre-compiled regex for all code name keys.
    
    Returns a single regex with alternation (word1|word2|...|wordN) and the lookup dict.
    This avoids 3000+ individual regex compilations per transcription.
    """
    if not translations:
        return None, {}, {}
    
    # Sort by length descending to match longest keys first (greedy matching)
    sorted_keys = sorted(
        (k for k in translations.keys() if k and isinstance(k, str)),
        key=len,
        reverse=True
    )
    
    if not sorted_keys:
        return None, {}, {}
    
    # Build alternation pattern: \b(key1|key2|...|keyN)\b
    # Escape each key for regex safety
    escaped_keys = [re.escape(k) for k in sorted_keys]
    pattern_str = r"\b(" + "|".join(escaped_keys) + r")\b"
    
    try:
        compiled = re.compile(pattern_str, re.IGNORECASE)
        lower_lookup = {str(k).lower(): str(v) for k, v in translations.items()}
        return compiled, translations, lower_lookup
    except Exception:
        return None, {}, {}


def _get_cached_code_name_regex(
    translations: Dict[str, str],
) -> Tuple[Optional[re.Pattern], Dict[str, str], Dict[str, str]]:
    """Get or build cached code name regex."""
    global _cached_code_name_regex, _cached_code_name_map, _cached_code_name_lower_map, _cached_code_name_pattern_hash
    global _cached_compact_map, _cached_compact_max_words

    # Fast path: config.get("code_names") generally returns the same dict object.
    if translations is _cached_code_name_map and _cached_code_name_regex is not None:
        return _cached_code_name_regex, _cached_code_name_map, (_cached_code_name_lower_map or {})
    
    # Compute hash to detect if translations changed
    current_hash = hash(frozenset(translations.items())) if translations else None
    
    # If hash matches, return cached version
    if _cached_code_name_pattern_hash == current_hash and _cached_code_name_regex is not None:
        return _cached_code_name_regex, _cached_code_name_map, (_cached_code_name_lower_map or {})
    
    # Build new cache
    regex, trans_map, lower_map = _build_cached_code_name_regex(translations)
    _cached_code_name_regex = regex
    _cached_code_name_map = trans_map
    _cached_code_name_lower_map = lower_map
    _cached_code_name_pattern_hash = current_hash
    # Invalidate compact map cache (will rebuild on next access)
    _cached_compact_map = None
    _cached_compact_max_words = 1
    
    return regex, trans_map, lower_map


def _get_cached_compact_map(translations: Dict[str, str]) -> Tuple[Dict[str, str], int]:
    """Build/return cached compact-token lookup map.
    
    Compact map normalizes keys by stripping spaces/punctuation so
    "Ang Mo Kio" can match "Angmokyo". Built once per translations dict
    instead of every transcription file.
    """
    global _cached_compact_map, _cached_compact_max_words
    
    if _cached_compact_map is not None:
        return _cached_compact_map, _cached_compact_max_words
    
    compact_map: Dict[str, str] = {}
    max_words = 1
    for heard_word, code_name in translations.items():
        heard_norm = _normalize_phrase(heard_word)
        if not heard_norm:
            continue
        compact_key = re.sub(r"[^a-z0-9]", "", heard_norm)
        if not compact_key:
            continue
        compact_map.setdefault(compact_key, str(code_name))
        max_words = max(max_words, len(heard_norm.split()))
    
    _cached_compact_map = compact_map
    _cached_compact_max_words = max_words
    return compact_map, max_words


def _apply_contextual_cancel_to_kenzo(text: str, translations: Dict[str, str]) -> str:
    """Safely convert likely callsign mishearing (Cancel -> Kenzo).

    This avoids globally rewriting normal command usage of the word "cancel".
    Rules are intentionally narrow:
    1) Convert repeated callsign-like runs: "Cancel, Cancel" / "Cancel Cancel".
    2) Convert sentence/line-start vocative form: "Cancel, ...".
    3) Convert callsign addressing form: "<callsign> to cancel" / "<callsign> cancel".
    """
    if not text:
        return text

    result = text

    # Rule 1: repeated runs (e.g. "Cancel, Cancel") are likely callsign addressing.
    def _replace_cancel_run(match: re.Match) -> str:
        return re.sub(r"\bcancel\b", "Kenzo", match.group(0), flags=re.IGNORECASE)

    result = re.sub(
        r"\bcancel\b(?:[\s,./-]+\bcancel\b)+",
        _replace_cancel_run,
        result,
        flags=re.IGNORECASE,
    )

    # Rule 2: start-of-line/sentence vocative "Cancel, ..." -> "Kenzo, ...".
    result = re.sub(
        r"(^|[.!?]\s+|\n)cancel(?=\s*,)",
        lambda m: f"{m.group(1)}Kenzo",
        result,
        flags=re.IGNORECASE,
    )

    # Build known one-word code names as a guard for contextual replacement.
    known_callsigns = set()
    for value in (translations or {}).values():
        normalized = _normalize_phrase(str(value))
        if not normalized or " " in normalized:
            continue
        if len(normalized) < 3:
            continue
        known_callsigns.add(normalized)

    # Rule 3a: "<callsign> to cancel" -> "<callsign> to Kenzo"
    def _replace_callsign_to_cancel(match: re.Match) -> str:
        src = match.group("src")
        if _normalize_phrase(src) in known_callsigns:
            return f"{src} to Kenzo"
        return match.group(0)

    result = re.sub(
        r"\b(?P<src>[A-Za-z][A-Za-z0-9'-]{1,24})\s+to\s+cancel\b",
        _replace_callsign_to_cancel,
        result,
        flags=re.IGNORECASE,
    )

    # Rule 3b: "<callsign> cancel" -> "<callsign> Kenzo"
    def _replace_callsign_cancel(match: re.Match) -> str:
        src = match.group("src")
        if _normalize_phrase(src) in known_callsigns:
            return f"{src} Kenzo"
        return match.group(0)

    result = re.sub(
        r"\b(?P<src>[A-Za-z][A-Za-z0-9'-]{1,24})\s+cancel\b",
        _replace_callsign_cancel,
        result,
        flags=re.IGNORECASE,
    )

    return result


def apply_code_name_translations(text: str, translations: Dict[str, str] = None) -> str:
    """Replace words in text using code name translations.
    
    Args:
        text: The transcribed text
        translations: Dictionary of word replacements (loads from config if None)
        
    Returns:
        Text with code names translated
    """
    if translations is None:
        # Always reload from config to get latest changes
        translations = load_code_names_from_config()
    
    if not translations or not text:
        return text
    
    result = text
    
    # Optimized first pass: use single pre-compiled regex with alternation instead of 3000+ individual passes
    cached_regex, trans_map, lower_map = _get_cached_code_name_regex(translations)
    if cached_regex is not None:
        def replacer(match: re.Match) -> str:
            matched_word = match.group(1)
            return lower_map.get(matched_word.lower(), matched_word)
        
        result = cached_regex.sub(replacer, result)

    # Second pass: compact token matching ignores spaces/punctuation differences.
    # Example: key "Angmokyo" can still match text like "Ang mokyo".
    # CACHED: built once per translations dict, not per file.
    compact_map, max_compact_words = _get_cached_compact_map(translations)

    if compact_map and result:
        word_matches = list(re.finditer(r"\b[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?\b", result))
        if word_matches:
            output_parts = []
            cursor = 0
            i = 0
            max_compact_words = max(1, min(6, max_compact_words + 1))

            while i < len(word_matches):
                replacement = None
                max_n = min(max_compact_words, len(word_matches) - i)

                for n in range(max_n, 0, -1):
                    group = word_matches[i:i + n]
                    start = group[0].start()
                    end = group[-1].end()
                    snippet = result[start:end]
                    snippet_compact = re.sub(r"[^a-z0-9]", "", _normalize_phrase(snippet))
                    if not snippet_compact:
                        continue
                    mapped = compact_map.get(snippet_compact)
                    if mapped is None:
                        continue

                    replacement = {
                        "start": start,
                        "end": end,
                        "text": mapped,
                        "n": n,
                    }
                    break

                if replacement is None:
                    i += 1
                    continue

                output_parts.append(result[cursor:replacement["start"]])
                output_parts.append(replacement["text"])
                cursor = replacement["end"]
                i += replacement["n"]

            output_parts.append(result[cursor:])
            result = "".join(output_parts)

    # Broad fallback: phonetic/fuzzy correction against prompt vocabulary.
    # This provides "all terms" behavior without manually listing every typo.
    result = _apply_phonetic_prompt_corrections(result, translations)

    # Safe post-pass for a common callsign mishearing: Cancel -> Kenzo.
    # This is intentionally contextual, not global.
    result = _apply_contextual_cancel_to_kenzo(result, translations)
    
    return result


def _collapse_word_tokens_to_text(word_tokens: List[object]) -> str:
    """Build readable text from per-word tokens returned by faster-whisper."""
    if not word_tokens:
        return ""
    chunks: List[str] = []
    for token in word_tokens:
        token_text = str(getattr(token, "word", "") or "")
        if token_text:
            chunks.append(token_text)
    if not chunks:
        return ""
    return re.sub(r"\s+", " ", "".join(chunks)).strip()


class AudioTranscriber:
    """Transcriber for .wav files using faster-whisper
    Optimized for accurate walkie-talkie transcription
    """
    
    def __init__(self):
        self.model = None
        self.model_name = None
        self.is_running = False
        self.should_stop = False
        self._lock = threading.Lock()
        self._device = "cpu"
        self._compute_type = "int8"
        
    def load_model(self, model_name: str = DEFAULT_MODEL, 
                   progress_callback: Optional[Callable[[str], None]] = None,
                   use_gpu: bool = True) -> bool:
        """Load the whisper model
        
        Args:
            model_name: Name of the model (tiny, base, small, medium, large-v2, large-v3, large-v3-turbo)
            progress_callback: Function to report loading progress
            use_gpu: Whether to try using GPU (CUDA) if available
            
        Returns:
            True if model loaded successfully
        """
        try:
            from faster_whisper import WhisperModel
            
            # Map model name to HuggingFace path if needed
            actual_model_name = MODEL_NAME_MAPPING.get(model_name, model_name)
            
            # Try GPU first if requested
            device = "cpu"
            compute_type = "int8"

            if use_gpu:
                # Register CUDA DLL directories so CTranslate2 can find cuBLAS/cuDNN.
                _enable_cuda_dll_search()
                device = "cuda"
                # int8_float16 is markedly faster than float16 on GPU with
                # negligible accuracy loss; overridable via config.
                from config import config as _cfg
                compute_type = str(_cfg.get("transcriber_gpu_compute_type", "float16") or "float16")
                # torch is optional and only used here for a friendly GPU name;
                # faster-whisper/CTranslate2 uses CUDA directly, not torch.
                try:
                    import torch
                    if torch.cuda.is_available() and progress_callback:
                        progress_callback(
                            f"GPU detected: {torch.cuda.get_device_name(0)}"
                        )
                except Exception:
                    pass

            if device == "cuda":
                try:
                    if progress_callback:
                        progress_callback(f"Loading on GPU with {compute_type}...")
                    self.model = WhisperModel(
                        actual_model_name,
                        device="cuda",
                        compute_type=compute_type
                    )
                    # CUDA libraries (cuBLAS/cuDNN) load lazily, so run a tiny
                    # inference now to trigger a CPU fallback instead of
                    # failing on the first real transcription.
                    import numpy as np
                    test_segments, _ = self.model.transcribe(
                        np.zeros(16000, dtype=np.float32), language="en", beam_size=1
                    )
                    list(test_segments)
                    self._device = "cuda"
                    self._compute_type = compute_type
                    if progress_callback:
                        progress_callback(f"Model {model_name} loaded on GPU")
                    self.model_name = model_name
                    return True
                except Exception as gpu_error:
                    if progress_callback:
                        progress_callback(
                            f"GPU load failed ({gpu_error}); falling back to CPU..."
                        )
                    device = "cpu"

            # CPU path (either requested or a fallback from a failed GPU load)
            cpu_threads = max(4, os.cpu_count() or 4)
            if progress_callback:
                progress_callback(f"Loading on CPU with {cpu_threads} threads...")
            self.model = WhisperModel(
                actual_model_name,
                device="cpu",
                compute_type="int8",
                cpu_threads=cpu_threads
            )
            self._device = "cpu"
            self._compute_type = "int8"
            if progress_callback:
                progress_callback(f"Model {model_name} loaded on CPU")

            self.model_name = model_name
            return True
            
        except ImportError:
            if progress_callback:
                progress_callback("Error: faster-whisper not installed")
            return False
        except Exception as e:
            if progress_callback:
                progress_callback(f"Error loading model: {e}")
            return False
    
    def unload_model(self):
        """Unload the model to free memory"""
        with self._lock:
            self.model = None
            self.model_name = None
            import gc
            gc.collect()
    
    def transcribe_file(self, audio_path: str, 
                        cumulative_offset: float = 0.0,
                        language: str = "en") -> Tuple[str, float, List[dict]]:
        """Transcribe a single audio file
        
        Args:
            audio_path: Path to the .wav file
            cumulative_offset: Time offset to add to timestamps
            language: Language code (default: English)
            
        Returns:
            Tuple of (transcription_text, end_time, segments_list)
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")
        
        # Get custom prompt from config or use neutral mode when disabled
        from config import config
        use_custom_prompt = bool(config.get("transcriber_use_custom_prompt", True))
        custom_prompt = config.get("transcription_prompt", DEFAULT_PROMPT) if use_custom_prompt else ""
        apply_code_name_map = bool(config.get("transcriber_apply_code_name_map", True))
        literal_mode = bool(config.get("transcriber_literal_mode", False))
        transcribe_by_words = bool(config.get("transcriber_transcribe_by_words", False))
        literal_allow_code_name_map = bool(config.get("transcriber_literal_allow_code_name_map", True))

        # Literal mode avoids prompt bias and enforces word-level decoding.
        # Optional explicit code-name remapping remains available for known aliases
        # (for example, IPOH -> Hippo) without fuzzy prompt correction.
        if literal_mode:
            use_custom_prompt = False
            custom_prompt = ""
            transcribe_by_words = True
            apply_code_name_map = apply_code_name_map and literal_allow_code_name_map

        # Very long initial prompts can over-bias decoding and increase hallucinations.
        # Keep only the first N comma-separated terms to retain useful domain hints
        # without forcing unrelated words in low-speech segments.
        if custom_prompt:
            prompt_terms = [term.strip() for term in str(custom_prompt).split(',') if term.strip()]
            max_prompt_terms = int(config.get("transcriber_prompt_max_terms", 80) or 80)
            max_prompt_terms = max(0, min(120, max_prompt_terms))
            if len(prompt_terms) > max_prompt_terms:
                prompt_terms = prompt_terms[:max_prompt_terms]
            custom_prompt = ", ".join(prompt_terms)

        no_speech_threshold = float(config.get("transcriber_no_speech_threshold", 0.72) or 0.72)
        log_prob_threshold = float(config.get("transcriber_log_prob_threshold", -0.3) or -0.3)
        compression_ratio_threshold = float(config.get("transcriber_compression_ratio_threshold", 1.15) or 1.15)
        segment_no_speech_prob_max = float(config.get("transcriber_segment_no_speech_prob_max", 0.6) or 0.6)
        segment_avg_logprob_min = float(config.get("transcriber_segment_avg_logprob_min", -0.65) or -0.65)
        segment_min_duration_sec = float(config.get("transcriber_segment_min_duration_sec", 0.15) or 0.15)
        beam_size = int(config.get("transcriber_beam_size", 6) or 6)
        best_of = int(config.get("transcriber_best_of", 1) or 1)
        condition_on_previous_text = bool(config.get("transcriber_condition_on_previous_text", False))

        # Safety clamps
        no_speech_threshold = min(0.99, max(0.1, no_speech_threshold))
        log_prob_threshold = min(1.0, max(-2.0, log_prob_threshold))
        compression_ratio_threshold = min(3.0, max(1.0, compression_ratio_threshold))
        segment_no_speech_prob_max = min(0.99, max(0.0, segment_no_speech_prob_max))
        segment_min_duration_sec = min(5.0, max(0.0, segment_min_duration_sec))
        beam_size = min(10, max(1, beam_size))
        best_of = min(8, max(1, best_of))

        # Keep strict anti-loop behavior for literal mode.
        if literal_mode:
            condition_on_previous_text = False
        
        # Reusable per-segment filtering so a fallback pass can rerun it with
        # relaxed thresholds without duplicating the anti-hallucination logic.
        def _extract_lines(seg_iter, seg_nsp_max, seg_alp_min, seg_min_dur):
            lines = []
            segment_list = []
            max_end_time = cumulative_offset

            for segment in seg_iter:
                start = cumulative_offset + segment.start
                end = cumulative_offset + segment.end
                text = segment.text.strip()

                if transcribe_by_words:
                    word_text = _collapse_word_tokens_to_text(getattr(segment, "words", None) or [])
                    if word_text:
                        text = word_text

                duration = float(segment.end - segment.start)
                segment_no_speech_prob = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
                segment_avg_logprob = float(getattr(segment, "avg_logprob", 0.0) or 0.0)

                # Additional segment-level anti-hallucination guardrails
                if duration < seg_min_dur:
                    continue
                if segment_no_speech_prob > seg_nsp_max:
                    continue
                if segment_avg_logprob < seg_alp_min:
                    continue

                # Skip empty text
                if not text:
                    continue

                # Skip very short segments (< 2 chars) that are likely noise
                if len(text) < 2:
                    continue

                # Skip common Whisper hallucination patterns (NOT valid radio terms)
                text_lower = text.lower().strip('.,!?')

                # Exact match hallucinations
                hallucination_exact = [
                    "thank you", "thanks for watching", "subscribe",
                    "like and subscribe", "see you next time",
                    "music", "applause", "[music]", "[applause]",
                    "...", "♪", "♫", "bye", "goodbye", "okay",
                    "thank you for watching", "please subscribe",
                    "thanks for listening", "see you later",
                    "the end", "subtitles", "captions",
                    "transcribed by", "translated by",
                    "thanks for watching", "thank you for listening",
                    "please like and subscribe", "don't forget to subscribe",
                    "see you in the next video", "see you next video",
                    "i'll see you", "we'll see you",
                ]
                if text_lower in hallucination_exact:
                    continue

                # Partial match hallucinations - skip if text CONTAINS these
                hallucination_contains = [
                    "thank you for watching",
                    "thanks for watching",
                    "please subscribe",
                    "like and subscribe",
                    "see you next",
                    "transcribed by",
                    "translated by",
                    "subtitles by",
                ]
                if any(pattern in text_lower for pattern in hallucination_contains):
                    continue

                # Skip if text is mostly repeated characters/words (hallucination sign)
                # Strip punctuation first so "ok," and "ok" are treated as the same word
                text_words_clean = re.sub(r'[^\w\s]', '', text_lower).split()
                if len(text_words_clean) > 4:
                    word_set = set(text_words_clean)
                    # All same word, or one word dominates >60% of content
                    if len(word_set) <= 2:
                        continue
                    most_common = max(text_words_clean, key=text_words_clean.count)
                    if text_words_clean.count(most_common) / len(text_words_clean) > 0.6:
                        continue

                # Apply code name translations (optional)
                if apply_code_name_map:
                    text = apply_code_name_translations(text)

                line = f"[{start:.2f}s -> {end:.2f}s] {text}"
                lines.append(line)
                segment_list.append({
                    'start': start,
                    'end': end,
                    'text': text,
                    'avg_logprob': segment_avg_logprob,
                    'no_speech_prob': segment_no_speech_prob
                })
                max_end_time = max(max_end_time, end)

            return lines, segment_list, max_end_time

        # Pass 1: VAD-filtered with the configured thresholds (optimized for radio).
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=beam_size,
            best_of=best_of,
            temperature=[0.0, 0.2],  # Fewer fallback passes = faster; still breaks loops
            condition_on_previous_text=condition_on_previous_text,
            initial_prompt=(custom_prompt or None),  # Domain-specific terms (optional)
            vad_filter=True,                   # Filter silence  
            vad_parameters={
                "min_silence_duration_ms": 200,  # Shorter - don't cut short speech
                "speech_pad_ms": 400,            # More padding to catch short speech
                "threshold": 0.3,                # More sensitive - catch borderline speech
                "min_speech_duration_ms": 200,   # Slightly lower to catch short transmissions
            },
            word_timestamps=transcribe_by_words,
            compression_ratio_threshold=compression_ratio_threshold,
            log_prob_threshold=log_prob_threshold,
            no_speech_threshold=no_speech_threshold,
        )
        lines, segment_list, max_end_time = _extract_lines(
            list(segments),
            segment_no_speech_prob_max,
            segment_avg_logprob_min,
            segment_min_duration_sec,
        )

        # Fallback: VAD can drop substantial speech from long or low-level radio
        # recordings. Retry without VAD when no text was found or the accepted
        # segments cover less than 60% of the source duration.
        source_duration = float(getattr(info, "duration", 0.0) or 0.0)
        covered_duration = max(0.0, max_end_time - cumulative_offset)
        needs_fallback = not lines or (source_duration > 0 and covered_duration < source_duration * 0.6)
        if needs_fallback:
            segments_fb, info = self.model.transcribe(
                audio_path,
                language=language,
                beam_size=max(beam_size, 5),
                best_of=max(best_of, 5),
                temperature=[0.0, 0.2, 0.4, 0.6],
                condition_on_previous_text=False,
                initial_prompt=(custom_prompt or None),
                vad_filter=False,
                word_timestamps=transcribe_by_words,
                compression_ratio_threshold=3.0,
                log_prob_threshold=-2.0,
                no_speech_threshold=0.9,
            )
            fallback_lines, fallback_segment_list, fallback_end_time = _extract_lines(
                list(segments_fb), 0.9, -2.0, 0.0
            )
            if not lines or len(fallback_lines) > len(lines) or fallback_end_time > max_end_time:
                lines, segment_list, max_end_time = (
                    fallback_lines,
                    fallback_segment_list,
                    fallback_end_time,
                )

        transcription = "\n".join(lines)
        return transcription, max_end_time, segment_list
    
    def transcribe_folder(self, 
                          input_folder: str,
                          output_folder: str,
                          progress_callback: Optional[Callable[[str, int, int], None]] = None,
                          file_callback: Optional[Callable[[str, str], None]] = None,
                          language: str = "en",
                          sequential_timestamps: bool = True,
                          auto_combine_min_duration: float = 0) -> bool:
        """Transcribe all .wav files in a folder
        
        Args:
            input_folder: Folder containing .wav files
            output_folder: Folder to save .txt transcriptions
            progress_callback: Function(message, current, total) for progress updates
            file_callback: Function(filename, transcription) called after each file
            language: Language code
            sequential_timestamps: If True, timestamps continue across files
            auto_combine_min_duration: Auto-combine files shorter than this (seconds). Set to 0 to disable.
            
        Returns:
            True if completed successfully
        """
        if self.model is None:
            if progress_callback:
                progress_callback("Error: Model not loaded", 0, 0)
            return False
        
        input_path = Path(input_folder)
        output_path = Path(output_folder)
        
        output_path.mkdir(parents=True, exist_ok=True)
        
        wav_files = sorted(input_path.glob("*.wav"), key=lambda f: f.name)
        
        if not wav_files:
            if progress_callback:
                progress_callback("No .wav files found in input folder", 0, 0)
            return False
        
        # Auto-combine short files if enabled
        # Each item: (filepath, is_temp, display_name, output_stem)
        files_to_process = []
        temp_files = []  # Track temp files for cleanup
        
        def extract_datetime_and_channel_from_filename(filename):
            """Extract date, time, and channel from filename like '2023-03-05 12-29-10 Channel 1.wav'"""
            import re
            stem = Path(filename).stem
            # Match: date, time, and rest (channel info)
            match = re.match(r'^(\d{4}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+(.+?)(?:\s*\(\d+\))?$', stem)
            if match:
                date, time, channel = match.groups()
                return date, time, channel.strip()
            # Fallback: just date and time
            match = re.match(r'^(\d{4}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})', stem)
            if match:
                return match.group(1), match.group(2), None
            return None, None, None
        
        if auto_combine_min_duration > 0:
            from audio_chunker import get_wav_duration, combine_wav_files
            import tempfile
            
            temp_dir = Path(tempfile.gettempdir()) / "transcriber_auto_combine"
            temp_dir.mkdir(parents=True, exist_ok=True)
            
            i = 0
            chunk_counter = 0
            wav_file_list = [str(f) for f in wav_files]
            
            while i < len(wav_file_list):
                filepath = wav_file_list[i]
                duration = get_wav_duration(filepath)
                filename = Path(filepath).name
                
                if duration >= auto_combine_min_duration:
                    # File is long enough, use as-is
                    date, time, channel = extract_datetime_and_channel_from_filename(filename)
                    if date and time:
                        if channel:
                            display_name = f"{date} {time} {channel}"
                            output_stem = f"{date} {time} {channel}"
                        else:
                            display_name = f"{date} {time}"
                            output_stem = f"{date} {time}"
                    else:
                        display_name = filename
                        output_stem = Path(filename).stem
                    files_to_process.append((filepath, False, display_name, output_stem))
                    i += 1
                else:
                    # File is too short, combine with following files sequentially
                    chunk_files = [filepath]
                    total_duration = duration
                    j = i + 1
                    
                    # Keep adding NEXT files until we reach min_duration
                    while j < len(wav_file_list) and total_duration < auto_combine_min_duration:
                        next_file = wav_file_list[j]
                        next_duration = get_wav_duration(next_file)
                        chunk_files.append(next_file)
                        total_duration += next_duration
                        j += 1
                    
                    if len(chunk_files) == 1:
                        # No more files to combine with, use as-is
                        date, time, channel = extract_datetime_and_channel_from_filename(filename)
                        if date and time:
                            if channel:
                                display_name = f"{date} {time} {channel}"
                                output_stem = f"{date} {time} {channel}"
                            else:
                                display_name = f"{date} {time}"
                                output_stem = f"{date} {time}"
                        else:
                            display_name = filename
                            output_stem = Path(filename).stem
                        files_to_process.append((filepath, False, display_name, output_stem))
                        i += 1
                    else:
                        # Combine the files - get date/time/channel from first and last
                        first_date, first_time, first_channel = extract_datetime_and_channel_from_filename(Path(chunk_files[0]).name)
                        last_date, last_time, last_channel = extract_datetime_and_channel_from_filename(Path(chunk_files[-1]).name)
                        
                        chunk_counter += 1
                        combined_name = f"auto_combined_{chunk_counter:03d}.wav"
                        combined_path = str(temp_dir / combined_name)
                        
                        if combine_wav_files(chunk_files, combined_path):
                            # Clean display: "2023-03-05 12-29-10_to_12-30-10 Channel 1"
                            channel_suffix = f" {first_channel}" if first_channel else ""
                            if first_date and first_time and last_time:
                                if first_time == last_time:
                                    display_name = f"{first_date} {first_time}{channel_suffix}"
                                    output_stem = f"{first_date} {first_time}{channel_suffix}"
                                else:
                                    display_name = f"{first_date} {first_time}_to_{last_time}{channel_suffix}"
                                    output_stem = f"{first_date} {first_time}_to_{last_time}{channel_suffix}"
                            else:
                                display_name = f"combined_{chunk_counter}"
                                output_stem = f"combined_{chunk_counter}"
                            
                            files_to_process.append((combined_path, True, display_name, output_stem))
                            temp_files.append(combined_path)
                            if progress_callback:
                                progress_callback(f"Combined: {display_name} ({total_duration:.1f}s)", 0, len(wav_files))
                        else:
                            # Failed to combine, process individually
                            for f in chunk_files:
                                fn = Path(f).name
                                d, t, ch = extract_datetime_and_channel_from_filename(fn)
                                if d and t:
                                    stem = f"{d} {t} {ch}" if ch else f"{d} {t}"
                                    files_to_process.append((f, False, stem, stem))
                                else:
                                    files_to_process.append((f, False, fn, Path(fn).stem))
                        
                        i = j  # Skip all the files we just combined
        else:
            # No auto-combine, process all files individually
            for wav_file in wav_files:
                filename = wav_file.name
                date, time, channel = extract_datetime_and_channel_from_filename(filename)
                if date and time:
                    if channel:
                        display_name = f"{date} {time} {channel}"
                        output_stem = f"{date} {time} {channel}"
                    else:
                        display_name = f"{date} {time}"
                        output_stem = f"{date} {time}"
                else:
                    display_name = filename
                    output_stem = wav_file.stem
                files_to_process.append((str(wav_file), False, display_name, output_stem))
        
        total_files = len(files_to_process)
        self.is_running = True
        self.should_stop = False
        cumulative_time = 0.0
        
        try:
            for idx, (filepath, is_temp, display_name, output_stem) in enumerate(files_to_process):
                if self.should_stop:
                    if progress_callback:
                        progress_callback("Transcription stopped by user", idx, total_files)
                    return False
                
                if progress_callback:
                    progress_callback(f"Transcribing: {display_name}", idx + 1, total_files)
                
                try:
                    offset = cumulative_time if sequential_timestamps else 0.0
                    transcription, end_time, segments = self.transcribe_file(
                        filepath,
                        cumulative_offset=offset,
                        language=language
                    )
                    
                    if sequential_timestamps:
                        cumulative_time = end_time
                    
                    # Save output with clean filename (date + time range)
                    output_file = output_path / f"{output_stem}.txt"
                    
                    with open(output_file, 'w', encoding='utf-8') as f:
                        f.write(transcription)
                    
                    if file_callback:
                        file_callback(display_name, transcription)
                        
                except Exception as e:
                    if progress_callback:
                        progress_callback(f"Error transcribing {display_name}: {e}", idx + 1, total_files)
                    continue
            
            if progress_callback:
                progress_callback(f"Completed: {total_files} items transcribed", total_files, total_files)
            return True
            
        finally:
            self.is_running = False
            # Clean up temp files
            for temp_file in temp_files:
                try:
                    os.remove(temp_file)
                except:
                    pass
    
    def stop(self):
        """Stop the current transcription"""
        self.should_stop = True
    
    def get_model_info(self) -> dict:
        """Get information about the currently loaded model"""
        return {
            'model_name': self.model_name,
            'device': self._device,
            'compute_type': self._compute_type,
            'is_loaded': self.model is not None
        }


# Global transcriber instance
_transcriber = None


def get_transcriber() -> AudioTranscriber:
    """Get or create the global transcriber instance"""
    global _transcriber
    if _transcriber is None:
        _transcriber = AudioTranscriber()
    return _transcriber
