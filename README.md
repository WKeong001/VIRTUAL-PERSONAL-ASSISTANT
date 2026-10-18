# Ops Transcriber

Windows application for transcribing radio audio and generating operational reports.

## Download and run

### 1. Download the project

1. Open the project page on GitHub.
2. Select **Code** > **Download ZIP**.
3. Extract the downloaded ZIP file to a folder on the computer, such as `Documents`.

Do not run the application directly from inside the ZIP file.

### 2. Install the required software

Install these once on the workstation:

- [Python](https://www.python.org/downloads/windows/) 3.10, 3.11, or 3.12. During installation, select **Add Python to PATH**.
- [Node.js](https://nodejs.org/) 18 or newer. The current LTS version is recommended.

### 3. Start Ops Transcriber

1. Open the extracted project folder.
2. Open the `Ops Transcriber` folder.
3. Double-click [`run-ops-transcriber.bat`](./Ops%20Transcriber/run-ops-transcriber.bat).

The first launch performs setup automatically:

- creates the local Python environment;
- installs the required Python and Node.js packages; and
- downloads the AI model from the latest GitHub Release.

When setup completes, the application opens automatically in the default browser at:

```text
http://127.0.0.1:3011
```

Keep the command windows open while using the application. Close them when finished.

## First-run requirements

- Internet access is required for the first setup and model download.
- The AI model download is about 1.83 GB. Ensure the computer has at least 8 GB of free disk space.
- The application works on CPU-only Windows computers. An NVIDIA GPU is optional and improves performance.

## If setup does not complete

- Confirm that Python and Node.js are installed, then close and run `run-ops-transcriber.bat` again.
- If the setup reports that the AI model is not in the latest GitHub Release, contact the project owner.
- If Windows displays a security warning for the downloaded ZIP, select **More info** and then **Run anyway** only if you downloaded it from the official project GitHub page.
