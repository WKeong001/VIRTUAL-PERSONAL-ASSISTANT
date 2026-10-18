# Ops Transcriber

Windows application for transcribing radio audio, managing operational
occurrences, generating reports, and answering questions from local documents
and images.

## Download and run

### 1. Download the project

1. Open the project page on GitHub.
2. Select **Code** > **Download ZIP**.
3. Extract the downloaded ZIP file to a folder on the computer, such as `Documents`.

Do not run the application directly from inside the ZIP file.

### 2. Install required software

Install these once on the workstation:

- [Python](https://www.python.org/downloads/windows/) 3.10, 3.11, or 3.12. During installation, select **Add Python to PATH**.
- [Node.js](https://nodejs.org/) 18 or newer. The current LTS version is recommended.

For offline image, map, floor-plan, and diagram Q&A, also install:

- [Ollama for Windows](https://ollama.com/download/windows)

Ollama is optional when only transcription, reporting, and text-document Q&A
are required. It is required for image analysis.

### 3. Start The Virtual Personal Assistance

1. Open the extracted project folder.
2. Open the `Ops Transcriber` folder.
3. Double-click [`run-ops-transcriber.bat`](./Ops%20Transcriber/run-ops-transcriber.bat).

The first launch performs setup automatically:

- creates the local Python environment;
- installs the required Python and Node.js packages; and
- downloads the main local GPT4All/Llama model from the latest GitHub Release.

If Ollama is installed, the launcher also checks for the local
`qwen2.5vl:3b` vision model. If it is missing, it downloads it automatically.
This happens once; later launches reuse the locally stored model.

When setup completes, the application opens automatically in the default browser at:

```text
http://127.0.0.1:3011
```

Keep the command windows open while using the application. Close them when finished.

## First-run requirements

- Internet access is required for the first setup and model download.
- The main text model download is about 1.83 GB.
- The optional Qwen vision model download is about 3.2 GB.
- Ensure at least 12 GB of free disk space when using both text and vision models.
- The application works on CPU-only Windows computers. An NVIDIA GPU is optional and improves performance.

## Offline document and image Q&A

In **AI Chatbot**, select **Chat (offline)** to display the **Chat knowledge
base**. It is separate from the transcript-log and Key Occurrences modes.

### Supported knowledge sources

| Source type | Supported files | Local model used |
|---|---|---|
| Text documents | `.pdf`, `.doc`, `.docx`, `.txt`, `.md`, `.csv`, `.json` | GPT4All/Llama |
| Images and diagrams | `.png`, `.jpg`, `.jpeg`, `.webp` | Qwen2.5-VL through Ollama |

To use the feature:

1. Select **Chat (offline)**.
2. Choose one or more knowledge files and select **Ingest files**.
3. Tick the sources to use for the question.
4. Enter a question and select **Ask**.

For text sources, the application retrieves relevant extracts before asking the
local model. For selected images, the local Qwen vision model analyses the
image and returns a concise answer with visible evidence where available.

The application accepts up to 10 files per upload action, with a maximum size
of 15 MB per file. Uploaded source files and extracted text are retained
locally until removed from the Chat knowledge base.

### Local processing and model selection

The application automatically chooses the appropriate local model:

| Question context | Model |
|---|---|
| Normal offline chat or selected text documents | GPT4All/Llama |
| One or more selected images, maps, photos, or diagrams | Qwen2.5-VL through Ollama |
| Selected images with relevant text documents | Qwen2.5-VL receives both the image and relevant text extracts |

No uploaded document, image, or question is intentionally sent to a cloud AI
service. Internet access is needed only to install dependencies and download
models during initial setup.

### Qwen vision model

After Ollama is installed, [`run-ops-transcriber.bat`](./Ops%20Transcriber/run-ops-transcriber.bat)
automatically runs the equivalent of:

```text
ollama pull qwen2.5vl:3b
```

Do not add Ollama model files to this repository. Ollama manages them in the
user's local model storage.

The configuration in [`config.json`](./Ops%20Transcriber/config.json) is:

```json
"ai_vision_url": "http://127.0.0.1:11434",
"ai_vision_model": "qwen2.5vl:3b"
```

Ollama supplies the required local OpenAI-compatible `/v1/chat/completions`
endpoint.

### Important safety note

Answers from AI models can be incorrect, especially when diagrams have small
text, unclear symbols, missing legends, or ambiguous routes. Use the feature
as an assistance tool and verify safety-critical, operational, or evacuation
information against approved documents and authorised personnel.

## If setup does not complete

- Confirm that Python and Node.js are installed, then close and run `run-ops-transcriber.bat` again.
- For image Q&A, confirm that Ollama is installed and running. The launcher
  downloads `qwen2.5vl:3b` automatically when Ollama is available.
- If the Qwen download fails, run `ollama pull qwen2.5vl:3b` in PowerShell,
  then start Ops Transcriber again.
- If the setup reports that the AI model is not in the latest GitHub Release, contact the project owner.
- If Windows displays a security warning for the downloaded ZIP, select **More info** and then **Run anyway** only if you downloaded it from the official project GitHub page.
