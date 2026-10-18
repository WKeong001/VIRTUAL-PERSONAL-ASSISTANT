"""
Offline AI assistant integration using GPT4All.
"""

from __future__ import annotations

import os
import re
import math
import difflib
import hashlib
import json
import sys
from datetime import datetime
from collections import Counter
from pathlib import Path
from typing import Optional, Tuple

from config import config


def _register_cuda_dll_dirs() -> None:
    """Make the venv's bundled CUDA 12 runtime DLLs discoverable so GPT4All's
    CUDA backend loads instead of silently falling back to CPU.

    The cudart/cublas DLLs ship inside the torch and nvidia wheels but are not
    on the DLL search path when gpt4all imports its CUDA backend on Windows.
    """
    if os.name != "nt":
        return
    site_packages = Path(__file__).resolve().parent / ".venv" / "Lib" / "site-packages"
    if not site_packages.exists():
        # Fall back to the interpreter's own site-packages (installed env).
        for p in sys.path:
            cand = Path(p)
            if cand.name == "site-packages" and cand.exists():
                site_packages = cand
                break
    candidates = [site_packages / "torch" / "lib"]
    nvidia_root = site_packages / "nvidia"
    if nvidia_root.exists():
        candidates.extend(sorted(nvidia_root.glob("*/bin")))
    for d in candidates:
        try:
            if d.exists():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
        except Exception:
            pass


_register_cuda_dll_dirs()


# Standardized prompt for report draft summaries. Kept as a module-level
# constant so every "summarize the occurrences" request is handled identically.
SO_REPORT_SUMMARY_SYSTEM_PROMPT = (
    "You are an operations support assistant that drafts Operational Report "
    "summaries from radio / walkie-talkie communication logs. Your job is to "
    "weave the logged occurrences into a clear, professional narrative account "
    "written in flowing prose \u2014 a short, factual story of what happened.\n"
    "STRICT RULES:\n"
    "1. Use ONLY the information present in the provided logs. Never invent or "
    "assume times, locations, call signs, code names, or events.\n"
    "2. Preserve every factual detail exactly as logged: times, call signs, code "
    "names, locations, vehicle details, and actions.\n"
    "2b. NEVER omit observed human behavior or interaction details when they are "
    "present in the logs (for example walking together, browsing, waiting, "
    "holding hands, talking, meeting, eating, entering, exiting). Keep those "
    "details in the narrative unless the source line itself is uncertain.\n"
    "3. Narrate the occurrences in chronological order (earliest first), "
    "connecting them into a coherent account with natural transitions. When "
    "several logged messages form one continuous exchange (grouped together under "
    "a single time or time range), narrate them as ONE merged event in a single "
    "flowing passage, not as separate occurrences.\n"
    "4. Write in proper, grammatical English: neutral, formal, third-person past "
    "tense. Remove radio jargon such as 'over', 'copy', 'roger', 'out', and "
    "filler words, and turn fragmented radio speech into complete sentences.\n"
    "5. Weave times naturally into the sentences (for example, 'At 1305 hrs, "
    "...') using 'HHmm hrs' format when a time is available. Do NOT use bullet "
    "points, dashes, numbered lists, or one-line-per-event formatting.\n"
    "6. Do NOT add commentary, opinions, recommendations, analysis, or a "
    "conclusion. Narrate only what occurred.\n"
    "7. NAME / ENTITY: When a Name / Entity is provided with the request, use it "
    "naturally where the logs support it. If none is provided, refer only to the "
    "person, party, vehicle, or entity explicitly identified in the logs; never "
    "invent an identity.\n"
    "9. Output the narrative ONLY. Do NOT write any greeting, sign-off, closing "
    "remark, offer to help further, question to the user, note, disclaimer, "
    "simulation statement, role label, or meta-commentary about the task. Never "
    "write phrases like 'I'm glad', 'let me know', 'this response is a "
    "simulation', or 'Note:'. Do not refer to yourself or the user at all.\n"
    "Write the summary as one or more paragraphs of continuous prose and nothing "
    "else. Do not include headings, labels, bullet markers, separator lines, a "
    "'SUMMARY OF OCCURRENCES' title, or any text before or after the narrative "
    "\u2014 output only the narrative paragraphs."
)


# Compact prompt for rewriting one time-window's log(s) into a single Movements
# cell for the AI report table. Produces concise factual prose per row.
SO_REPORT_ROW_SYSTEM_PROMPT = (
    "You are an operations support assistant. You are given one or more radio / "
    "walkie-talkie log lines that already come from a report "
    "draft and fall within one time window. Combine them into a single clear "
    "Movements entry by rephrasing them into proper third-person past-tense "
    "English. This is STRICTLY a rewording-and-merging task, NOT a summary and "
    "NOT a rewrite that adds meaning. You may ONLY paraphrase. You must NEVER "
    "omit, drop, shorten, condense, generalize, or leave out ANY factual detail "
    "\u2014 every fact stated in the input MUST appear in your output. Rephrasing "
    "means changing the wording only, keeping 100% of the information.\n"
    "RULES:\n"
    "1. Use ONLY the facts and words present in the log line(s). Keep EVERY fact "
    "exactly as written: people, names, call signs, places, actions, directions, "
    "statuses, numbers, vehicles, and objects. Do not remove, merge away, or "
    "abbreviate any detail, and do not change who did what, where, or when. If "
    "in doubt about whether a detail matters, KEEP it \u2014 losing a fact is a "
    "failure, repeating a fact is acceptable.\n"
    "1a. Action-preservation rule: do NOT drop behavioral/interaction details "
    "from any source line when merging (for example browsing, holding hands, "
    "walking together, talking, waiting, entering, exiting, eating, returning "
    "home, or returning to a location). If the "
    "source mentions the action, it must appear in the final Movements sentence.\n"
    "1d. Do NOT compress a sequence of distinct actions into fewer actions than "
    "stated, even when they involve the same object (for example 'returned to "
    "his car', 'entered his car', and 'boarded the car' are THREE separate "
    "actions across three log lines and must ALL be represented — never "
    "collapse them into a single 'boarded the car'). Every log line's action "
    "needs its own clause or sentence in the output, in the same order.\n"
    "1e. CHRONOLOGICAL ORDER IS MANDATORY: the input log lines are already "
    "ordered earliest-to-latest. Build the Movements entry by reading line 1, "
    "then line 2, then line 3, and so on. Do NOT reorder, regroup, prioritize, "
    "or move events for readability. Earlier actions such as leaving home, "
    "boarding, or departing must appear before later actions such as parking, "
    "entering, or arriving when the source lines show that order.\n"
    "1c. Do NOT include clock times or times of day (for example '1611 hours', "
    "'at 1611 hrs', 'at approximately the same time') in the Movements text — a "
    "separate Time column already shows the time window. Omit the time references "
    "but keep all other facts.\n"
    "1b. Keep all abbreviations, acronyms, place names, road/expressway names, "
    "vehicle plates, and call signs EXACTLY as written \u2014 do NOT expand, spell "
    "out, translate, or 'correct' them (for example, keep 'AYE' as 'AYE', never "
    "'Area Yoke Echo').\n"
    "2. NEVER invent or add anything that is not literally in the lines \u2014 no "
    "new person, name, location, sector, area, time, number, vehicle, action, "
    "reason, purpose, cause, outcome, condition, safety status, or qualifier. "
    "Never add words like 'safely', 'successfully', 'peacefully', 'without incident', "
    "or 'uneventfully' unless those exact facts are stated in the source. Do not guess what happened before or "
    "after, and do not 'complete' the story. If a detail is not stated, leave it "
    "out.\n"
    "3. If a log line is short, vague, or incomplete, keep it short and vague \u2014 "
    "mirror the log's own wording. Do not pad it with assumed context or a "
    "subject/actor that was not named.\n"
    "4. Correct ordinary spelling, sentence capitalization, and punctuation to "
    "make the prose read smoothly. Preserve proper names, abbreviations, "
    "acronyms, call signs, vehicle plates, dates, times, numbers, locations, "
    "and road names exactly as supplied. When there are multiple lines, join "
    "them into one coherent entry in the given order.\n"
    "5. Remove radio jargon such as 'over', 'copy', 'roger', 'out', and filler.\n"
    "6. Preserve the names and descriptions used in the source logs.\n"
    "6b. VEHICLE FORMAT: When the source explicitly identifies a vehicle type "
    "and its plate, write the vehicle type followed immediately by the exact "
    "plate in square brackets, for example 'car [SMA 1234R]'. Preserve the plate "
    "exactly as written. Do not invent, infer, or correct a vehicle type or plate; "
    "if either one is missing, keep the source wording. Within the same merged "
    "time-window Movements entry (for example a 5-minute window), write each "
    "number plate ONLY ONCE even if multiple source lines repeat it. After the "
    "first plate mention, refer to it plainly (for example 'the car' or 'the "
    "vehicle') and do not repeat the plate again in that row.\n"
    "6c. LOCATION FORMAT: When the source says 'Block' followed by a number, "
    "write it as 'Blk' followed by the same number, for example 'Blk 123'. "
    "Preserve the number exactly and do not change unrelated wording.\n"
    "7. Do NOT explain, interpret, analyze, or add reasoning \u2014 no 'this "
    "indicates', 'this suggests', 'which means', or why/because context.\n"
    "8. Output ONLY the Movements entry as one short paragraph. No headings, "
    "labels, bullet points, clock times, greetings, sign-offs, preamble, or commentary. "
    "Do not start with 'Here is', 'Summary', or similar.\n"
    "9. Do NOT restate, quote, echo, or list the input log lines, their "
    "bracketed times (for example '[0947 hrs]'), or these instructions before "
    "or after your answer. Do not write 'The given log lines are', 'The log "
    "lines fall within', 'Combine every fact', or any similar restatement \u2014 "
    "write only the final rephrased Movements paragraph, nothing else."
)


# Compact version of the row prompt for small models (e.g. a 3B). Long prompts
# make small models echo the instructions instead of answering, so this keeps
# only the essential rules in a few short sentences.
SO_REPORT_ROW_SYSTEM_PROMPT_COMPACT = (
    "You are an operations report writer. Rephrase the supplied Key "
    "occurrences as one clear, concise third-person past-tense paragraph. Merge "
    "related events in chronological order and rewrite raw radio wording into "
    "natural professional English. Correct ordinary spelling, capitalization, and "
    "punctuation while preserving the same meaning, including any "
    "uncertainty expressed in the source. Do not add new events, actions, "
    "people, places, reasons, or outcomes. Names, abbreviations, call signs, "
    "locations, vehicle plates, and numbers must remain exact. Do "
    "not include clock times or leading relative-time phrases because the Time "
    "column already records them. Output only the paragraph."
)


# Strict, evidence-only prompt for answering questions on the Live Transcript
# view. Purpose-built to prevent hallucination: the model may use ONLY the
# supplied log context and must refuse when the answer is not explicitly present.
LIVE_TRANSCRIPT_QA_SYSTEM_PROMPT = (
    "You are a strict, evidence-only assistant answering questions about radio "
    "communication logs shown in the Live Transcript view. Ground every word of "
    "your answer in the provided log context.\n"
    "ABSOLUTE RULES (to prevent hallucination):\n"
    "1. Use ONLY the text in the 'Processed Logs Context' provided below. Never "
    "use outside knowledge, training data, assumptions, or memory.\n"
    "2. Do NOT invent, infer, guess, or extrapolate any time, date, call sign, "
    "code name, person, location, vehicle, quantity, or event. If it is not "
    "written in the logs, it does not exist for your answer.\n"
    "3. Every fact you state must be directly supported by a specific log line. "
    "Cite the supporting log by its filename (and time when available).\n"
    "4. If the logs do not explicitly contain the answer, reply exactly: "
    "'Cannot confirm from the logs.' Do not attempt a partial or speculative "
    "answer, and do not pad the reply with guesses.\n"
    "5. When a log explicitly states the fact asked about, confirm it directly "
    "and quote the exact supporting words. Do not hedge on facts plainly "
    "present in the logs.\n"
    "6. Do not add narrative, backstory, opinions, recommendations, or "
    "commentary about whether the logs are 'correct'. Answer only what is asked.\n"
    "7. Do not merge unrelated logs into a single claim, and do not cite logs "
    "that do not answer the question.\n"
    "8. For a specific factual question, answer with only the requested fact "
    "and one short supporting sentence at most. Never reproduce the full log, "
    "full paragraph, retrieved context, or unrelated details.\n"
    "9. If the question asks for one item such as a vehicle number, time, "
    "location, name, or action, return only that item and its source filename.\n"
    "Be concise and precise \u2014 evidence first, no filler."
)


class GPT4AllAssistant:
    def __init__(self):
        self.model = None
        self._load_error: Optional[str] = None
        self._import_error: Optional[str] = None
        self._gpt4all_cls = None
        self._last_device = "cpu"
        self._last_error: Optional[str] = None
        self._retrieval_cache_signature = None
        self._retrieval_docs = []
        self._retrieval_doc_freq = {}
        self._retrieval_avg_doc_len = 1.0
        self._retrieval_total_docs = 0
        self._pynvml = None
        self._gpu_available = False
        self._last_report_structured = None
        self._setup_import()

    def _setup_import(self):
        try:
            from gpt4all import GPT4All

            self._gpt4all_cls = GPT4All
        except Exception as exc:
            self._import_error = f"GPT4All package unavailable: {exc}"

        # Setup NVIDIA GPU monitoring
        try:
            import pynvml
            pynvml.nvmlInit()
            self._pynvml = pynvml
            self._gpu_available = True
        except Exception:
            self._gpu_available = False

    def _load_report_template_text(self) -> str:
        template_path = (config.get("ai_report_template_path", "") or "").strip()
        if not template_path:
            return ""

        base_dir = Path(__file__).resolve().parent
        candidate = Path(template_path)
        if not candidate.is_absolute():
            candidate = (base_dir / candidate).resolve()

        try:
            if not candidate.exists():
                return ""
            suffix = candidate.suffix.lower()
            if suffix == ".docx":
                from docx import Document

                doc = Document(str(candidate))
                parts = [para.text.strip() for para in doc.paragraphs if para.text.strip()]
                for table in doc.tables:
                    for row in table.rows:
                        cells = [cell.text.strip() for cell in row.cells]
                        cells = [cell for cell in cells if cell]
                        if not cells:
                            continue
                        # Avoid repeating merged-cell text by collapsing consecutive duplicates.
                        deduped = [cells[0]]
                        for cell in cells[1:]:
                            if cell != deduped[-1]:
                                deduped.append(cell)
                        parts.append(" | ".join(deduped))
                return "\n".join(parts).strip()
            if suffix == ".doc":
                return ""
            return candidate.read_text(encoding="utf-8").strip()
        except Exception:
            return ""

    def get_last_report_structured(self) -> Optional[dict]:
        return self._last_report_structured

    def _extract_json_block(self, text: str) -> str:
        if not text:
            return ""
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return ""
        return text[start:end + 1].strip()

    def _normalize_report_value(self, value: str) -> str:
        cleaned = (value or "").strip()
        return cleaned if cleaned else "Not available"

    def _format_report_time(self, processed_at: str) -> str:
        if not processed_at:
            return "Not available"

        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
            try:
                parsed = datetime.strptime(str(processed_at), fmt)
                return parsed.strftime("%H%M hrs")
            except ValueError:
                continue

        try:
            parsed = datetime.fromisoformat(str(processed_at))
            return parsed.strftime("%H%M hrs")
        except ValueError:
            return "Not available"

    def _build_structured_report_from_logs(self, log_entries: list[dict], report_meta: dict) -> dict:
        title = "NORMAL REPORT"
        date_value = self._format_report_date_label(str(report_meta.get("date", "")))
        ref_no = self._normalize_report_value(str(report_meta.get("ref_no", "")))
        subject = self._normalize_report_value(str(report_meta.get("subject", "")))

        rows_with_time = []
        for entry in log_entries:
            processed_at = entry.get("processed_at", "")
            time_value = self._format_report_time(processed_at)
            movements = str(entry.get("edited_content", "") or "").strip()
            # Strip leading [filename] tags if present.
            movements = re.sub(r"^\[[^\]]+\]\s*", "", movements)
            movements = re.sub(r"\s+", " ", movements)
            if re.search(r"\b(no sign|not sighted|no sighting|not seen)\b", movements.lower()):
                continue
            is_termination = "terminate" in movements.lower()
            rows_with_time.append({
                "time": time_value,
                "movements": movements,
                "remarks": "",
                "_processed_at": processed_at,
                "_is_termination": is_termination,
            })

        def sort_key(row: dict):
            processed_at = row.get("_processed_at", "")
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(str(processed_at), fmt)
                except ValueError:
                    continue
            try:
                return datetime.fromisoformat(str(processed_at))
            except ValueError:
                return datetime.min

        rows_with_time.sort(key=sort_key)

        # Assign time ranges based on consecutive processed_at timestamps.
        for index, row in enumerate(rows_with_time):
            start_time = row.get("time", "Not available")
            end_time = None
            if index + 1 < len(rows_with_time):
                end_time = rows_with_time[index + 1].get("time")
            if end_time and end_time != "Not available" and start_time != "Not available":
                if end_time == start_time:
                    row["time"] = start_time
                else:
                    row["time"] = f"Between {start_time}\nand\n{end_time}"
            elif start_time != "Not available":
                row["time"] = start_time

        normalized_rows = []
        for row in rows_with_time:
            movement_text = self._normalize_report_value(row.get("movements", ""))
            movement_text = self._paraphrase_movement(movement_text, subject)

            normalized_rows.append({
                "time": self._normalize_report_value(row.get("time", "")),
                "movements": movement_text,
                "remarks": "",
                "_is_termination": row.get("_is_termination", False),
            })

        termination = [row for row in normalized_rows if row.get("_is_termination")]
        regular = [row for row in normalized_rows if not row.get("_is_termination")]

        for row in termination + regular:
            row.pop("_is_termination", None)

        return {
            "title": title,
            "date": date_value,
            "ref_no": ref_no,
            "subject": subject,
            "rows": regular + termination,
        }

    def _paraphrase_movement(self, movement: str, subject: str) -> str:
        movement = (movement or "").strip()
        if not movement:
            return "Not available"

        # Deterministic cleanup only (avoid hallucinations).
        cleaned = movement[0].upper() + movement[1:] if movement else movement
        if cleaned and not cleaned.endswith(('.', '!', '?')):
            cleaned = f"{cleaned}."
        return cleaned

    def _format_report_date_label(self, date_text: str) -> str:
        if not date_text:
            return "Not available"

        def format_one(date_str: str) -> str:
            candidates = ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y")
            for fmt in candidates:
                try:
                    parsed = datetime.strptime(date_str, fmt)
                    return parsed.strftime("%d/%m/%y (%A)")
                except ValueError:
                    continue
            return date_str.strip()

        if " to " in date_text:
            start_text, end_text = [part.strip() for part in date_text.split(" to ", 1)]
            return f"{format_one(start_text)} to {format_one(end_text)}"

        return format_one(date_text.strip())

    def _parse_report_json(self, text: str) -> Optional[dict]:
        raw = self._extract_json_block(text)
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except Exception:
            return None

        title = self._normalize_report_value(str(payload.get("title", "NORMAL REPORT")))
        date_value = self._normalize_report_value(str(payload.get("date", "")))
        ref_no = self._normalize_report_value(str(payload.get("ref_no", "")))
        subject = self._normalize_report_value(str(payload.get("subject", "")))
        rows = payload.get("rows", []) if isinstance(payload.get("rows", []), list) else []

        return {
            "title": title,
            "date": date_value,
            "ref_no": ref_no,
            "subject": subject,
            "rows": self._normalize_report_rows(rows),
        }

    def _format_report_text(self, report: dict) -> str:
        title = report.get("title", "NORMAL REPORT")
        date_value = report.get("date", "Not available")
        ref_no = report.get("ref_no", "Not available")
        subject = report.get("subject", "Not available")
        rows = report.get("rows", [])

        def clean_cell(value: str, allow_empty: bool = False) -> str:
            cleaned = str(value).replace("|", "/").replace("\n", " ").strip()
            if cleaned:
                return cleaned
            if allow_empty:
                return ""
            return "Not available"

        lines = [
            title,
            f"Date: | {clean_cell(date_value)}",
            f"Ref No: | {clean_cell(ref_no)}",
            f"Subject: | {clean_cell(subject)}",
            "Time | Movements | Remarks",
        ]

        if not rows:
            lines.append("Not available | Not available | Not available")
        else:
            for row in rows:
                lines.append(
                    f"{clean_cell(row.get('time'))} | {clean_cell(row.get('movements'))} | {clean_cell(row.get('remarks'), allow_empty=True)}"
                )

        return "\n".join(lines)

    def _resolve_model_settings(self) -> Tuple[Optional[str], Optional[str], str]:
        model_name = config.get("ai_model_name", "").strip()
        model_path = config.get("ai_model_path", "").strip()
        preferred_device = config.get("ai_device", "gpu").strip().lower()

        models_dir = self.get_models_directory(model_path)
        models_dir.mkdir(parents=True, exist_ok=True)

        if not model_path:
            model_path = str(models_dir)

        if not model_name:
            discovered_models = sorted(models_dir.glob("*.gguf"))
            if discovered_models:
                model_name = discovered_models[0].name

        if preferred_device not in {"gpu", "cpu", "auto"}:
            preferred_device = "gpu"

        return model_name or None, model_path or None, preferred_device

    def get_models_directory(self, configured_path: Optional[str] = None) -> Path:
        base_dir = Path(__file__).resolve().parent
        if configured_path:
            candidate = Path(configured_path)
            if not candidate.is_absolute():
                candidate = (base_dir / candidate).resolve()
            return candidate
        return (base_dir / "models").resolve()

    def _get_available_gpu_device(self) -> Optional[str]:
        """Get the first available GPU device (prefers CUDA for NVIDIA speed)."""
        if not self._gpt4all_cls:
            return None
        try:
            gpus = self._gpt4all_cls.list_gpus()
            if gpus:
                # Prefer CUDA (NVIDIA) — far faster than the kompute/Vulkan backend.
                for gpu in gpus:
                    if gpu.startswith("cuda:"):
                        return gpu
                # Fall back to a Vulkan/kompute GPU if no CUDA device is present.
                for gpu in gpus:
                    if gpu.startswith("kompute:"):
                        return gpu
                # Fall back to any available GPU
                return gpus[0]
        except Exception:
            pass
        return None

    def _create_model_instance(self, model_name: str, model_path: Optional[str], device: str):
        kwargs = {
            "model_name": model_name,
            "allow_download": False,
            "n_ctx": max(2048, int(config.get("ai_context_size", 8192))),
        }

        if model_path:
            kwargs["model_path"] = model_path

        if device == "gpu":
            # Try to find a specific GPU device (kompute preferred)
            available_gpu = self._get_available_gpu_device()
            if available_gpu:
                kwargs["device"] = available_gpu
            else:
                kwargs["device"] = device
        elif device != "auto":
            kwargs["device"] = device

        return self._gpt4all_cls(**kwargs)

    def load(self) -> bool:
        if self.model is not None:
            return True

        if self._import_error:
            self._load_error = self._import_error
            self._last_error = self._load_error
            return False

        model_name, model_path, preferred_device = self._resolve_model_settings()
        if not model_name:
            self._load_error = (
                "No GPT4All model configured. Set 'ai_model_name' (and optional 'ai_model_path') in config.json or place a .gguf file in the models folder."
            )
            self._last_error = self._load_error
            return False

        try:
            if preferred_device == "auto":
                self.model = self._create_model_instance(model_name, model_path, "auto")
                self._last_device = "auto"
            elif preferred_device == "gpu":
                try:
                    self.model = self._create_model_instance(model_name, model_path, "gpu")
                    self._last_device = "gpu"
                except Exception:
                    self.model = self._create_model_instance(model_name, model_path, "cpu")
                    self._last_device = "cpu"
            else:
                self.model = self._create_model_instance(model_name, model_path, "cpu")
                self._last_device = "cpu"
            return True
        except Exception as exc:
            self._load_error = f"Failed to load GPT4All model: {exc}"
            self._last_error = self._load_error
            return False

    def get_status(self) -> str:
        if self.model is not None:
            return f"Model loaded ({self._last_device.upper()})"
        if self._load_error:
            return self._load_error
        return "Model not loaded"

    def _lookup_singapore_address(self, query: str) -> Optional[str]:
        """Look up Singapore addresses from local offline database (1708 addresses)."""
        try:
            from database import TranscriptionDB
            
            db = TranscriptionDB()
            result = db.search_singapore_address(query)
            
            if result:
                address = result.get('address', '')
                postal_code = result.get('postal_code', '')
                category = result.get('category', '')
                
                if address and postal_code:
                    return f"Address: {address}, {postal_code} ({category})"
                elif address:
                    return f"Address: {address}"
            
            # Not found in local database - return None for offline operation
            return None
        except Exception as e:
            print(f"[DEBUG] Address lookup error: {e}")
            return None

    def _lookup_onemap_address(self, location: str) -> Optional[dict]:
        """Search OneMap API for Singapore address. Returns dict with 'address' and 'postal_code' or None."""
        try:
            import urllib.request
            import urllib.parse
            import json
            
            # URL encode the location to handle spaces and special characters
            encoded_location = urllib.parse.quote(location)
            
            # OneMap Search API endpoint (no key required for basic search)
            search_url = f"https://www.onemap.sg/api/common/elastic/search?searchVal={encoded_location}&returnGeom=Y&getAddrDetails=Y&pageNum=1"
            
            print(f"[DEBUG] Querying OneMap API for: {location}")
            
            # Set a timeout to prevent hanging
            with urllib.request.urlopen(search_url, timeout=5) as response:
                data = json.loads(response.read().decode('utf-8'))
                
                if data.get('found', 0) > 0:
                    results = data.get('results', [])
                    if results:
                        first_result = results[0]
                        address = first_result.get('ADDRESS', '')
                        postal_code = first_result.get('POSTAL', '')
                        
                        if address:
                            print(f"[DEBUG] OneMap found: {address} ({postal_code})")
                            return {
                                'name': location,
                                'address': address,
                                'postal_code': postal_code,
                                'category': 'Location'
                            }
                
                print(f"[DEBUG] OneMap returned no results for: {location}")
                return None
                
        except urllib.error.URLError as e:
            print(f"[DEBUG] OneMap API connection error: {e}")
            return None
        except Exception as e:
            print(f"[DEBUG] OneMap API error: {e}")
            return None

    def ask_general(self, user_prompt: str, history: Optional[list[dict]] = None,
                    mode: str = "chat") -> str:
        if not user_prompt.strip():
            return "Please enter a prompt."

        if not self.load():
            return self.get_status()
        
        # Address lookup is intentionally limited to explicit address/postal
        # requests so ordinary conversation is always handled by the chat model.
        question_lower = user_prompt.lower()
        is_address_question = mode == "chat" and bool(re.search(
            r"\b(address|postal\s+code)\b|\bwhere\s+(?:is|are)\b", question_lower
        ))
        
        print(f"[DEBUG] Question: {user_prompt}, Is address question: {is_address_question}")
        
        if is_address_question:
            # Extract location name
            # Common patterns for location questions
            patterns = [
                r'(?:address of|location of|where is|where are|where\'s)\s+([a-zA-Z0-9\s]+?)(?:\?|$)',
                r'^([A-Za-z0-9\s]+?)\s+(?:address|location|postal code)',
                r'(?:junction|j)\s+(\d+)',  # Catch "Junction 8" or "J8"
            ]
            
            location_name = None
            for pattern in patterns:
                match = re.search(pattern, question_lower, re.IGNORECASE)
                if match:
                    location_name = match.group(1).strip()
                    print(f"[DEBUG] Pattern matched: {pattern} -> {location_name}")
                    break
            
            # If no pattern match, extract meaningful words (not stopwords)
            if not location_name:
                stopwords = {'the', 'is', 'address', 'location', 'where', 'what', 'of', 'in', 'at', 'a', 'an', 'singapore', 'postal', 'code'}
                words = [w for w in question_lower.split() if w not in stopwords and len(w) > 2]
                if words:
                    location_name = ' '.join(words[:2])
                    print(f"[DEBUG] Fallback extraction: {location_name}")
            
            print(f"[DEBUG] Extracted location: {location_name}")
            
            # Try database lookup
            if location_name:
                address = self._lookup_singapore_address(location_name)
                if address:
                    return address
            
            return "Address not found in database. Available locations: Junction 8, Marina Bay Sands, National Gallery, Changi Airport, etc."

        if mode == "rewrite":
            system_prompt = (
                "You are a careful rewriting and grammar assistant. Rewrite the user's text into "
                "fluent, grammatical English with normal sentence capitalization and punctuation, "
                "even when the input is all capitals, fragmented, or poorly punctuated. Preserve "
                "the original meaning and factual details. Keep proper names, acronyms, call signs, "
                "vehicle plates, dates, times, and numbers exactly as supplied. Return only the "
                "rewritten text, with no introduction, explanation, quotation marks, or commentary."
            )
            return self._dedupe_and_clean_answer(
                self._truncate_at_meta(self._generate(system_prompt, user_prompt))
            )

        history_lines = []
        history_chars = 0
        for turn in reversed((history or [])[-6:]):
            if not isinstance(turn, dict):
                continue
            prior_prompt = str(turn.get("prompt", "")).strip()[:1000]
            prior_answer = str(turn.get("answer", "")).strip()[:1500]
            if prior_prompt and prior_answer:
                history_line = f"User: {prior_prompt}\nAssistant: {prior_answer}"
                if history_chars + len(history_line) > 6000:
                    break
                history_lines.append(history_line)
                history_chars += len(history_line)

        history_lines.reverse()

        system_prompt = (
            "You are a helpful offline conversational assistant. Answer the user's latest request "
            "directly, naturally, and accurately. Follow requested writing tasks such as rephrasing, "
            "summarising, explaining, drafting, or correcting text. When the user asks to rephrase "
            "or rewrite supplied text, return only the rewritten text and preserve its meaning and "
            "facts. Use the prior conversation only for context; do not repeat it unless asked. Do "
            "not invent facts."
        )
        conversation = "\n\n".join(history_lines)
        full_prompt = (conversation + "\n\n" if conversation else "") + "User: " + user_prompt + "\nAssistant:"
        return self._dedupe_and_clean_answer(
            self._truncate_at_meta(self._generate(system_prompt, full_prompt))
        )

    def ask_documents(self, user_prompt: str, documents: list[dict]) -> str:
        """Answer from supplied document extracts without report-log assumptions."""
        if not user_prompt.strip():
            return "Please enter a question about the selected documents."
        if not documents:
            return "No readable document extracts are available."
        if not self.load():
            return self.get_status()

        extracts = []
        for document in documents:
            if not isinstance(document, dict):
                continue
            content = str(document.get("content", "") or "").strip()
            if not content:
                continue
            filename = str(document.get("filename", "Document") or "Document")
            extracts.append(f"[{filename}]\n{content}")
        if not extracts:
            return "No readable document extracts are available."

        system_prompt = (
            "You are a careful offline document Q&A assistant. Answer using ONLY "
            "the supplied document extracts. Do not use report-log conventions, "
            "outside knowledge, or assumptions. For exact identifiers, names, "
            "dates, numbers, and codes, copy the value exactly from the extract. "
            "If the answer is not present, say that the selected documents do "
            "not provide it. Keep the answer concise and identify the source "
            "filename when useful."
        )
        document_context = "\n\n".join(extracts)
        prompt = f"Document extracts:\n{document_context}\n\nQuestion: {user_prompt}\nAnswer:"
        return self._dedupe_and_clean_answer(
            self._truncate_at_meta(
                self._generate(
                    system_prompt,
                    prompt,
                    max_tokens=int(config.get("ai_logs_max_tokens", 320) or 320),
                )
            )
        )

    def ask_logs(self, user_prompt: str, log_entries: list[dict], report_meta: Optional[dict] = None) -> str:
        if not user_prompt.strip():
            return "Please enter a question about the logs."

        if not log_entries:
            return "No processed logs available to analyze."

        if not self.load():
            return self.get_status()

        # Standardized SO Report summary path. When the user asks to summarise or
        # rephrase the occurrences, always handle it the same way via a fixed
        # prompt so the output style is consistent every time.
        if self._is_summary_request(user_prompt):
            summary_entries = [
                entry for entry in log_entries
                if str(entry.get('edited_content', '') or '').strip()
                and str(entry.get('edited_content', '') or '').strip() != "[No transcript text]"
            ]
            if not summary_entries:
                return "No transcript text found in the selected logs to summarize."
            return self._summarize_occurrences_for_so_report(
                user_prompt, summary_entries, report_meta or {}
            )

        # Check if user is requesting a report (only generate if explicitly asked)
        report_keywords = ["report", "generate", "create", "produce", "make a report", "give me a report"]
        is_report_request = any(keyword in user_prompt.lower() for keyword in report_keywords)
        
        report_template = self._load_report_template_text()
        if report_template and is_report_request:
            structured = self._build_structured_report_from_logs(log_entries, report_meta or {})
            self._last_report_structured = structured
            return self._format_report_text(structured)

        # For log Q&A (non-report), only keep entries that have real transcript text.
        non_empty_entries = []
        for entry in log_entries:
            content = str(entry.get('edited_content', '') or '').strip()
            if not content:
                continue
            if content == "[No transcript text]":
                continue
            non_empty_entries.append(entry)

        if not non_empty_entries:
            return "No transcript text found in the selected logs."

        log_entries = non_empty_entries

        wants_all_matches = self._wants_all_matches(user_prompt)
        explicit_all_subject_tokens = self._extract_all_entries_subject_tokens(user_prompt)
        if (self._is_list_relevant_request(user_prompt) or wants_all_matches) and not explicit_all_subject_tokens:
            explicit_all_subject_tokens = self._extract_subject_tokens_for_list_query(user_prompt)

        if self._is_list_relevant_request(user_prompt) or wants_all_matches:
            matches = self._find_must_include_logs(user_prompt, log_entries, max_items=None)
            if explicit_all_subject_tokens:
                candidate_entries = matches if matches else log_entries
                strict_matches = []
                for entry in candidate_entries:
                    haystack = self._entry_search_haystack(entry)
                    haystack_tokens = set(self._tokenize(haystack))
                    if all(token in haystack_tokens for token in explicit_all_subject_tokens):
                        strict_matches.append(entry)
                matches = strict_matches
            # If no exact matches found, fall back to BM25-based retrieval with looser matching
            if not matches and not explicit_all_subject_tokens:
                max_logs = max(int(config.get("ai_rag_max_logs", 200)), 1)
                retrieve_limit = min(max_logs, len(log_entries))
                matches = self._retrieve_relevant_logs(user_prompt, log_entries, retrieve_limit)
            if not matches:
                return "No relevant logs found for the question."
            matches = self._sort_entries_chronologically(matches)
            return self._format_relevant_log_list(matches, user_prompt)

        rag_top_k = int(config.get("ai_rag_top_k", 8))
        if wants_all_matches:
            max_logs = max(int(config.get("ai_rag_max_logs", 200)), 1)
            rag_top_k = min(max_logs, len(log_entries))
        selected = self._retrieve_relevant_logs(user_prompt, log_entries, rag_top_k)
        must_include = self._find_must_include_logs(user_prompt, log_entries)
        if must_include:
            selected = self._merge_unique_logs(must_include + selected)
        if not selected:
            return "No relevant logs found for the question."
        # Keep evidence in chronological order so multi-occurrence answers read
        # in the same order as the Key SO Occurences table.
        selected = self._sort_entries_chronologically(selected)

        # If we have explicit must-include matches (deterministic evidence), return them directly
        # This prevents LLM hallucination on factual questions about purchases/events
        if must_include:
            best_evidence = self._find_best_matching_log(user_prompt, must_include)
            if best_evidence:
                filename = best_evidence.get('filename', '')
                content = best_evidence.get('edited_content', '')
                vehicle_numbers = self._extract_vehicle_numbers_for_question(user_prompt, content)
                if vehicle_numbers:
                    return f"Confirmed from logs. Car number(s) in {filename}: {', '.join(vehicle_numbers)}"
                return self._format_direct_evidence_answer(user_prompt, best_evidence)

        # Ordinary fact questions should be answered from one evidence sentence,
        # rather than sending a whole report to the model for a verbose reply.
        if self._is_short_fact_question(user_prompt):
            best_match = self._find_best_matching_log(user_prompt, selected)
            if best_match:
                filename = best_match.get('filename', '')
                content = best_match.get('edited_content', '')
                vehicle_numbers = self._extract_vehicle_numbers_for_question(user_prompt, content)
                if vehicle_numbers:
                    return f"Confirmed from logs. Car number(s) in {filename}: {', '.join(vehicle_numbers)}"
                return self._format_direct_evidence_answer(user_prompt, best_match)
            else:
                return "Cannot confirm from the logs."

        # For yes/no questions, return direct evidence without LLM interpretation
        if self._is_yes_no_fact_question(user_prompt):
            # Find the most relevant log using simple keyword matching
            best_match = self._find_best_matching_log(user_prompt, selected)
            if best_match:
                filename = best_match.get('filename', '')
                content = best_match.get('edited_content', '')
                # Extract only the most relevant line(s) from the content
                relevant_line = self._extract_best_evidence_line(user_prompt, content)
                if relevant_line:
                    return f"Yes. Evidence in {filename}: {relevant_line}"
                return "Yes, but the specific supporting detail could not be isolated."
            else:
                return "No."

        logs_text = "\n\n".join(
            [
                (
                    f"Filename: {item.get('filename', '')}\n"
                    f"Processed At: {item.get('processed_at', '')}\n"
                    f"Content: {item.get('edited_content', '')}"
                )
                for item in selected
            ]
        )

        report_instruction = (
            "Be concise and direct. Answer the specific question asked without adding narrative or backstory. "
            "If asked for a time, location, action, or fact, state it directly with the supporting log reference. "
            "Do not explain what is NOT in the logs unless the answer is genuinely not available. "
            "Only cite logs that directly answer the question. Do not list all retrieved logs. "
            "The logs below are already ordered earliest-to-latest. If the answer involves more than one "
            "occurrence, present them in that same chronological order (earliest first). Never reorder them."
        )

        system_prompt = f"{LIVE_TRANSCRIPT_QA_SYSTEM_PROMPT} {report_instruction}"
        user_content = (
            f"Retrieved {len(selected)} relevant logs for this question, listed in chronological order "
            "(earliest first).\n\n"
            "Processed Logs Context:\n"
            f"{logs_text}\n\n"
            "Question:\n"
            f"{user_prompt}\n\n"
            "Answer using ONLY the logs above. Cite the specific log(s) that "
            "answer the question, keeping them in the same chronological order shown above. "
            "If the answer is not explicitly present, reply "
            "'Cannot confirm from the logs.'"
        )
        answer = self._generate(
            system_prompt,
            user_content,
            # No artificial floor: a lower cap bounds worst-case generation time
            # on GPU-throughput-limited hardware without affecting short answers.
            max_tokens=int(config.get("ai_logs_max_tokens", config.get("ai_max_tokens", 320))),
        )
        answer = self._dedupe_and_clean_answer(answer)

        if "cannot confirm" in answer.lower():
            explicit = self._find_explicit_evidence(user_prompt, selected)
            if explicit:
                filename = explicit.get('filename', '')
                content = explicit.get('content', '')
                relevant_line = self._extract_best_evidence_line(user_prompt, content)
                if not relevant_line:
                    return "Cannot confirm from the logs."
                return (
                    "Confirmed from logs. "
                    f"Evidence in {filename}: {relevant_line}"
                )

        return answer

    def _is_short_fact_question(self, question: str) -> bool:
        text = str(question or '').strip().lower()
        if not text or self._is_summary_request(text) or self._wants_all_matches(text):
            return False
        if self._is_list_relevant_request(text):
            return False
        # Keep literal source answers only for exact identifiers and timestamps.
        # Other Key SO questions should be answered by the model in clear,
        # grounded language rather than by echoing an occurrence verbatim.
        return bool(re.search(
            r"\b(?:what\s+(?:time|date)|which\s+date|at\s+what\s+time|"
            r"time\s+did|when\b|car\s+(?:number|plate)|vehicle\s+(?:number|plate)|"
            r"registration\s+(?:number|plate))\b",
            text,
        ))

    def _is_summary_request(self, question: str) -> bool:
        """Detect a request to summarise / rephrase occurrences for an SO Report."""
        text = (question or "").lower()
        summary_keywords = (
            "summarize", "summarise", "summary", "rephrase", "paraphrase",
            "recap", "overview", "write up", "write-up", "draft a summary",
            "draft the summary", "sum up",
        )
        return any(keyword in text for keyword in summary_keywords)

    def _summarize_occurrences_for_so_report(
        self, user_prompt: str, entries: list[dict], report_meta: dict
    ) -> str:
        """Rephrase and summarise occurrences into a consistent SO Report draft."""

        def sort_key(item: dict):
            processed_at = str(item.get("processed_at", ""))
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(processed_at, fmt)
                except ValueError:
                    continue
            try:
                return datetime.fromisoformat(processed_at)
            except ValueError:
                return datetime.min

        ordered = sorted(entries, key=sort_key)

        gap_minutes = float(config.get("ai_merge_gap_minutes", 5))
        gap_seconds = max(0.0, gap_minutes * 60.0)
        groups = self._group_entries_by_time_gap(ordered, gap_seconds)

        tag_pattern = re.compile(r"^\[[^\]]+\]\s*")
        formatted_occurrences = []
        for group in groups:
            start_label = self._format_report_time(group[0].get("processed_at", ""))
            end_label = self._format_report_time(group[-1].get("processed_at", ""))
            if len(group) == 1 or start_label == end_label:
                time_label = start_label
            else:
                time_label = f"{start_label} to {end_label}"
            if len(group) == 1:
                content = tag_pattern.sub("", str(group[0].get("edited_content", "") or "").strip())
                formatted_occurrences.append(f"Time: {time_label}\nLog: {content}")
            else:
                parts = []
                for item in group:
                    item_time = self._format_report_time(item.get("processed_at", ""))
                    item_content = tag_pattern.sub("", str(item.get("edited_content", "") or "").strip())
                    parts.append(f"[{item_time}] {item_content}")
                joined = " ".join(parts)
                formatted_occurrences.append(
                    "Time: " + time_label + "\nConversation (one continuous exchange \u2014 "
                    "merge into a single event): " + joined
                )
        subject = self._normalize_report_value(str(report_meta.get("subject", "")))
        ref_no = self._normalize_report_value(str(report_meta.get("ref_no", "")))
        date_label = self._normalize_report_value(str(report_meta.get("date", "")))
        client_display = subject or "(not provided \u2014 infer the main person or entity from the logs below)"

        summary_max_tokens = int(config.get("ai_summary_max_tokens", 768))
        context_size = max(2048, int(config.get("ai_context_size", 8192)))
        # Reserve room for the system prompt, fixed template wording, report
        # metadata, generated output, and a safety margin so a summary prompt
        # can never exceed the model context window.
        reserved = self._estimate_tokens(SO_REPORT_SUMMARY_SYSTEM_PROMPT) + summary_max_tokens + 512
        budget_tokens = max(512, context_size - reserved)

        def build_user_content(logs_text: str, count: int, batch_note: str = "") -> str:
            return (
                "Rephrase and summarise the following logged occurrences into a flowing, "
                "narrative report draft summary written in proper English \u2014 like a "
                "short factual story \u2014 following the rules exactly.\n\n"
                f"Name / Entity: {client_display}\n"
                f"Reference No: {ref_no}\n"
                f"Date: {date_label}\n\n"
                f"{batch_note}"
                f"Occurrences ({count} source logs, chronological):\n"
                f"{logs_text}\n\n"
                "Write the narrative summary now as continuous prose paragraphs, using "
                "only the logs above."
            )

        chunks = self._chunk_by_token_budget(formatted_occurrences, budget_tokens)

        if len(chunks) <= 1:
            logs_text = "\n\n".join(formatted_occurrences)
            raw_summary = self._generate(
                SO_REPORT_SUMMARY_SYSTEM_PROMPT,
                build_user_content(logs_text, len(ordered)),
                max_tokens=summary_max_tokens,
            )
            return self._strip_summary_meta(raw_summary)

        # Map step: summarise each chronological batch into a partial narrative.
        partials = []
        for idx, chunk in enumerate(chunks, start=1):
            batch_note = (
                f"This is batch {idx} of {len(chunks)} (chronological). Summarise "
                "only these occurrences into narrative prose.\n\n"
            )
            logs_text = "\n\n".join(chunk)
            partial = self._generate(
                SO_REPORT_SUMMARY_SYSTEM_PROMPT,
                build_user_content(logs_text, len(chunk), batch_note),
                max_tokens=summary_max_tokens,
            )
            partials.append(self._strip_summary_meta(partial))

        # Reduce step: merge the partial narratives into one continuous account.
        raw_summary = self._reduce_partial_summaries(
            partials, budget_tokens, summary_max_tokens, client_display
        )
        return self._strip_summary_meta(raw_summary)

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """Conservative token estimate (~3.5 chars/token) for context budgeting."""
        if not text:
            return 0
        return int(len(text) / 3.5) + 1

    @staticmethod
    def _parse_processed_at(value) -> Optional[datetime]:
        text = str(value or "").strip()
        if not text:
            return None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None

    def _sort_entries_chronologically(self, entries: list[dict]) -> list[dict]:
        """Order Key SO Occurences entries earliest-first, as required for Chatbot answers."""
        return sorted(
            entries,
            key=lambda e: (self._parse_processed_at(e.get("processed_at", "")) or datetime.min),
        )

    def _group_entries_by_time_gap(self, ordered_entries: list[dict], gap_seconds: float) -> list[list[dict]]:
        """Group ordered entries into conversations that span no more than
        gap_seconds from their first timestamp. Entries with unparseable
        timestamps start their own group."""
        groups: list[list[dict]] = []
        current: list[dict] = []
        first_dt: Optional[datetime] = None
        for entry in ordered_entries:
            current_dt = self._parse_processed_at(entry.get("processed_at", ""))
            if not current:
                current = [entry]
                first_dt = current_dt
                continue
            within_gap = (
                current_dt is not None
                and first_dt is not None
                and (current_dt - first_dt).total_seconds() <= gap_seconds
            )
            if within_gap:
                current.append(entry)
            else:
                groups.append(current)
                current = [entry]
                first_dt = current_dt
        if current:
            groups.append(current)
        return groups

    def build_ai_merged_report(self, entries: list[dict], report_meta: Optional[dict] = None) -> dict:
        """Build a structured SO Report where occurrences within the configured
        time gap are merged into one row and the movements are rephrased by the
        model into proper English. Returns a dict with a 'rows' list (and an
        'error' key when the model is unavailable)."""
        report_meta = report_meta or {}
        subject = self._normalize_report_value(str(report_meta.get("subject", "")))
        ref_no = self._normalize_report_value(str(report_meta.get("ref_no", "")))
        date_value = self._format_report_date_label(str(report_meta.get("date", "")))
        client_display = (
            subject if subject != "Not available"
            else "(not provided \u2014 infer the main subject/client from the logs)"
        )

        base = {
            "title": "NORMAL REPORT",
            "date": date_value,
            "ref_no": ref_no,
            "subject": subject,
            "rows": [],
        }

        if not self.load():
            base["error"] = self.get_status()
            return base

        valid = []
        for entry in entries:
            content = str(entry.get("edited_content", "") or "").strip()
            if not content or content == "[No transcript text]":
                continue
            valid.append(entry)
        if not valid:
            return base

        ordered = sorted(
            valid,
            key=lambda e: (self._parse_processed_at(e.get("processed_at", "")) or datetime.min),
        )

        gap_minutes = float(config.get("ai_merge_gap_minutes", 5))
        gap_seconds = max(0.0, gap_minutes * 60.0)
        groups = self._group_entries_by_time_gap(ordered, gap_seconds)

        tag_pattern = re.compile(r"^\[[^\]]+\]\s*")
        row_max_tokens = int(config.get("ai_report_row_max_tokens", 256))

        rows = []
        for group in groups:
            start_label = self._format_report_time(group[0].get("processed_at", ""))
            end_label = self._format_report_time(group[-1].get("processed_at", ""))
            if len(group) == 1 or start_label == end_label:
                time_label = f"Between {start_label}\nto\n{start_label}"
            else:
                time_label = f"Between {start_label}\nto\n{end_label}"

            parts = []
            raw_texts = []
            for item in group:
                item_time = self._format_report_time(item.get("processed_at", ""))
                item_content = tag_pattern.sub("", str(item.get("edited_content", "") or "").strip())
                raw_texts.append(item_content)
                parts.append(f"[{item_time}] {item_content}")
            logs_text = "\n".join(parts)

            movement = self._phrase_movement_group(logs_text, client_display, row_max_tokens)
            if not movement:
                movement = " ".join(raw_texts).strip()

            combined_lower = (movement + " " + " ".join(raw_texts)).lower()
            rows.append({
                "time": self._normalize_report_value(time_label),
                "movements": self._normalize_report_value(movement),
                "remarks": "",
                "_is_termination": "terminate" in combined_lower,
            })

        termination = [r for r in rows if r.get("_is_termination")]
        regular = [r for r in rows if not r.get("_is_termination")]
        for r in termination + regular:
            r.pop("_is_termination", None)

        base["rows"] = regular + termination
        return base

    def build_ai_report_rows(self, entries: list[dict], report_meta: Optional[dict] = None) -> dict:
        """Incremental/resumable variant of build_ai_merged_report.

        Groups the given entries by the configured time gap and phrases each
        group's movements, but tags every returned row with the source entry
        ids it covers plus the raw start/end timestamps, and does NOT reorder
        termination rows. The caller (server) persists these rows and only
        feeds new (or tail-merge) entries here, so the model runs only on new
        data. Each entry MUST include an 'id'."""
        report_meta = report_meta or {}
        subject = self._normalize_report_value(str(report_meta.get("subject", "")))
        client_display = (
            subject if subject != "Not available"
            else "(not provided \u2014 infer the main subject/client from the logs)"
        )

        result: dict = {"rows": []}
        if not self.load():
            result["error"] = self.get_status()
            return result

        valid = []
        for entry in entries:
            content = str(entry.get("edited_content", "") or "").strip()
            if not content or content == "[No transcript text]":
                continue
            valid.append(entry)
        if not valid:
            return result

        ordered = sorted(
            valid,
            key=lambda e: (self._parse_processed_at(e.get("processed_at", "")) or datetime.min),
        )

        gap_minutes = float(config.get("ai_merge_gap_minutes", 5))
        gap_seconds = max(0.0, gap_minutes * 60.0)
        groups = self._group_entries_by_time_gap(ordered, gap_seconds)

        tag_pattern = re.compile(r"^\[[^\]]+\]\s*")
        row_max_tokens = int(config.get("ai_report_row_max_tokens", 256))
        # Keep LLM phrasing on by default, with deterministic fallback if
        # generation fails for any row.
        use_llm_for_rows = bool(config.get("ai_report_rows_enable_llm", True))

        rows = []
        total_groups = len(groups)
        print(f"[REPORTPROGRESS] start groups=0/{total_groups}", flush=True)
        for group_index, group in enumerate(groups, start=1):
            start_label = self._format_report_time(group[0].get("processed_at", ""))
            end_label = self._format_report_time(group[-1].get("processed_at", ""))
            if len(group) == 1 or start_label == end_label:
                time_label = f"Between {start_label}\nto\n{start_label}"
            else:
                time_label = f"Between {start_label}\nto\n{end_label}"

            parts = []
            raw_texts = []
            for item in group:
                item_time = self._format_report_time(item.get("processed_at", ""))
                item_content = tag_pattern.sub("", str(item.get("edited_content", "") or "").strip())
                raw_texts.append(item_content)
                parts.append(f"[{item_time}] {item_content}")
            logs_text = "\n".join(parts)

            if use_llm_for_rows:
                movement = self._phrase_movement_group(logs_text, client_display, row_max_tokens)
                if not movement:
                    movement = self._compose_report_movement_fallback(raw_texts)
            else:
                movement = self._compose_report_movement_fallback(raw_texts)

            movement = self._enforce_vehicle_plate_format(movement, logs_text)

            rows.append({
                "time": self._normalize_report_value(time_label),
                "movements": self._normalize_report_value(movement),
                "remarks": "",
                "source_ids": [e.get("id") for e in group if e.get("id") is not None],
                "time_start": str(group[0].get("processed_at", "") or ""),
                "time_end": str(group[-1].get("processed_at", "") or ""),
            })
            print(f"[REPORTPROGRESS] done groups={group_index}/{total_groups}", flush=True)

        result["rows"] = rows
        return result

    def _compose_report_movement_fallback(self, raw_texts: list[str]) -> str:
        """Build one stable movement paragraph without model generation."""
        pieces = []
        for raw in raw_texts:
            text = re.sub(r"\s+", " ", str(raw or "")).strip()
            if not text:
                continue
            text = self._polish_factual_source(text)
            if text[-1] not in ".!?":
                text += "."
            pieces.append(text)
        if len(pieces) < 2:
            return " ".join(pieces).strip()
        return " ".join([pieces[0]] + [f"Thereafter, {piece[0].lower() + piece[1:]}" for piece in pieces[1:]])

    @staticmethod
    def _polish_factual_source(text: str) -> str:
        """Make narrow grammar-only corrections to a source occurrence."""
        result = str(text or "").strip()
        result = re.sub(r"^SO\s+ready\s+at\b", "The SO was ready at", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+seen\b", "The Subject was seen", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+observed\b", "The Subject was observed", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+walking\b", "The Subject was walking", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+waiting\b", "The Subject was waiting", result, flags=re.IGNORECASE)
        result = re.sub(r"^They\s+walking\b", "They walked", result, flags=re.IGNORECASE)
        result = re.sub(r"^They\s+waiting\b", "They waited", result, flags=re.IGNORECASE)
        result = re.sub(r"^They\s+entered\b", "They entered", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+entered\s+car\b", "The Subject entered the car", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+boarded\s+car\b", "The Subject boarded the car", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+parked\s+known\s+car\b", "The Subject parked his known car", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+seated\s+on\s+bench\b", "The Subject was seated on a bench", result, flags=re.IGNORECASE)
        result = re.sub(r"^Subject\s+walked\s+towards\b", "The Subject walked towards", result, flags=re.IGNORECASE)
        result = re.sub(r"\bat\s+basement\s+car\s+park\s+lot\b", "at the basement car park lot", result, flags=re.IGNORECASE)
        result = re.sub(r"\bknown\s+car\s+(\[?[A-Z]{2,3}\s*\d{3,4}\s*[A-Z]\]?)\s+the\s+basement\s+car\s+park\s+lot\b", r"known car \1 at the basement car park lot", result, flags=re.IGNORECASE)
        result = re.sub(r"\btaking\s+video\s+(\d+)\s+degrees\s+around\s+surrounding\b", r"taking a \1-degree video of the surroundings", result, flags=re.IGNORECASE)
        result = re.sub(r"\bwas\s+seated\s+on\s+a\s+bench\s+and\s+taking\b", "was seated on a bench and took", result, flags=re.IGNORECASE)
        result = re.sub(r"\bknown\s+car\s+([A-Z]{2,3}\s*\d{3,4}\s*[A-Z])\b", r"known car [\1]", result, flags=re.IGNORECASE)
        result = re.sub(r"\bwith\s+client\b", "with the client", result, flags=re.IGNORECASE)
        result = re.sub(r"\bat\s+carpark\b", "at the carpark", result, flags=re.IGNORECASE)
        result = re.sub(r"\bto\s+carpark\b", "to the carpark", result, flags=re.IGNORECASE)
        return result[:1].upper() + result[1:] if result else result

    @staticmethod
    def _mask_report_facts(text: str) -> tuple[str, dict[str, str]]:
        """Hide immutable facts from the rewriter and restore them afterward."""
        source = str(text or "")
        patterns = (
            r"\bS\(\d{6}\)\b",
            r"\bS[A-Z]{1,2}\s*\d{1,4}\s*[A-Z]\b",
            r"\b(?:Blk|Block)\s+\d+\w*\b",
            r"\bNo\.\s*\d+(?:\s+[A-Z][\w.-]*)*",
            r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b",
        )
        matches = []
        for pattern in patterns:
            matches.extend(re.finditer(pattern, source))
        replacements = []
        for match in sorted(matches, key=lambda item: (item.start(), -(item.end() - item.start()))):
            if any(match.start() >= start and match.end() <= end for start, end, _ in replacements):
                continue
            replacements.append((match.start(), match.end(), match.group(0)))

        masked = source
        facts: dict[str, str] = {}
        for index, (start, end, value) in enumerate(reversed(replacements), start=1):
            token = f"<FACT_{index}>"
            masked = masked[:start] + token + masked[end:]
            facts[token] = value
        return masked, facts

    @staticmethod
    def _restore_report_facts(text: str, facts: dict[str, str]) -> str:
        result = str(text or "")
        for token, value in facts.items():
            result = re.sub(re.escape(token), value, result, flags=re.IGNORECASE)
        return result

    @staticmethod
    def _keep_factual_rephrase(text: str, source_text: str) -> str:
        """Reject LLM wording that drops explicit identifiers or numbers."""
        source_segments = re.split(r"\[[^\]]+\]\s*", str(source_text or ""))
        source_segments = [re.sub(r"\s+", " ", segment).strip() for segment in source_segments]
        source_segments = [segment for segment in source_segments if segment]
        source = " ".join(source_segments)
        source = re.sub(r"\s+", " ", source).strip()
        output = re.sub(r"\s+", " ", str(text or "")).strip()
        if not output or not source:
            return output

        protected_facts = re.findall(r"\b[A-Z]{2,}\s*\d{3,4}[A-Z]\b|\bS\(\d{6}\)\b", source)
        grammar_words = {
            "a", "an", "and", "are", "as", "at", "be", "been", "before", "by",
            "for", "from", "had", "has", "have", "he", "her", "him", "his", "in",
            "is", "it", "its", "of", "on", "she", "that", "the", "their", "them",
            "then", "thereafter", "they", "this", "to", "was", "were", "which", "with",
            "after", "afterwards", "following", "subsequently", "while", "who",
        }
        source_words = set(re.findall(r"[a-z]+", source.lower()))
        source_prefixes = {word[:4] for word in source_words if len(word) >= 4}
        output_words = set(re.findall(r"[a-z]+", output.lower()))
        source_numbers = re.findall(r"\d+", source)
        output_numbers = re.findall(r"\d+", output)
        missing_fact = any(fact.lower() not in output.lower() for fact in protected_facts)
        has_new_number = any(number not in source_numbers for number in output_numbers)
        has_new_content = any(
            word not in source_words
            and word not in grammar_words
            and (len(word) < 4 or word[:4] not in source_prefixes)
            for word in output_words
        )
        if missing_fact or has_new_number or has_new_content:
            sentences = []
            for segment in source_segments:
                segment = GPT4AllAssistant._polish_factual_source(segment)
                sentences.append(segment if segment[-1:] in ".!?" else segment + ".")
            if len(sentences) < 2:
                return " ".join(sentences)
            connectors = ("Thereafter", "Subsequently", "Afterwards")
            follow_ups = [
                f"{connectors[index % len(connectors)]}, {sentence[0].lower() + sentence[1:]}"
                for index, sentence in enumerate(sentences[1:])
            ]
            return " ".join([sentences[0]] + follow_ups)
        output = re.sub(
            r"(\b(?:known\s+)?(?:car|vehicle)\s+\[?[A-Z]{2,3}\s*\d{3,4}\s*[A-Z]\]?)(?:\s+)the\s+basement\s+car\s+park\s+lot\b",
            r"\1 at the basement car park lot",
            output,
            flags=re.IGNORECASE,
        )
        return output

    def _phrase_movement_group(
        self,
        logs_text: str,
        client_display: str,
        max_tokens: int,
    ) -> str:
        """Rephrase one merged time window's log(s) into a single Movements cell."""
        use_compact = bool(config.get("ai_report_row_compact_prompt", False))
        if use_compact:
            source_word_count = len(re.findall(r"\S+", logs_text))
            generation_limit = min(max_tokens, max(64, source_word_count * 2))
            user_content = (
                "Rephrase only these Key SO occurrences into one polished report "
                "paragraph. Keep their meaning and chronological order. Do not "
                "mention clock times or relative timing; the Time column shows it.\n\n"
                f"Key SO occurrences:\n{logs_text}\n\n"
                "Rephrased paragraph:"
            )
            out = self._generate(
                SO_REPORT_ROW_SYSTEM_PROMPT_COMPACT, user_content,
                max_tokens=generation_limit, temperature=0.0,
            )
            cleaned = self._truncate_at_meta(out)
            cleaned = self._strip_summary_meta(cleaned)
            cleaned = self._strip_echoed_logs(cleaned)
            cleaned = self._strip_prompt_echo(
                cleaned, SO_REPORT_ROW_SYSTEM_PROMPT_COMPACT, user_content
            )
            cleaned = re.sub(r"\b(?:at\s+)?\d{1,2}[:.]\d{2}\s*(?:hrs?|hours?)?\b", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\b(?:at\s+)?\d{3,4}\s*(?:hrs?|hours?)\b", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\bAt\s+approximately\s*(?=[,.;]|$)", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"^\s*At\s+approximately\s+the\s+same\s+time\s*[,;:-]?\s*", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,")
            if re.search(r"\bSO\b", logs_text):
                cleaned = re.sub(r"\b(?:a\s+)?(?:police\s+)?officer\s*\(\s*SO\s*\)", "SO", cleaned, flags=re.IGNORECASE)
                cleaned = re.sub(r"\bSituation\s+Officer\b", "SO", cleaned, flags=re.IGNORECASE)
            cleaned = self._enforce_vehicle_plate_format(cleaned, logs_text)
            if cleaned.lower().startswith("generation error"):
                return ""
            return cleaned
        user_content = (
            "Combine and rephrase the following SO Report draft log line(s) from one "
            "time window into a single Movements entry in proper English. Correct "
            "ordinary spelling, capitalization, and punctuation. Keep every "
            "fact exactly as written \u2014 only reword and merge them. Do NOT infer or "
            "add any action, purchase, arrival, departure, or outcome that is not "
            "explicitly stated in the lines. Do NOT add safety/condition qualifiers "
            "such as 'safely', 'successfully', 'peacefully', 'without incident', or "
            "'uneventfully' unless those words or facts are present in the source. Do NOT omit any explicitly stated action "
            "or observed behavior from any source line, including return movements "
            "such as 'returned home' or 'returned to [location]'. The lines are already in "
            "chronological order; compose the answer by processing the lines from "
            "top to bottom. The first source line's event must appear first in the "
            "Movements entry, followed by the second source line's event, then the "
            "third, and so on. Do not move later events before earlier events. For "
            "multiple source lines, include one clause or sentence for EACH source "
            "line in the same order, even when the facts seem repetitive. Write one natural, polished paragraph; "
            "avoid choppy copied fragments, awkward repeated nouns, or broken phrasing. Use normal connectors "
            "such as 'thereafter', 'subsequently', 'after which' and 'following which' only when they preserve the exact order. "
            "Write one plain paragraph of "
            "prose only: "
            "no labels, no 'Client', 'Location', 'Time', or 'Movements' headers, and "
            "no closing note or explanation. Do NOT restate, quote, or echo the log "
            "line(s), their bracketed times, or this request \u2014 output only the "
            "final rephrased paragraph.\n\n"
            f"Log line(s):\n{logs_text}\n\n"
            "Movements entry:"
        )
        out = self._generate(SO_REPORT_ROW_SYSTEM_PROMPT, user_content, max_tokens=max_tokens,
                              temperature=0.0)
        cleaned = self._truncate_at_meta(out)
        cleaned = self._strip_summary_meta(cleaned)
        cleaned = self._strip_echoed_logs(cleaned)
        cleaned = self._strip_prompt_echo(cleaned, SO_REPORT_ROW_SYSTEM_PROMPT, user_content)
        cleaned = self._enforce_vehicle_plate_format(cleaned, logs_text)
        cleaned = self._keep_factual_rephrase(cleaned, logs_text)
        if cleaned.lower().startswith("generation error"):
            return ""
        return cleaned

    @staticmethod
    def _enforce_vehicle_plate_format(text: str, source_text: str) -> str:
        """Apply the required vehicle [plate] format only for explicit source pairs."""
        output = str(text or "")
        source = str(source_text or "")

        _stopwords = {
            "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at",
            "for", "with", "his", "her", "he", "she", "they", "them", "was",
            "were", "is", "are", "be", "been", "being", "before", "after",
            "then", "together", "both", "this", "that", "from", "into", "by",
            "as", "it", "its", "their", "subject", "who", "had", "has", "have",
            "not", "seen", "were",
        }

        def _content_words(text: str) -> list[str]:
            words = re.findall(r"[a-z]+", str(text or "").lower())
            return [w for w in words if len(w) >= 3 and w not in _stopwords]

        def _restore_omitted_actions(out_text: str, src_text: str) -> str:
            """Ensure every source segment is reflected in source order."""
            segments = re.split(r"\[[^\]]+\]\s*", str(src_text or ""))
            segments = [s.strip() for s in segments if s.strip()]
            sentences = re.findall(r"[^.!?]+[.!?]?", str(out_text or ""))
            sentences = [s.strip() for s in sentences if s.strip()]
            if not segments or not sentences:
                return out_text
            vehicle_words = {"car", "PHV", "vehicle", "van", "truck", "lorry", "motorcycle", "motorbike", "bike", "bus", "taxi", "sedan", "suv"}
            plate_words = set()
            for plate_value in source_plates:
                plate_words.update(re.findall(r"[a-z]+", plate_value.lower()))
            out_items = []
            used_sentence_indexes = set()
            for seg in segments:
                seg_words = _content_words(seg)
                if len(seg_words) < 2:
                    continue
                seg_prefixes = {w[:4] for w in seg_words}
                action_prefixes = {w[:4] for w in seg_words if w not in vehicle_words and w not in plate_words}
                best_index, best_score = None, 0
                best_action_overlap = 0
                for idx, sentence in enumerate(sentences):
                    sentence_prefixes = {w[:4] for w in _content_words(sentence)}
                    score = len(seg_prefixes & sentence_prefixes)
                    action_overlap = len(action_prefixes & sentence_prefixes)
                    if score > best_score:
                        best_index, best_score = idx, score
                        best_action_overlap = action_overlap
                matched = best_score
                ratio = matched / len(seg_words)
                required_ratio = 0.67 if len(seg_words) <= 3 else 0.4
                if ratio >= required_ratio and best_index is not None and (not action_prefixes or best_action_overlap > 0):
                    if best_index in used_sentence_indexes:
                        continue
                    used_sentence_indexes.add(best_index)
                    sentence = sentences[best_index]
                    if sentence and sentence[-1] not in ".!?":
                        sentence += "."
                    out_items.append(sentence)
                else:
                    snippet = seg.strip()
                    if snippet and snippet[-1] not in ".!?":
                        snippet += "."
                    if snippet and snippet[0].islower():
                        snippet = snippet[0].upper() + snippet[1:]
                    out_items.append(snippet)
            if not out_items:
                return out_text
            return " ".join(out_items).strip()

        def _polish_generated_prose(out_text: str) -> str:
            polished = str(out_text or "")
            unsupported_qualifiers = ("safely", "successfully", "peacefully", "uneventfully")
            source_lower = source.lower()
            for qualifier in unsupported_qualifiers:
                if qualifier not in source_lower:
                    polished = re.sub(rf"\b{qualifier}\b\s*", "", polished, flags=re.IGNORECASE)
            if "without incident" not in source_lower:
                polished = re.sub(r"\bwithout incident\b\s*", "", polished, flags=re.IGNORECASE)
            polished = re.sub(r"\bSubject\b", "the Subject", polished)
            polished = re.sub(r"\bthe\s+the\s+Subject\b", "the Subject", polished, flags=re.IGNORECASE)
            polished = re.sub(r"\b(he|she|they)\s+boarded\s+his\s+car\s*,\s*([A-Z]{1,3}\s*\d{1,4}\s*[A-Z])", r"the Subject boarded his car [\2]", polished, flags=re.IGNORECASE)
            polished = re.sub(r"\bthe\s+car\s+\[([A-Z]{1,3}\s*\d{1,4}\s*[A-Z])\]\s+departed", r"The car then departed", polished, flags=re.IGNORECASE)
            polished = re.sub(r"\bSubject\s+then\b", "The Subject then", polished)
            polished = re.sub(r"(\[[A-Z]{1,3}\s*\d{1,4}\s*[A-Z]\])\s+(?=The\s+(?:car|vehicle)\b)", r"\1. ", polished)
            polished = re.sub(r"\s+", " ", polished).strip()
            sentences = re.findall(r"[^.!?]+[.!?]?", polished)
            duplicate_noise = {"then", "there", "thereafter", "subsequently", "following", "this"}
            seen = set()
            deduped = []
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue
                sentence = re.sub(r"^the Subject\b", "The Subject", sentence)
                sentence = re.sub(r"^the car\b", "The car", sentence)
                words = [w[:5] for w in _content_words(sentence) if w not in duplicate_noise]
                key = " ".join(words)
                if key in seen:
                    continue
                if any(key and (key in existing or existing in key) for existing in seen):
                    continue
                seen.add(key)
                if sentence[-1] not in ".!?":
                    sentence += "."
                deduped.append(sentence)
            return " ".join(deduped).strip() if deduped else polished

        def _normalize_source_plate_displays(out_text: str) -> str:
            fixed = str(out_text or "")
            for plate_key, display in source_plate_displays.items():
                digit_match = re.match(r"([A-Z]+)(\d+)([A-Z])$", plate_key)
                if digit_match:
                    letters, digits, suffix = digit_match.groups()
                    flexible = re.escape(letters) + r"\s*" + re.escape(digits) + r"\s*" + re.escape(suffix)
                else:
                    flexible = re.escape(plate_key)
                fixed = re.sub(rf"\[\s*{flexible}\s*\]", "[" + display + "]", fixed, flags=re.IGNORECASE)
                first = re.search(rf"\[\s*{re.escape(display)}\s*\]", fixed, flags=re.IGNORECASE)
                if first:
                    head, tail = fixed[: first.end()], fixed[first.end() :]
                    tail = re.sub(rf"\s*\[\s*{re.escape(display)}\s*\]", "", tail, flags=re.IGNORECASE)
                    tail = re.sub(rf",?\s*(?:and\s+)?\b{flexible}\b", "", tail, flags=re.IGNORECASE)
                    fixed = head + tail
                    fixed = re.sub(r"\s*\[\s*\]", "", fixed)
            return fixed

        def _restore_proper_nouns(out_text: str, src_text: str) -> str:
            """Detect any multi-word proper noun (place/name) from the source
            that got garbled in the output and repair it to the source spelling.
            Generic fuzzy match — no specific names are hardcoded."""
            candidates = re.findall(r"\b[A-Z][a-zA-Z]*(?:\s+[A-Z0-9][a-zA-Z0-9]*){1,3}\b", src_text)
            ordered = sorted(set(candidates), key=len, reverse=True)
            out_words = out_text.split()
            for phrase in ordered:
                if phrase in out_text:
                    continue
                phrase_words = phrase.split()
                n = len(phrase_words)
                best_ratio, best_span = 0.0, None
                for i in range(len(out_words) - n + 1):
                    window = " ".join(out_words[i:i + n])
                    ratio = difflib.SequenceMatcher(None, window.lower(), phrase.lower()).ratio()
                    if ratio > best_ratio:
                        best_ratio, best_span = ratio, (i, i + n)
                if best_span and 0.72 <= best_ratio < 1.0:
                    i, j = best_span
                    out_words[i:j] = phrase_words
            return " ".join(out_words)

        vehicle_types = (
            "car|vehicle|van|truck|lorry|PHV|motorcycle|motorbike|bike|bus|taxi|sedan|suv"
        )
        plate = r"[A-Z]{1,3}\s*\d{1,4}\s*[A-Z]"
        # Restrict standalone extraction to common Singapore plate shape to
        # avoid false positives from address fragments (e.g. AVE3S).
        sg_plate = r"S[A-Z]{1,2}\s*\d{1,4}\s*[A-Z]"
        pair_pattern = re.compile(
            rf"\b({vehicle_types})\b[^\n.;:(){{}}]{{0,40}}\b({plate})\b|"
            rf"\b({plate})\b[^\n.;:(){{}}]{{0,40}}\b({vehicle_types})\b",
            re.IGNORECASE,
        )
        pairs = []
        for match in pair_pattern.finditer(source):
            groups = [group for group in match.groups() if group]
            if len(groups) < 2:
                continue
            first, second = groups[0], groups[1]
            if re.fullmatch(plate, first, re.IGNORECASE):
                plate_value, vehicle_type = first, second
            else:
                vehicle_type, plate_value = first, second
            plate_key = re.sub(r"\s+", "", plate_value).upper()
            plate_display = re.sub(r"\s+", " ", plate_value).strip().upper()
            pair = (vehicle_type.lower(), plate_key, plate_display)
            if pair not in pairs:
                pairs.append(pair)

        for vehicle_type, plate_value, plate_display in pairs:
            formatted = f"{vehicle_type} [{plate_display}]"
            digit_match = re.match(r"([A-Z]+)(\d+)([A-Z])$", plate_value)
            if digit_match:
                letters, digits, suffix = digit_match.groups()
                flexible_plate = re.escape(letters) + r"\s*" + re.escape(digits) + r"\s*" + re.escape(suffix)
            else:
                flexible_plate = re.escape(plate_value)
            output = re.sub(
                rf"\b{re.escape(vehicle_type)}\b\s*(?:\[\s*)?{flexible_plate}(?:\s*\])?",
                formatted,
                output,
                flags=re.IGNORECASE,
            )
            if formatted.lower() not in output.lower() and re.search(rf"\b{flexible_plate}\b", output, re.IGNORECASE):
                output = re.sub(rf"\b{flexible_plate}\b", formatted, output, count=1, flags=re.IGNORECASE)
            elif formatted.lower() not in output.lower() and re.search(rf"\b{re.escape(vehicle_type)}\b", output, re.IGNORECASE):
                output = re.sub(
                    rf"\b{re.escape(vehicle_type)}\b",
                    formatted,
                    output,
                    count=1,
                    flags=re.IGNORECASE,
                )

        # If logs contain a standalone plate (without explicit vehicle type),
        # still force a deterministic output format for readability.
        source_plates = []
        source_plate_displays = {}
        for m in re.finditer(rf"\b({sg_plate})\b", source, re.IGNORECASE):
            p = re.sub(r"\s+", "", m.group(1)).upper()
            if p not in source_plates:
                source_plates.append(p)
                source_plate_displays[p] = re.sub(r"\s+", " ", m.group(1)).strip().upper()
        for p in source_plates:
            display = source_plate_displays.get(p, p)
            digit_match = re.match(r"([A-Z]+)(\d+)([A-Z])$", p)
            if digit_match:
                letters, digits, suffix = digit_match.groups()
                flexible_plate = re.escape(letters) + r"\s*" + re.escape(digits) + r"\s*" + re.escape(suffix)
            else:
                flexible_plate = re.escape(p)
            output = re.sub(rf"\[\s*{flexible_plate}\s*\]", "[" + display + "]", output, flags=re.IGNORECASE)
            if re.search(rf"\b(?:car|vehicle|van|truck|lorry|motorcycle|motorbike|bike|bus|PHV|taxi|sedan|suv)\s*\[\s*{flexible_plate}\s*\]", output, re.IGNORECASE):
                continue
            # Avoid wrapping content that is already bracketed.
            output = re.sub(rf"\[(\s*{flexible_plate}\s*)\]", lambda m: "[" + display + "]", output, flags=re.IGNORECASE)
            if re.search(rf"\b{flexible_plate}\b", output, re.IGNORECASE):
                output = re.sub(rf"\b{flexible_plate}\b", f"car [{display}]", output, count=1, flags=re.IGNORECASE)

        # Remove accidental car [XXXX] wrappers that are not backed by source
        # plates (e.g. AVE3S from address fragments).
        allowed = set(source_plates)
        def _strip_invalid_vehicle_wrapper(match: re.Match) -> str:
            plate_value = re.sub(r"\s+", "", match.group(1)).upper()
            if plate_value in allowed:
                return f"car [{plate_value}]"
            return plate_value
        output = re.sub(
            r"\bcar\s*\[\s*([A-Z]{1,3}\s*\d{1,4}\s*[A-Z])\s*\]",
            _strip_invalid_vehicle_wrapper,
            output,
            flags=re.IGNORECASE,
        )
        # Collapse nested wrappers from prior bad generations.
        output = re.sub(r"\[(\s*car\s*\[[^\]]+\]\s*)\]", lambda m: m.group(1).strip(), output, flags=re.IGNORECASE)
        # Drop invalid pseudo-plate fragments left beside a valid SG plate token.
        output = re.sub(
            r"\b(?!S[A-Z]{1,2}\d{1,4}[A-Z]\b)[A-Z]{3}\d[A-Z]\b\s+(?=car\s*\[S[A-Z]{1,2}\d{1,4}[A-Z]\])",
            "",
            output,
            flags=re.IGNORECASE,
        )
        # De-duplicate a plate mention: keep only the first (bracketed) mention
        # and drop any later bare repeat of the same plate — the model
        # sometimes echoes a plate twice when the source logs repeat it.
        for plate_value in set(p for _, p, _display in pairs) | set(source_plates):
            digit_match = re.match(r"([A-Z]+)(\d+)([A-Z])$", plate_value)
            if digit_match:
                letters, digits, suffix = digit_match.groups()
                flexible = re.escape(letters) + r"\s*" + re.escape(digits) + r"\s*" + re.escape(suffix)
            else:
                flexible = re.escape(plate_value)
            bracket_match = re.search(rf"\[\s*{flexible}\s*\]", output, re.IGNORECASE)
            if not bracket_match:
                continue
            head, tail = output[: bracket_match.end()], output[bracket_match.end() :]
            tail = re.sub(rf",?\s*(?:and\s+)?\b{flexible}\b", "", tail, flags=re.IGNORECASE)
            output = head + tail
        output = re.sub(r"\b(car|vehicle)\s*\[\s*\]", r"\1", output, flags=re.IGNORECASE)

        # Repair any proper noun (place/name) garbled during generation —
        # detected generically by fuzzy-matching against the source, no
        # specific names hardcoded. Runs before Block/Avenue normalization so
        # those deterministic rules always have the final say.
        output = _restore_proper_nouns(output, source)

        # Always normalize Block to Blk regardless of vehicle formatting matches.
        output = re.sub(r"Block\s+(\d+)", lambda match: "Blk " + match.group(1), output, flags=re.IGNORECASE)
        # Street/Avenue numbers must stay numeric, never spelled out as words.
        _number_words = {
            "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
            "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
            "eleven": "11", "twelve": "12",
        }
        output = re.sub(
            r"\b(Avenue|Street|Ave|St)\s+(" + "|".join(_number_words) + r")\b",
            lambda m: f"{m.group(1)} {_number_words[m.group(2).lower()]}",
            output,
            flags=re.IGNORECASE,
        )
        # Postal format rule: "Singapore (542123)" -> "S(542123)"
        output = re.sub(r"\b(?:in\s+)?Singapore\s*\((\d{6})\)", r"S(\1)", output, flags=re.IGNORECASE)
        output = _polish_generated_prose(output)
        output = _normalize_source_plate_displays(output)
        return output

    def _chunk_by_token_budget(self, items: list[str], budget_tokens: int) -> list[list[str]]:
        """Group text items into chunks whose combined estimated token count
        stays within budget_tokens. A single oversized item is kept alone."""
        chunks: list[list[str]] = []
        current: list[str] = []
        current_tokens = 0
        for item in items:
            item_tokens = self._estimate_tokens(item) + 2
            if current and current_tokens + item_tokens > budget_tokens:
                chunks.append(current)
                current = []
                current_tokens = 0
            current.append(item)
            current_tokens += item_tokens
        if current:
            chunks.append(current)
        return chunks

    def _reduce_partial_summaries(
        self, partials: list[str], budget_tokens: int, summary_max_tokens: int,
        client_display: str = ""
    ) -> str:
        """Fold batch-level narrative summaries into one chronological narrative,
        merging in budget-sized groups so no reduce prompt overflows the window."""
        current = [p for p in partials if p and p.strip()]
        if not current:
            return ""
        client_line = f"Client (Subject): {client_display}\n\n" if client_display else ""

        while len(current) > 1:
            groups = self._chunk_by_token_budget(current, budget_tokens)
            if len(groups) == len(current):
                # Each partial already fills the budget alone; force pairs so the
                # reduction can still make progress.
                groups = [current[i : i + 2] for i in range(0, len(current), 2)]
            merged = []
            for group in groups:
                if len(group) == 1:
                    merged.append(group[0])
                    continue
                combined = "\n\n".join(group)
                reduce_content = (
                    "Combine the following partial SO Report narrative summaries into "
                    "one seamless, chronological narrative in proper English, following "
                    "the rules exactly. Keep the narrative framed around the client "
                    "(Subject) below. Preserve every factual detail (times, call signs, "
                    "code names, locations, actions) and remove any repetition. Do not "
                    "add new information.\n\n"
                    f"{client_line}"
                    f"Partial summaries:\n{combined}\n\n"
                    "Write the merged narrative now as continuous prose paragraphs."
                )
                out = self._generate(
                    SO_REPORT_SUMMARY_SYSTEM_PROMPT, reduce_content, max_tokens=summary_max_tokens
                )
                merged.append(self._strip_summary_meta(out))
            current = merged
        return current[0]

    @staticmethod
    def _dedupe_and_clean_answer(text: str) -> str:
        """Drop '(Note: ...)' asides and stop at the first repeated paragraph.

        The small model sometimes loops, re-emitting the same paragraph (each
        wrapped in a 'Note: this response has been edited...' aside) until it
        hits the token limit. Keep only the first, clean occurrence.
        """
        if not text:
            return text
        normalized = text.replace("\r\n", "\n").strip()
        blocks = [b.strip() for b in re.split(r"\n\s*\n", normalized) if b.strip()]
        seen = set()
        kept = []
        for block in blocks:
            if re.match(r"^\(?\s*note\s*[:\)]", block, flags=re.IGNORECASE):
                continue
            key = re.sub(r"\s+", " ", block).strip().lower()
            if key in seen:
                break  # the model started looping; discard everything after
            seen.add(key)
            kept.append(block)
        cleaned = "\n\n".join(kept).strip()
        return cleaned if cleaned else normalized

    @staticmethod
    def _strip_summary_meta(text: str) -> str:
        """Remove any chatty preamble, role headings, sign-offs, notes, or
        disclaimers the model may wrap around the narrative summary, leaving
        only the factual prose."""
        if not text:
            return text
        normalized = text.replace("\r\n", "\n")
        # The model tends to append notes/disclaimers after a horizontal rule
        # ('---', '***', '===', '___'). Cut everything from the first such rule.
        rule_match = re.search(r"^\s*[-*_=]{3,}\s*$", normalized, flags=re.MULTILINE)
        if rule_match:
            normalized = normalized[: rule_match.start()]
        meta_markers = (
            "i'm glad", "i am glad", "let me know", "please let me know",
            "if you have more", "this response is a simulation",
            "this is a simulation", "feel free to", "as an ai",
            "assist further", "meet your expectations", "hope this helps",
            "happy to help", "if you need",
            "i have kept", "i kept all", "i've kept", "rephrasing them",
            "the movements entry", "combines multiple log", "without any radio",
        )
        # Leaked label/scaffold prefixes the small model sometimes echoes.
        label_prefixes = (
            "client (subject)", "client:", "client ", "subject:", "location:",
            "time:", "date:", "ref no", "movements:", "note that", "note:",
        )
        kept = []
        for raw in normalized.split("\n"):
            line = raw.strip()
            low = line.lower()
            if line.startswith("#"):
                continue
            if low.startswith("**note"):
                continue
            if low.startswith("summary:") or low.startswith("here is") or low.startswith("here's"):
                continue
            if any(low.startswith(prefix) for prefix in label_prefixes):
                continue
            if any(marker in low for marker in meta_markers):
                continue
            kept.append(raw)
        cleaned = "\n".join(kept).strip()
        # Remove stray markdown/delimiter hash runs the model appends (e.g. '###').
        cleaned = re.sub(r"#{2,}", "", cleaned)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned).strip()
        return cleaned if cleaned else text.strip()

    @staticmethod
    def _strip_echoed_logs(text: str) -> str:
        """Remove any restated input log lines / times / instructions the small
        model sometimes echoes before the actual Movements paragraph, keeping
        only the final rephrased text."""
        if not text:
            return text
        result = text.replace("\r\n", "\n").strip()
        # Phrases that only appear when the model echoes the prompt/instructions.
        # Cut everything up to and including the LAST such marker so only the
        # final answer that follows the echoed preamble remains.
        end_markers = (
            "movements entry:", "read smoothly.", "read smoothly",
            "rephrase them", "combine every fact", "combine and rephrase",
            "keep every fact", "the log line(s):", "log line(s):",
            "one time window", "the given log lines", "given log line(s):",
        )
        low = result.lower()
        cut = -1
        for marker in end_markers:
            idx = low.rfind(marker)
            if idx != -1:
                cut = max(cut, idx + len(marker))
        if cut != -1:
            candidate = result[cut:].strip(" \t\n:.-\u2014")
            if len(candidate) >= 15:
                result = candidate
        # Drop any leftover bracketed time tags such as '[0947 hrs]' / '[0947]'.
        result = re.sub(r"\[\s*\d{3,4}\s*(?:hrs?|hours?|h)?\s*\]", "", result,
                        flags=re.IGNORECASE)
        result = re.sub(r"[ \t]{2,}", " ", result).strip()
        return result if result else text.strip()

    @staticmethod
    def _truncate_at_meta(text: str) -> str:
        """Cut the model output at the first post-answer meta marker.

        The 8B tends to write the real answer, then append commentary that
        restates the rules ('### Note: ... keep every fact exactly as written:
        people, names, call signs...'), a 'The final answer is:' line, and a
        duplicate of the answer. Everything from the first such marker on is
        noise, so keep only the leading answer.
        """
        if not text:
            return text
        t = text.replace("\r\n", "\n")
        boundaries = (
            r"#{2,}",              # '###' section separators the model emits
            r"\bthe final answer\b",
            r"\bnote\s+to\s+self\s*:",
            r"\bnote\s*:",
            r"\*\*note",
            r"\bthis response\b",
            r"\bi have kept\b",
            r"\bi kept\b",
        )
        cut = len(t)
        for pat in boundaries:
            m = re.search(pat, t, flags=re.IGNORECASE)
            if m:
                cut = min(cut, m.start())
        return t[:cut].strip()

    @staticmethod
    def _strip_prompt_echo(text: str, *prompts: str) -> str:
        """Remove sentences the model copied verbatim from the system/user prompt.

        The small model sometimes regurgitates the instruction rules themselves
        (e.g. 'Do not remove any detail...', '1c. Do NOT include clock times...')
        instead of the answer. This drops any fragment that appears verbatim in
        the supplied prompt text, so it works for ANY echoed rule, not fixed
        markers. Genuine Movements prose is never a substring of the prompt.
        """
        if not text:
            return text

        def _norm(s: str) -> str:
            return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (s or "").lower())).strip()

        prompt_blob = _norm(" ".join(prompts))
        if not prompt_blob:
            return text

        result = text.replace("\r\n", "\n").strip()
        fragments = re.split(r"(?<=[.!?])\s+|\n+", result)
        kept = []
        for frag in fragments:
            f = frag.strip()
            if not f:
                continue
            # Numbered rule markers ('1.', '1c.', '2)') are never real answer text.
            if re.match(r"^\d+[a-z]?[.)]", f):
                continue
            nf = _norm(f)
            if len(nf) >= 12 and nf in prompt_blob:
                continue
            kept.append(f)
        cleaned = re.sub(r"[ \t]{2,}", " ", " ".join(kept)).strip()
        return cleaned if cleaned else text.strip()

    def _is_yes_no_fact_question(self, question: str) -> bool:
        question_lower = (question or '').strip().lower()
        if not question_lower:
            return False

        starters = (
            'was ', 'were ', 'is ', 'are ', 'did ', 'does ', 'do ',
            'has ', 'have ', 'can '
        )
        return question_lower.startswith(starters)

    def _merge_unique_logs(self, entries: list[dict]) -> list[dict]:
        merged = []
        seen = set()
        for entry in entries:
            key = (
                entry.get('id', ''),
                entry.get('filename', ''),
                entry.get('processed_at', ''),
                entry.get('edited_content', '')
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(entry)
        return merged

    def _find_must_include_logs(self, question: str, entries: list[dict], max_items: Optional[int] = 4) -> list[dict]:
        """Force include explicit evidence rows for direct fact questions."""
        if not question or not entries:
            return []

        question_lower = question.lower()
        buy_terms = {'buy', 'buying', 'bought', 'purchase', 'purchased'}
        generic_terms = {
            'was', 'were', 'is', 'are', 'did', 'does', 'do', 'seen', 'client', 'from',
            'logs', 'log', 'the', 'and', 'for', 'with', 'that', 'this', 'there',
            'how', 'what', 'when', 'where', 'why', 'how', 'any', 'all', 'many',
            'event', 'events',
            'time', 'times', 'once', 'twice', 'number', 'count', 'total', 'give', 'me',
            'list', 'show', 'see', 'display', 'print', 'i', 'want', 'to', 'need', 'get', 'have',
            'please', 'can', 'could', 'would', 'should', 'must', 'of', 'on', 'in',
            'entry', 'entries', 'occurrence', 'occurrences', 'instance', 'instances',
            'latest', 'recent', 'newest', 'last', 'most', 'appear', 'appeared', 'appearing',
            'down', 'up', 'out', 'here', 'now', 'just', 'only', 'also', 'too', 'so', 'it', 'its',
            'he', 'she', 'they', 'him', 'her', 'them', 'his', 'hers', 'their', 'theirs',
            'my', 'your', 'our', 'you', 'we', 'us', 'activity', 'activities'
        }

        question_tokens = set(self._tokenize(question_lower))
        has_buy_intent = any(term in question_tokens for term in buy_terms)
        subject_tokens = [token for token in question_tokens if token not in buy_terms and token not in generic_terms]

        matched = []
        
        # If we have specific subject tokens, match strictly on them
        if subject_tokens:
            for entry in entries:
                content = str(entry.get('edited_content', '')).lower()
                if not content:
                    continue

                content_tokens = set(self._tokenize(content))
                content_has_buy = any(term in content_tokens for term in buy_terms)

                # Require ALL subject tokens to be present
                if not all(token in content_tokens for token in subject_tokens):
                    continue
                
                # If question implies a purchase action, also require purchase terms
                if has_buy_intent and not content_has_buy:
                    continue

                matched.append(entry)

                if max_items is not None and len(matched) >= max_items:
                    break
        else:
            # No specific subject tokens - fall back to loose question-token matching
            for entry in entries:
                content = str(entry.get('edited_content', '')).lower()
                if not content:
                    continue
                
                content_tokens = set(self._tokenize(content))
                content_has_buy = any(term in content_tokens for term in buy_terms)
                
                # If purchase intent, require purchase terms
                if has_buy_intent and not content_has_buy:
                    continue
                
                # Check for any meaningful overlap
                overlap = len(question_tokens & content_tokens)
                if overlap >= 2:
                    matched.append(entry)
                    
                    if max_items is not None and len(matched) >= max_items:
                        break

        return matched

    def _is_list_relevant_request(self, question: str) -> bool:
        question_lower = (question or '').lower()
        triggers = [
            'list',
            'all relevant',
            'show all',
            'show me all',
            'show all the',
            'all logs',
            'every instance',
            'all instance',
            'all occurrence',
            'all occurrences',
            'how many logs',
            'how many',
            'how often',
            'count',
            'how many times',
            'number of logs',
            'number of times',
            'latest entries',
            'latest entry',
            'recent entries',
            'recent entry',
            'most recent',
            'newest',
            'last entries',
            'all entries'
        ]
        return any(trigger in question_lower for trigger in triggers)

    def _has_explicit_subject_tokens(self, question: str) -> bool:
        """Return True when question includes specific subject tokens (e.g., person/entity names)."""
        question_tokens = set(self._tokenize((question or '').lower()))
        generic_terms = {
            'was', 'were', 'is', 'are', 'did', 'does', 'do', 'seen', 'client', 'from',
            'logs', 'log', 'the', 'and', 'for', 'with', 'that', 'this', 'there',
            'how', 'what', 'when', 'where', 'why', 'any', 'all', 'many',
            'event', 'events', 'time', 'times', 'once', 'twice', 'number', 'count',
            'total', 'give', 'me', 'show', 'see', 'display', 'print', 'i', 'want',
            'to', 'need', 'get', 'have', 'please', 'can', 'could', 'would', 'should',
            'must', 'of', 'on', 'in', 'entry', 'entries'
        }
        subject_tokens = [token for token in question_tokens if token not in generic_terms]
        return len(subject_tokens) > 0

    def _extract_all_entries_subject_tokens(self, question: str) -> list[str]:
        """Extract subject tokens for strict queries like 'list all entries of Kelvin'."""
        question_lower = (question or '').lower().strip()
        if not question_lower:
            return []

        patterns = [
            r"\b(?:list|show)\s+all\s+(?:entries|entry|logs|log|occurrences|occurrence)\s+(?:of|for|about)\s+(.+)$",
            r"\ball\s+(?:entries|entry|logs|log|occurrences|occurrence)\s+(?:of|for|about)\s+(.+)$",
            r"\bevery\s+(?:entry|log|occurrence)\s+(?:of|for|about)\s+(.+)$",
        ]

        generic_terms = {
            'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'from', 'with',
            'please', 'kindly', 'all', 'entries', 'entry', 'logs', 'log', 'occurrences', 'occurrence'
        }

        for pattern in patterns:
            match = re.search(pattern, question_lower)
            if not match:
                continue
            subject_phrase = match.group(1).strip()
            tokens = [
                token for token in self._tokenize(subject_phrase)
                if token not in generic_terms and len(token) >= 2
            ]
            return tokens

        return []

    def _extract_subject_tokens_for_list_query(self, question: str) -> list[str]:
        """Extract explicit subject tokens from list/all-logs style prompts.
        Handles variants like 'list all entries kelvin' where no preposition is used.
        """
        question_tokens = self._tokenize((question or '').lower())
        if not question_tokens:
            return []

        generic_terms = {
            'list', 'show', 'me', 'all', 'every', 'entries', 'entry', 'logs', 'log',
            'occurrence', 'occurrences', 'instance', 'instances',
            'relevant', 'related', 'for', 'of', 'about',
            'how', 'many', 'times', 'number', 'count',
            'please', 'can', 'could', 'would', 'should', 'need', 'want', 'get',
            'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'from', 'with',
            'was', 'were', 'is', 'are', 'did', 'does', 'do', 'seen', 'this', 'that', 'there',
            'what', 'when', 'where', 'why', 'any', 'event', 'events', 'time', 'once', 'twice',
            'total', 'give', 'see', 'display', 'print', 'i', 'have', 'must',
            'latest', 'recent', 'newest', 'last', 'most', 'appear', 'appeared', 'appearing',
            'down', 'up', 'out', 'here', 'now', 'just', 'only', 'also', 'too', 'so', 'it', 'its',
            'he', 'she', 'they', 'him', 'her', 'them', 'his', 'hers', 'their', 'theirs',
            'my', 'your', 'our', 'you', 'we', 'us', 'activity', 'activities'
        }

        return [
            token for token in question_tokens
            if token not in generic_terms and len(token) >= 2
        ]

    def _entry_search_haystack(self, entry: dict) -> str:
        return " ".join(
            [
                str(entry.get('filename', '')),
                str(entry.get('edited_content', '')),
                str(entry.get('content', '')),
                str(entry.get('channel_name', '')),
                str(entry.get('speaker', '')),
            ]
        ).lower()

    def _wants_all_matches(self, question: str) -> bool:
        """Detect user intent to retrieve all matching logs instead of top-k sample."""
        question_lower = (question or '').lower()
        if not question_lower:
            return False

        broad_patterns = [
            r"\bshow\s+me\s+all\b",
            r"\bshow\s+all\b",
            r"\blist\s+all\b",
            r"\ball\s+the\b",
            r"\bevery\b",
            r"\ball\s+events?\b",
            r"\ball\s+times?\b",
        ]
        return any(re.search(pattern, question_lower) for pattern in broad_patterns)

    def _format_relevant_log_list(self, entries: list[dict], question: str) -> str:
        question_lower = (question or '').lower()
        
        # For "how many" questions, lead with the count
        if any(trigger in question_lower for trigger in ['how many', 'count', 'number of']):
            lines = [f"Found {len(entries)} matching logs:\n"]
        else:
            lines = [f"Found {len(entries)} relevant logs:"]
        
        for idx, entry in enumerate(entries, start=1):
            filename = str(entry.get('filename', ''))
            processed_at = str(entry.get('processed_at', ''))
            content = str(entry.get('edited_content', '')).strip()
            evidence_line = self._extract_best_evidence_line(question, content)
            lines.append(f"{idx}. [{filename}] {processed_at} - {evidence_line}")
        return "\n".join(lines)

    def _extract_best_evidence_line(self, question: str, content: str) -> str:
        if not content:
            return ""

        split_lines = [
            part.strip()
            for part in re.split(r"(?:\r?\n|(?<=[.!?])\s+|;\s+)", content)
            if part.strip()
        ]
        if not split_lines:
            return content.strip()

        question_tokens = set(self._tokenize(question))
        best_line = split_lines[0]
        best_score = -1

        for line in split_lines:
            line_tokens = set(self._tokenize(line))
            score = len(question_tokens & line_tokens)
            if score > best_score:
                best_score = score
                best_line = line

        if len(best_line) <= 360:
            return best_line

        # Some imported reports are one very long paragraph. Return the part
        # around the strongest question keyword instead of the whole paragraph.
        meaningful_tokens = [token for token in question_tokens if len(token) >= 3]
        lower_line = best_line.lower()
        match_positions = [lower_line.find(token.lower()) for token in meaningful_tokens]
        match_positions = [position for position in match_positions if position >= 0]
        if not match_positions:
            return best_line[:360].rstrip() + "..."
        center = min(match_positions)
        start = max(0, center - 140)
        end = min(len(best_line), center + 260)
        excerpt = best_line[start:end].strip()
        if start > 0:
            excerpt = "..." + excerpt
        if end < len(best_line):
            excerpt += "..."
        return excerpt

    def _format_direct_evidence_answer(self, question: str, entry: dict) -> str:
        """Answer direct Key SO fact questions from the matching entry only."""
        content = str(entry.get('edited_content', '') or '')
        relevant_line = self._extract_best_evidence_line(question, content)
        if not relevant_line:
            return "Cannot confirm from the logs."

        question_lower = str(question or '').lower()
        timestamp = str(entry.get('processed_at', '') or '').strip()
        event_time = self._parse_processed_at(timestamp)
        is_time_question = bool(re.search(r'\b(?:what\s+time|at\s+what\s+time|time\s+did)\b', question_lower))
        is_date_question = bool(re.search(r'\b(?:what\s+date|which\s+date|date\s+did)\b', question_lower))
        is_when_question = bool(re.search(r'\bwhen\b', question_lower))
        answer_line = relevant_line.rstrip(".?! ")
        if event_time and (is_time_question or is_date_question or is_when_question):
            date_label = f"{event_time.day} {event_time.strftime('%B %Y')}"
            time_label = event_time.strftime("%H:%M:%S")
            if is_time_question:
                return f"{answer_line} at {time_label} on {date_label}."
            if is_date_question:
                return f"{answer_line} on {date_label} at {time_label}."
            return f"{answer_line} on {date_label} at {time_label}."

        filename = str(entry.get('filename', '') or '')
        return f"Confirmed from logs. Evidence in {filename}: {relevant_line}"

    def _extract_vehicle_numbers_for_question(self, question: str, content: str) -> list[str]:
        """Return concise vehicle identifiers for vehicle-number questions."""
        question_lower = str(question or '').lower()
        if not re.search(r'\b(?:car|vehicle|registration|plate)\b', question_lower):
            return []
        text = str(content or '')
        candidates = []
        patterns = [
            r'\b[A-Z]{1,3}\s*\d{1,4}\s*[A-Z]\b',
            r'\b[A-Z]{1,3}\s*\d{1,4}\b',
        ]
        for pattern in patterns:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                value = re.sub(r'\s+', '', match.group(0)).upper()
                if value not in candidates:
                    candidates.append(value)
        return candidates[:10]

    def _find_best_matching_log(self, question: str, entries: list[dict]) -> Optional[dict]:
        """Find the best matching log entry for yes/no questions."""
        if not entries:
            return None
        
        # Extract key terms from question (excluding common words)
        stopwords = {
            'did', 'does', 'do', 'is', 'are', 'was', 'were', 'the', 'a', 'an',
            'to', 'of', 'in', 'on', 'for', 'from', 'and', 'or', 'client', 'logs',
            'subject', 'go', 'went', 'at', 'what', 'when', 'where', 'who', 'how', 'why'
        }
        question_tokens = [
            token for token in self._tokenize(question.lower())
            if token not in stopwords and len(token) >= 3
        ]
        
        if not question_tokens:
            return entries[0]  # Fallback to first entry if no meaningful tokens
        
        # Find the entry that contains the most question keywords
        best_match = None
        best_score = 0
        
        for entry in entries:
            content_lower = str(entry.get('edited_content', '')).lower()
            score = sum(1 for token in question_tokens if token in content_lower)
            
            if score > best_score:
                best_score = score
                best_match = entry
        
        return best_match if best_score > 0 else None

    def _find_explicit_evidence(self, question: str, entries: list[dict]) -> Optional[dict]:
        """Find explicit supporting text in selected logs for direct fact questions."""
        question_lower = (question or "").lower()

        # Extract meaningful question tokens (exclude generic words)
        stopwords = {
            'did', 'does', 'do', 'is', 'are', 'was', 'were', 'the', 'a', 'an',
            'to', 'of', 'in', 'on', 'for', 'from', 'and', 'or', 'client', 'logs',
            'buy', 'buying', 'bought', 'purchase', 'purchased', 'what', 'when',
            'where', 'who', 'how', 'why', 'subject', 'go', 'went', 'at'
        }
        question_tokens = [
            token for token in self._tokenize(question_lower)
            if token not in stopwords and len(token) >= 3
        ]

        # Check if question is about purchasing
        wants_purchase = any(term in question_lower for term in ['buy', 'bought', 'purchase', 'purchased', 'buying'])

        if not question_tokens:
            return None  # No meaningful tokens to match

        for entry in entries:
            content = str(entry.get('edited_content', '')).strip()
            content_lower = content.lower()

            # MUST have purchase terms if question asks about buying
            if wants_purchase and not any(term in content_lower for term in ['buy', 'bought', 'purchase', 'purchased', 'buying']):
                continue

            # ALL significant question tokens must appear in content (strict matching)
            if not all(token in content_lower for token in question_tokens):
                continue

            if content:
                return {
                    'filename': str(entry.get('filename', '')),
                    'content': content
                }

        return None

    def _tokenize(self, text: str) -> list[str]:
        normalized = re.sub(r"[_:\-\/\[\]\(\),.]", " ", text.lower())
        tokens = [token for token in re.findall(r"[a-z0-9]+", normalized) if len(token) >= 2]
        # Apply lemmatization to handle verb forms
        return [self._lemmatize(token) for token in tokens]
    
    def _lemmatize(self, word: str) -> str:
        """Simple lemmatization for common word forms"""
        # Comprehensive verb forms mapping to base form
        verb_forms = {
            # be
            'am': 'be', 'is': 'be', 'are': 'be', 'was': 'be', 'were': 'be', 'been': 'be', 'being': 'be',
            # have
            'has': 'have', 'had': 'have', 'having': 'have',
            # do
            'does': 'do', 'did': 'do', 'doing': 'do',
            # go
            'goes': 'go', 'went': 'go', 'going': 'go', 'gone': 'go',
            # make
            'makes': 'make', 'made': 'make', 'making': 'make',
            # take
            'takes': 'take', 'took': 'take', 'taking': 'take', 'taken': 'take',
            # come
            'comes': 'come', 'came': 'come', 'coming': 'come',
            # see
            'sees': 'see', 'saw': 'see', 'seen': 'see', 'seeing': 'see',
            # know
            'knows': 'know', 'knew': 'know', 'known': 'know', 'knowing': 'know',
            # think
            'thinks': 'think', 'thought': 'think', 'thinking': 'think',
            # get
            'gets': 'get', 'got': 'get', 'getting': 'get', 'gotten': 'get',
            # use
            'uses': 'use', 'used': 'use', 'using': 'use',
            # find
            'finds': 'find', 'found': 'find', 'finding': 'find',
            # give
            'gives': 'give', 'gave': 'give', 'giving': 'give', 'given': 'give',
            # tell
            'tells': 'tell', 'told': 'tell', 'telling': 'tell',
            # work
            'works': 'work', 'worked': 'work', 'working': 'work',
            # call
            'calls': 'call', 'called': 'call', 'calling': 'call',
            # ask
            'asks': 'ask', 'asked': 'ask', 'asking': 'ask',
            # try
            'tries': 'try', 'tried': 'try', 'trying': 'try',
            # leave
            'leaves': 'leave', 'left': 'leave', 'leaving': 'leave',
            # put
            'puts': 'put', 'putting': 'put',
            # say
            'says': 'say', 'said': 'say', 'saying': 'say',
            # show
            'shows': 'show', 'showed': 'show', 'showing': 'show', 'shown': 'show',
            # hear
            'hears': 'hear', 'heard': 'hear', 'hearing': 'hear',
            # let
            'lets': 'let', 'letting': 'let',
            # mean
            'means': 'mean', 'meant': 'mean', 'meaning': 'mean',
            # set
            'sets': 'set', 'setting': 'set',
            # meet
            'meets': 'meet', 'met': 'meet', 'meeting': 'meet',
            # run
            'runs': 'run', 'ran': 'run', 'running': 'run',
            # pay
            'pays': 'pay', 'paid': 'pay', 'paying': 'pay',
            # sit
            'sits': 'sit', 'sat': 'sit', 'sitting': 'sit',
            # stand
            'stands': 'stand', 'stood': 'stand', 'standing': 'stand',
            # lose
            'loses': 'lose', 'lost': 'lose', 'losing': 'lose',
            # fall
            'falls': 'fall', 'fell': 'fall', 'falling': 'fall', 'fallen': 'fall',
            # cut
            'cuts': 'cut', 'cutting': 'cut',
            # read
            'reads': 'read', 'reading': 'read',
            # allow
            'allows': 'allow', 'allowed': 'allow', 'allowing': 'allow',
            # add
            'adds': 'add', 'added': 'add', 'adding': 'add',
            # spend
            'spends': 'spend', 'spent': 'spend', 'spending': 'spend',
            # grow
            'grows': 'grow', 'grew': 'grow', 'growing': 'grow', 'grown': 'grow',
            # open
            'opens': 'open', 'opened': 'open', 'opening': 'open',
            # walk
            'walks': 'walk', 'walked': 'walk', 'walking': 'walk',
            # win
            'wins': 'win', 'won': 'win', 'winning': 'win',
            # offer
            'offers': 'offer', 'offered': 'offer', 'offering': 'offer',
            # remember
            'remembers': 'remember', 'remembered': 'remember', 'remembering': 'remember',
            # love
            'loves': 'love', 'loved': 'love', 'loving': 'love',
            # consider
            'considers': 'consider', 'considered': 'consider', 'considering': 'consider',
            # appear
            'appears': 'appear', 'appeared': 'appear', 'appearing': 'appear',
            # buy
            'buys': 'buy', 'bought': 'buy', 'buying': 'buy',
            # wait
            'waits': 'wait', 'waited': 'wait', 'waiting': 'wait',
            # serve
            'serves': 'serve', 'served': 'serve', 'serving': 'serve',
            # die
            'dies': 'die', 'died': 'die', 'dying': 'die', 'dead': 'die',
            # send
            'sends': 'send', 'sent': 'send', 'sending': 'send',
            # expect
            'expects': 'expect', 'expected': 'expect', 'expecting': 'expect',
            # build
            'builds': 'build', 'built': 'build', 'building': 'build',
            # stay
            'stays': 'stay', 'stayed': 'stay', 'staying': 'stay',
            # reach
            'reaches': 'reach', 'reached': 'reach', 'reaching': 'reach',
            # kill
            'kills': 'kill', 'killed': 'kill', 'killing': 'kill',
            # remain
            'remains': 'remain', 'remained': 'remain', 'remaining': 'remain',
            # suggest
            'suggests': 'suggest', 'suggested': 'suggest', 'suggesting': 'suggest',
            # raise
            'raises': 'raise', 'raised': 'raise', 'raising': 'raise',
            # agree
            'agrees': 'agree', 'agreed': 'agree', 'agreeing': 'agree',
            # seek
            'seeks': 'seek', 'sought': 'seek', 'seeking': 'seek',
            # explain
            'explains': 'explain', 'explained': 'explain', 'explaining': 'explain',
            # develop
            'develops': 'develop', 'developed': 'develop', 'developing': 'develop',
            # produce
            'produces': 'produce', 'produced': 'produce', 'producing': 'produce',
            # speak
            'speaks': 'speak', 'spoke': 'speak', 'speaking': 'speak', 'spoken': 'speak',
            # perform
            'performs': 'perform', 'performed': 'perform', 'performing': 'perform',
            # change
            'changes': 'change', 'changed': 'change', 'changing': 'change',
            # lead
            'leads': 'lead', 'led': 'lead', 'leading': 'lead',
            # understand
            'understands': 'understand', 'understood': 'understand', 'understanding': 'understand',
            # watch
            'watches': 'watch', 'watched': 'watch', 'watching': 'watch',
            # follow
            'follows': 'follow', 'followed': 'follow', 'following': 'follow',
            # stop
            'stops': 'stop', 'stopped': 'stop', 'stopping': 'stop',
            # create
            'creates': 'create', 'created': 'create', 'creating': 'create',
            # sell
            'sells': 'sell', 'sold': 'sell', 'selling': 'sell',
            # send
            'sends': 'send', 'sent': 'send', 'sending': 'send',
            # bring
            'brings': 'bring', 'brought': 'bring', 'bringing': 'bring',
            # begin
            'begins': 'begin', 'began': 'begin', 'beginning': 'begin', 'begun': 'begin',
            # end
            'ends': 'end', 'ended': 'end', 'ending': 'end',
            # happen
            'happens': 'happen', 'happened': 'happen', 'happening': 'happen',
            # include
            'includes': 'include', 'included': 'include', 'including': 'include',
            # continue
            'continues': 'continue', 'continued': 'continue', 'continuing': 'continue',
            # provide
            'provides': 'provide', 'provided': 'provide', 'providing': 'provide',
            # enter
            'enters': 'enter', 'entered': 'enter', 'entering': 'enter',
            # receive
            'receives': 'receive', 'received': 'receive', 'receiving': 'receive',
            # require
            'requires': 'require', 'required': 'require', 'requiring': 'require',
            # release
            'releases': 'release', 'released': 'release', 'releasing': 'release',
            # achieve
            'achieves': 'achieve', 'achieved': 'achieve', 'achieving': 'achieve',
            # present
            'presents': 'present', 'presented': 'present', 'presenting': 'present',
            # measure
            'measures': 'measure', 'measured': 'measure', 'measuring': 'measure',
            # claim
            'claims': 'claim', 'claimed': 'claim', 'claiming': 'claim',
            # obtain
            'obtains': 'obtain', 'obtained': 'obtain', 'obtaining': 'obtain',
        }
        return verb_forms.get(word, word)

    def _build_retrieval_text(self, entry: dict) -> str:
        filename = str(entry.get("filename", ""))
        processed_at = str(entry.get("processed_at", ""))
        content = str(entry.get("edited_content", ""))
        original_content = str(entry.get("original_content", ""))
        return f"{filename} {processed_at} {content} {original_content}".lower()

    def _bm25_score(
        self,
        query_terms: set[str],
        doc_tf: Counter,
        doc_len: int,
        avg_doc_len: float,
        doc_freq: dict[str, int],
        total_docs: int,
    ) -> float:
        if not query_terms or doc_len <= 0 or avg_doc_len <= 0 or total_docs <= 0:
            return 0.0

        k1 = 1.5
        b = 0.75
        score = 0.0

        for term in query_terms:
            tf = doc_tf.get(term, 0)
            if tf <= 0:
                continue

            df = doc_freq.get(term, 0)
            idf = math.log(1.0 + (total_docs - df + 0.5) / (df + 0.5))
            denom = tf + k1 * (1.0 - b + b * (doc_len / avg_doc_len))
            if denom > 0:
                score += idf * ((tf * (k1 + 1.0)) / denom)

        return score

    def _metadata_boost(self, question_lowered: str, entry: dict) -> float:
        boost = 0.0
        filename = str(entry.get("filename", "")).lower()
        processed_at = str(entry.get("processed_at", "")).lower()

        question_tokens = set(self._tokenize(question_lowered))
        filename_tokens = set(self._tokenize(filename))
        processed_tokens = set(self._tokenize(processed_at))

        if filename and filename in question_lowered:
            boost += 2.0
        if processed_at and processed_at in question_lowered:
            boost += 2.0

        if question_tokens:
            filename_overlap = len(question_tokens & filename_tokens)
            processed_overlap = len(question_tokens & processed_tokens)
            boost += 0.8 * filename_overlap
            boost += 0.8 * processed_overlap

        numeric_parts = re.findall(r"\d{4,}", question_lowered)
        if numeric_parts:
            combined_meta = f"{filename} {processed_at}"
            matches = sum(1 for part in numeric_parts if part in combined_meta)
            boost += 0.5 * matches

        return boost

    def _build_retrieval_signature(self, log_entries: list[dict]):
        signature_parts = [str(len(log_entries))]
        for entry in log_entries:
            text_digest = hashlib.blake2b(
                str(entry.get('edited_content', '')).encode('utf-8', errors='ignore'),
                digest_size=8,
            ).hexdigest()
            signature_parts.append(
                f"{entry.get('id', '')}|{entry.get('filename', '')}|{entry.get('processed_at', '')}|{text_digest}"
            )
        return tuple(signature_parts)

    def _prepare_retrieval_index(self, log_entries: list[dict]):
        signature = self._build_retrieval_signature(log_entries)
        if signature == self._retrieval_cache_signature:
            return

        docs = []
        doc_freq = {}
        total_len = 0

        for entry in log_entries:
            doc_text = self._build_retrieval_text(entry)
            terms = self._tokenize(doc_text)
            tf = Counter(terms)
            term_set = set(terms)

            docs.append({
                "entry": entry,
                "text": doc_text,
                "tf": tf,
                "term_set": term_set,
                "length": len(terms),
            })
            total_len += len(terms)

            for term in term_set:
                doc_freq[term] = doc_freq.get(term, 0) + 1

        total_docs = len(docs)
        self._retrieval_cache_signature = signature
        self._retrieval_docs = docs
        self._retrieval_doc_freq = doc_freq
        self._retrieval_total_docs = total_docs
        self._retrieval_avg_doc_len = (total_len / total_docs) if total_docs else 1.0

    def _retrieve_relevant_logs(self, question: str, log_entries: list[dict], top_k: int) -> list[dict]:
        top_k = max(top_k, 1)
        # Use all logs in the selected date range for retrieval ranking.
        candidates = log_entries
        if not candidates:
            return []

        question_lowered = question.lower().strip()
        query_terms = set(self._tokenize(question_lowered))
        if not query_terms:
            return candidates[:top_k]

        self._prepare_retrieval_index(candidates)
        docs = self._retrieval_docs
        doc_freq = self._retrieval_doc_freq
        total_docs = self._retrieval_total_docs
        avg_doc_len = self._retrieval_avg_doc_len

        scored = []
        for doc in docs:
            overlap_count = len(query_terms & doc["term_set"])
            overlap_ratio = overlap_count / len(query_terms)

            bm25 = self._bm25_score(
                query_terms=query_terms,
                doc_tf=doc["tf"],
                doc_len=doc["length"],
                avg_doc_len=avg_doc_len,
                doc_freq=doc_freq,
                total_docs=total_docs,
            )

            phrase_boost = 0.0
            if len(question_lowered) >= 12 and question_lowered in doc["text"]:
                phrase_boost = 2.0

            metadata_boost = self._metadata_boost(question_lowered, doc["entry"])
            hybrid_score = bm25 + (overlap_ratio * 2.0) + phrase_boost + metadata_boost

            if overlap_count == 0 and metadata_boost < 1.2 and phrase_boost <= 0:
                continue

            if hybrid_score > 0:
                scored.append((hybrid_score, doc["entry"]))

        if not scored:
            return candidates[:top_k]

        scored.sort(key=lambda item: item[0], reverse=True)
        return [entry for _, entry in scored[:top_k]]

    def _generate(self, system_prompt: str, user_prompt: str, max_tokens: Optional[int] = None,
                  temperature: Optional[float] = None) -> str:
        if max_tokens is None:
            max_tokens = int(config.get("ai_max_tokens", 512))
        if temperature is None:
            temperature = float(config.get("ai_temperature", 0.3))
        else:
            temperature = float(temperature)

        try:
            if hasattr(self.model, "chat_session"):
                with self.model.chat_session(system_prompt=system_prompt):
                    output = self.model.generate(
                        prompt=user_prompt,
                        max_tokens=max_tokens,
                        temp=temperature,
                    )
            else:
                combined_prompt = f"System: {system_prompt}\n\nUser: {user_prompt}\nAssistant:"
                output = self.model.generate(
                    prompt=combined_prompt,
                    max_tokens=max_tokens,
                    temp=temperature,
                )

            return (output or "").strip() or "No response generated by model."
        except Exception as exc:
            self._last_error = f"Generation error: {exc}"
            return f"Generation error: {exc}"

    def get_diagnostics(self) -> str:
        model_name, model_path, preferred_device = self._resolve_model_settings()
        lines = [
            f"Configured model name: {model_name or '(not set)'}",
            f"Configured model path: {model_path or '(default GPT4All models path)'}",
            f"Configured device preference: {preferred_device.upper()}",
            f"Current loaded device: {self._last_device.upper() if self.model is not None else '(not loaded)'}",
            f"Package import status: {'OK' if self._gpt4all_cls is not None else 'FAILED'}",
            f"Model load status: {self.get_status()}",
        ]

        # Add GPU diagnostics if available
        if self._last_device.lower() == 'gpu':
            gpu_stats = self._get_gpu_stats()
            if gpu_stats:
                lines.append("")
                lines.append("GPU Diagnostics:")
                lines.extend(gpu_stats)

        if self._last_error:
            lines.append(f"Last error: {self._last_error}")

        return "\n".join(lines)

    def _get_gpu_stats(self) -> list[str]:
        """Get NVIDIA GPU statistics"""
        if not self._gpu_available or not self._pynvml:
            return []

        try:
            stats = []
            device_count = self._pynvml.nvmlDeviceGetCount()
            
            for i in range(device_count):
                handle = self._pynvml.nvmlDeviceGetHandleByIndex(i)
                
                # GPU name
                gpu_name = self._pynvml.nvmlDeviceGetName(handle).decode('utf-8')
                stats.append(f"  GPU {i}: {gpu_name}")
                
                # Memory info
                mem_info = self._pynvml.nvmlDeviceGetMemoryInfo(handle)
                total_mem_mb = mem_info.total / (1024 ** 2)
                used_mem_mb = mem_info.used / (1024 ** 2)
                mem_percent = (mem_info.used / mem_info.total) * 100
                stats.append(f"    Memory: {used_mem_mb:.0f}MB / {total_mem_mb:.0f}MB ({mem_percent:.1f}%)")
                
                # Utilization
                try:
                    util = self._pynvml.nvmlDeviceGetUtilizationRates(handle)
                    stats.append(f"    GPU Utilization: {util.gpu}%")
                    stats.append(f"    Memory Utilization: {util.memory}%")
                except Exception:
                    pass
                
                # Temperature
                try:
                    temp = self._pynvml.nvmlDeviceGetTemperature(handle, 0)
                    stats.append(f"    Temperature: {temp}°C")
                except Exception:
                    pass
                
                # Power usage
                try:
                    power_mw = self._pynvml.nvmlDeviceGetPowerUsage(handle)
                    power_w = power_mw / 1000
                    stats.append(f"    Power Usage: {power_w:.1f}W")
                except Exception:
                    pass
            
            return stats
        except Exception:
            return []

    def reset_model(self):
        self.model = None
        self._load_error = None
        self._last_error = None
        self._last_device = "cpu"
